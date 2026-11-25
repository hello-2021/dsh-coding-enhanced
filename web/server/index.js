/**
 * dsh-coding-enhanced-web — standalone review server.
 *
 * Scope of this file:
 *   - SQLite schema (node:sqlite) for users, user keys, sessions, devices,
 *     pairing codes, review snapshots and audit;
 *   - username + user key registration/login (key-auth.js);
 *   - one-time pairing code -> device token;
 *   - /ws/device: plugin outbound WSS, receives review.snapshot/update/result;
 *   - /ws/browser: session cookie, receives snapshots and sends
 *     decision / line.request to the paired device;
 *   - REST for health, auth, devices, pairing, review list/detail.
 *
 * Run: node server/index.js --port 4317 --host 127.0.0.1 --data ~/.dsh-coding-enhanced-web
 * Dev: start with ORIGIN=http://localhost:5173 for the Vite UI.
 */

import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { WebSocketServer, WebSocket } from 'ws'
import { registerKeyAuth } from './key-auth.js'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')
const distDir = join(here, '..', 'dist')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}

const port = Number(arg('port', process.env.PORT ?? 4317))
const host = arg('host', process.env.HOST ?? '127.0.0.1')
const dataDir = resolve(arg('data', process.env.DATA_DIR ?? join(homedir(), '.dsh-coding-enhanced-web')))
const origin = arg('origin', process.env.ORIGIN ?? `http://localhost:${port}`)
const secureCookie = origin.startsWith('https://')

mkdirSync(dataDir, { recursive: true })
const db = new DatabaseSync(join(dataDir, 'web.sqlite'))
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  plugin_version TEXT,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_device ON reviews(device_id);
CREATE INDEX IF NOT EXISTS idx_reviews_updated ON reviews(updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_review ON chat_messages(review_id, id);
`)

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(Date.now())

const now = () => Date.now()
const newId = (prefix) => `${prefix}-${randomBytes(12).toString('base64url')}`
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const fromJson = (value, fallback) => {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const compactReview = (payload) => {
  if (payload === null || typeof payload !== 'object') return null
  return {
    id: payload.id,
    title: payload.title ?? payload.name ?? payload.id,
    sessionId: payload.sessionId,
    submitted: payload.submitted === true,
    finished: payload.finished === true,
    canceled: payload.canceled === true,
    entries: (Array.isArray(payload.entries) ? payload.entries : []).slice(0, 20).map((entry) => ({
      display: entry.display,
      tool: entry.tool,
      isNew: entry.isNew,
      added: entry.added,
      removed: entry.removed,
      warning: entry.warning,
      notes: entry.notes,
      hunks: Array.isArray(entry.hunks) ? entry.hunks.slice(0, 20) : [],
    })),
  }
}

const reviewCatalogFor = (userId) => {
  const rows = db.prepare('SELECT r.payload FROM reviews r JOIN devices d ON d.id = r.device_id WHERE d.user_id = ? ORDER BY r.updated_at DESC LIMIT 50').all(userId)
  return rows.map((row) => compactReview(fromJson(row.payload, null))).filter((review) => review !== null)
}

const sessionCookie = 'ce_session'
const sessionTtl = 30 * 24 * 60 * 60 * 1000
const pairingTtl = 10 * 60 * 1000
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const newCode = () => Array.from({ length: 8 }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join('')

const audit = (actor, action, detail = '') => {
  try {
    db.prepare('INSERT INTO audit (id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)').run(newId('audit'), now(), actor, action, String(detail).slice(0, 500))
  } catch {
    // Audit must never break the request path.
  }
}

const hits = new Map()
const rateLimit = (key, max, windowMs = 60_000) => {
  const time = now()
  const list = (hits.get(key) ?? []).filter((item) => time - item < windowMs)
  if (list.length >= max) {
    hits.set(key, list)
    return false
  }
  list.push(time)
  hits.set(key, list)
  return true
}

const deviceSockets = new Map()
const browserSockets = new Set()

const createSession = (userId) => {
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now() + sessionTtl, now())
  return token
}

const userFromToken = (token) => {
  if (!token) return undefined
  const row = db.prepare('SELECT s.user_id AS id, s.expires_at AS expiresAt, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(sha256(token))
  if (!row || row.expiresAt < now()) return undefined
  return { id: row.id, username: row.username }
}

const userFromRequest = (request) => userFromToken(request.cookies?.[sessionCookie])

const setSessionCookie = (reply, token) => {
  reply.setCookie(sessionCookie, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie,
    maxAge: Math.floor(sessionTtl / 1000),
  })
}

const serializeDevice = (row) => ({
  id: row.id,
  name: row.name,
  instanceId: row.instance_id,
  pluginVersion: row.plugin_version,
  pairedAt: row.paired_at,
  lastSeen: row.last_seen,
  revokedAt: row.revoked_at,
  online: deviceSockets.has(row.id),
})

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 2 * 1024 * 1024,
})
await app.register(cookie)

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Referrer-Policy', 'no-referrer')
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:")
  return payload
})

const fail = (reply, statusCode, message) => reply.code(statusCode).send({ error: message })
const bearer = (request) => {
  const header = request.headers.authorization
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
}
const parseCookies = (header) => {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key === '') continue
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}
const rejectSocket = (socket, status) => {
  try {
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\n\r\n`)
  } finally {
    socket.destroy()
  }
}
const send = (ws, value) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value))
}
const broadcastBrowsers = (userId, value) => {
  for (const ws of browserSockets) {
    if (ws.user?.id === userId) send(ws, value)
  }
}
const broadcastDeviceStatus = (userId, deviceId, online) => {
  for (const ws of browserSockets) {
    if (ws.user?.id === userId) send(ws, { type: 'device.status', deviceId, online, lastSeen: now() })
  }
}

registerKeyAuth(app, { db, sha256, newId, createSession, setSessionCookie, audit, rateLimit, fail })

app.get('/api/health', async () => ({
  ok: true,
  name: 'dsh-coding-enhanced-web',
  version: '0.1.0',
  origin,
  onlineDevices: deviceSockets.size,
  uptime: Math.round(process.uptime()),
}))

app.get('/api/auth/me', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  return { user }
})

app.post('/api/auth/logout', async (request, reply) => {
  const token = request.cookies?.[sessionCookie]
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token))
  reply.clearCookie(sessionCookie, { path: '/' })
  return { ok: true }
})

app.post('/api/devices/pairing-code', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  if (!rateLimit(`paircode:${user.id}`, 10)) return fail(reply, 429, 'too many requests')

  let code = newCode()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!db.prepare('SELECT 1 AS found FROM pairing_codes WHERE code = ?').get(code)) break
    code = newCode()
  }
  const expiresAt = now() + pairingTtl
  db.prepare('INSERT INTO pairing_codes (code, user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)').run(code, user.id, expiresAt, now())
  audit(user.id, 'pairing-code', code)
  return { code, expiresAt }
})

app.post('/api/pair', async (request, reply) => {
  if (!rateLimit(`pair:${request.ip}`, 20)) return fail(reply, 429, 'too many requests')
  const body = request.body ?? {}
  const code = String(body.code ?? '').toUpperCase().trim()
  const deviceName = String(body.deviceName ?? 'DSH').trim().slice(0, 64) || 'DSH'
  const instanceId = String(body.instanceId ?? '').trim().slice(0, 128)
  if (code === '') return fail(reply, 400, 'code is required')

  const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code)
  if (!row || row.used_at !== null || row.expires_at < now()) return fail(reply, 400, 'invalid or expired pairing code')

  const deviceId = newId('device')
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN')
  try {
    const changed = db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ? AND used_at IS NULL').run(now(), code)
    if (changed.changes !== 1) {
      db.exec('ROLLBACK')
      return fail(reply, 409, 'pairing code already used')
    }
    db.prepare('INSERT INTO devices (id, user_id, name, instance_id, token_hash, plugin_version, paired_at, last_seen, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)').run(deviceId, row.user_id, deviceName, instanceId, sha256(token), now(), now())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    return fail(reply, 409, `cannot pair device: ${String(error)}`)
  }

  audit(row.user_id, 'pair', `${deviceName} (${deviceId})`)
  return { deviceId, token, serverTime: now() }
})

app.get('/api/devices', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  const rows = db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY paired_at DESC').all(user.id)
  return { devices: rows.map(serializeDevice) }
})

app.delete('/api/devices/:id', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  const device = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(request.params.id, user.id)
  if (!device) return fail(reply, 404, 'device not found')
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now(), device.id)
  const socket = deviceSockets.get(device.id)
  if (socket) socket.close(4001, 'revoked')
  audit(user.id, 'revoke-device', device.id)
  return { ok: true }
})

app.get('/api/reviews', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  const status = typeof request.query?.status === 'string' ? request.query.status : undefined
  const rows = db.prepare('SELECT r.*, d.name AS device_name FROM reviews r JOIN devices d ON d.id = r.device_id WHERE d.user_id = ? AND d.revoked_at IS NULL ORDER BY r.updated_at DESC LIMIT 100').all(user.id)
  const reviews = rows
    .filter((row) => status === undefined || row.status === status)
    .map((row) => {
      const payload = fromJson(row.payload, {})
      return {
        id: row.id,
        deviceId: row.device_id,
        deviceName: row.device_name,
        sessionId: row.session_id,
        title: typeof payload.title === 'string' ? payload.title : row.id,
        status: row.status,
        version: row.version,
        updatedAt: row.updated_at,
      }
    })
  return { reviews }
})

app.get('/api/reviews/:id', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  const row = db.prepare('SELECT r.* FROM reviews r JOIN devices d ON d.id = r.device_id WHERE r.id = ? AND d.user_id = ?').get(request.params.id, user.id)
  if (!row) return fail(reply, 404, 'review not found')
  return { review: fromJson(row.payload, null) }
})
app.get('/api/reviews/:id/chat', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  const review = db.prepare('SELECT r.id FROM reviews r JOIN devices d ON d.id = r.device_id WHERE r.id = ? AND d.user_id = ?').get(request.params.id, user.id)
  if (!review) return fail(reply, 404, 'review not found')
  const rows = db.prepare('SELECT id, role, text, created_at FROM chat_messages WHERE review_id = ? AND user_id = ? ORDER BY id ASC LIMIT 200').all(request.params.id, user.id)
  return { messages: rows.map((row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.created_at })) }
})

app.get('/api/chat', async (request, reply) => {
  const user = userFromRequest(request)
  if (!user) return fail(reply, 401, 'unauthorized')
  const rows = db.prepare('SELECT id, role, text, created_at FROM chat_messages WHERE review_id = ? AND user_id = ? ORDER BY id ASC LIMIT 200').all('global', user.id)
  return { messages: rows.map((row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.created_at })) }
})


const indexHtml = () => {
  const built = join(distDir, 'index.html')
  const file = existsSync(built) ? built : join(publicDir, 'index.html')
  if (existsSync(file)) return readFileSync(file, 'utf8')
  return '<!doctype html><title>DSH Review</title><h1>DSH Review</h1>'
}
const ASSET_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}
app.get('/assets/*', async (request, reply) => {
  const name = String(request.params['*'] ?? '')
  const assetsDir = join(distDir, 'assets')
  const file = resolve(assetsDir, name)
  if (name === '' || !file.startsWith(resolve(assetsDir) + sep) || !existsSync(file)) return reply.code(404).send({ error: 'not found' })
  const ext = name.slice(name.lastIndexOf('.'))
  return reply.type(ASSET_TYPES[ext] ?? 'application/octet-stream').send(readFileSync(file))
})
app.get('/', async (_request, reply) => reply.type('text/html').send(indexHtml()))
app.get('/favicon.ico', async (_request, reply) => reply.code(204).send())
app.setNotFoundHandler((request, reply) => {
  if (String(request.raw.url ?? '').startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
  return reply.type('text/html').send(indexHtml())
})

const wssDevice = new WebSocketServer({ noServer: true })
const wssBrowser = new WebSocketServer({ noServer: true })

app.server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (url.pathname === '/ws/device') {
    const token = url.searchParams.get('token') ?? bearer(request)
    const device = token ? db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) : undefined
    if (!device) return rejectSocket(socket, 401)
    wssDevice.handleUpgrade(request, socket, head, (ws) => wssDevice.emit('connection', ws, request, device))
    return
  }

  if (url.pathname === '/ws/browser') {
    const cookies = parseCookies(request.headers.cookie)
    const user = userFromToken(cookies[sessionCookie])
    if (!user) return rejectSocket(socket, 401)
    wssBrowser.handleUpgrade(request, socket, head, (ws) => wssBrowser.emit('connection', ws, request, user))
    return
  }

  rejectSocket(socket, 404)
})

wssDevice.on('connection', (ws, _request, device) => {
  deviceSockets.set(device.id, ws)
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), device.id)
  send(ws, { type: 'hello', deviceId: device.id, serverTime: now() })
  send(ws, { type: 'review.catalog', reviews: reviewCatalogFor(device.user_id) })
  broadcastDeviceStatus(device.user_id, device.id, true)

  ws.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return

    if (message.type === 'hello') {
      if (typeof message.pluginVersion === 'string') {
        db.prepare('UPDATE devices SET plugin_version = ?, last_seen = ? WHERE id = ?').run(message.pluginVersion.slice(0, 40), now(), device.id)
      }
      return
    }

    if (message.type === 'review.snapshot' || message.type === 'review.update') {
      const review = message.review
      if (!review || typeof review.id !== 'string') return
      const version = Number.isSafeInteger(review.version) ? review.version : 0
      db.prepare('INSERT INTO reviews (id, device_id, session_id, status, version, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, session_id = excluded.session_id, status = excluded.status, version = excluded.version, payload = excluded.payload, updated_at = excluded.updated_at').run(
        review.id,
        device.id,
        typeof review.sessionId === 'string' ? review.sessionId : '',
        typeof review.status === 'string' ? review.status : 'open',
        version,
        JSON.stringify(review),
        now(),
      )
      db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), device.id)
      broadcastBrowsers(device.user_id, { type: 'review.snapshot', review })
      audit(device.user_id, 'review-snapshot', review.id)
      return
    }

    if (message.type === 'review.result') {
      broadcastBrowsers(device.user_id, {
        type: 'review.result',
        reviewId: message.reviewId,
        results: Array.isArray(message.results) ? message.results : [],
        version: message.version,
        error: typeof message.error === 'string' ? message.error : undefined,
      })
      audit(device.user_id, 'review-result', String(message.reviewId ?? ''))
      return
    }
    if (message.type === 'chat.message' || message.type === 'chat.error') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : ''
      if (message.type === 'chat.message') {
        const text = String(message.text ?? '').trim()
        if (text === '') return
        const createdAt = now()
        const info = db.prepare('INSERT INTO chat_messages (review_id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)').run('global', device.user_id, 'assistant', text, createdAt)
        broadcastBrowsers(device.user_id, { type: 'chat.message', requestId, id: Number(info.lastInsertRowid), role: 'assistant', text, createdAt })
      } else {
        broadcastBrowsers(device.user_id, { type: 'chat.error', requestId, message: typeof message.message === 'string' ? message.message : 'Chat failed' })
      }
      return
    }


    if (message.type === 'pong') {
      db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), device.id)
    }
  })

  ws.on('close', () => {
    if (deviceSockets.get(device.id) === ws) {
      deviceSockets.delete(device.id)
      broadcastDeviceStatus(device.user_id, device.id, false)
    }
  })
  ws.on('error', () => {})
})

wssBrowser.on('connection', (ws, _request, user) => {
  ws.user = user
  browserSockets.add(ws)
  send(ws, { type: 'hello', userId: user.id })

  const devices = db.prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL').all(user.id)
  for (const device of devices) {
    send(ws, { type: 'device.status', deviceId: device.id, online: deviceSockets.has(device.id), lastSeen: device.last_seen })
  }

  ws.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return

    if (message.type === 'ping') {
      send(ws, { type: 'pong' })
      return
    }

    if (message.type === 'chat.send') {
      const text = String(message.text ?? '').trim()
      if (text === '') {
        send(ws, { type: 'error', requestId: message.requestId, message: 'write a question first' })
        return
      }
      if (text.length > 8000) {
        send(ws, { type: 'error', requestId: message.requestId, message: 'question is too long' })
        return
      }
      if (!rateLimit(`chat:${user.id}`, 60)) {
        send(ws, { type: 'error', requestId: message.requestId, message: 'too many messages' })
        return
      }
      const devices = db.prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen DESC').all(user.id)
      const target = devices.find((candidate) => deviceSockets.has(candidate.id))
      if (target === undefined) {
        send(ws, { type: 'error', requestId: message.requestId, message: 'DSH is offline' })
        return
      }
      const requestId = typeof message.requestId === 'string' ? message.requestId : newId('req')
      const createdAt = now()
      const info = db.prepare('INSERT INTO chat_messages (review_id, user_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)').run('global', user.id, 'user', text, createdAt)
      broadcastBrowsers(user.id, { type: 'chat.message', requestId, id: Number(info.lastInsertRowid), role: 'user', text, createdAt })
      let sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
      if (sessionId === '') {
        const latest = db.prepare('SELECT r.session_id FROM reviews r JOIN devices d ON d.id = r.device_id WHERE d.user_id = ? ORDER BY r.updated_at DESC LIMIT 1').get(user.id)
        sessionId = typeof latest?.session_id === 'string' ? latest.session_id : ''
      }
      send(deviceSockets.get(target.id), { type: 'chat.send', requestId, text, sessionId })
      audit(user.id, 'chat-send', 'global')
      return
    }

    if (message.type === 'decision' || message.type === 'line.request') {
      const review = db.prepare('SELECT r.*, d.user_id AS owner_id FROM reviews r JOIN devices d ON d.id = r.device_id WHERE r.id = ?').get(message.reviewId)
      if (!review || review.owner_id !== user.id) {
        send(ws, { type: 'error', requestId: message.requestId, message: 'review not found' })
        return
      }
      const deviceSocket = deviceSockets.get(review.device_id)
      if (!deviceSocket) {
        send(ws, { type: 'error', requestId: message.requestId, message: 'DSH is offline' })
        return
      }
      const requestId = typeof message.requestId === 'string' ? message.requestId : newId('req')
      if (message.type === 'decision') {
        send(deviceSocket, {
          type: 'decision',
          requestId,
          reviewId: message.reviewId,
          decisionId: message.decisionId,
          expectedVersion: message.expectedVersion,
          decisions: message.decisions,
        })
        audit(user.id, 'decision', `${message.reviewId}:${String(message.decisionId ?? '')}`)
      } else {
        send(deviceSocket, { type: 'line.request', requestId, reviewId: message.reviewId, lineRequest: message.lineRequest })
        audit(user.id, 'line-request', `${message.reviewId}:${String(message.lineRequest?.id ?? '')}`)
      }
    }
  })

  ws.on('close', () => browserSockets.delete(ws))
  ws.on('error', () => {})
})

try {
  await app.listen({ port, host })
  app.log.info(`dsh-coding-enhanced-web listening at ${origin} (bound ${host}:${port}, data ${dataDir})`)
} catch (error) {
  app.log.error(error)
  process.exit(1)
}

const shutdown = async () => {
  try {
    for (const ws of deviceSockets.values()) ws.close(1001, 'shutdown')
    for (const ws of browserSockets) ws.close(1001, 'shutdown')
    await app.close()
    db.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

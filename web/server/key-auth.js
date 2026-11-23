import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Username + user key authentication.
 *
 * Registration issues a random 32-byte key once; only its sha256 hash and a
 * short hint are stored. Login compares the hash with timingSafeEqual and
 * creates the same HttpOnly session cookie used by the rest of the app.
 * This replaces WebAuthn/passkey for the standalone review server.
 */
export const registerKeyAuth = (app, deps) => {
  const { db, sha256, newId, createSession, setSessionCookie, audit, rateLimit, fail } = deps

  db.exec(`
CREATE TABLE IF NOT EXISTS user_keys (
  user_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`)

  app.post('/api/auth/register', async (request, reply) => {
    if (!rateLimit(`key-register:${request.ip}`, 10)) return fail(reply, 429, 'too many requests')
    const username = String((request.body ?? {}).username ?? '').trim()
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return fail(reply, 400, 'username must be 3-32 characters (letters, numbers, _ . -)')
    if (db.prepare('SELECT 1 AS found FROM users WHERE username = ?').get(username)) return fail(reply, 409, 'username already exists')

    const userId = newId('user')
    const key = randomBytes(32).toString('base64url')
    const keyHash = sha256(key)
    db.exec('BEGIN')
    try {
      db.prepare('INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)').run(userId, username, Date.now())
      db.prepare('INSERT INTO user_keys (user_id, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?)').run(userId, keyHash, key.slice(0, 6), Date.now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      return fail(reply, 409, `cannot create user: ${String(error)}`)
    }

    const token = createSession(userId)
    setSessionCookie(reply, token)
    audit(userId, 'key-register', username)
    return { user: { id: userId, username }, key }
  })

  app.post('/api/auth/login', async (request, reply) => {
    if (!rateLimit(`key-login:${request.ip}`, 30)) return fail(reply, 429, 'too many requests')
    const body = request.body ?? {}
    const username = String(body.username ?? '').trim()
    const key = String(body.key ?? '').trim()
    if (username === '' || key === '') return fail(reply, 400, 'username and key are required')

    const row = db.prepare('SELECT u.id AS id, u.username AS username, k.key_hash AS keyHash FROM users u JOIN user_keys k ON k.user_id = u.id WHERE u.username = ?').get(username)
    if (!row) return fail(reply, 401, 'invalid username or key')
    const expected = Buffer.from(row.keyHash, 'hex')
    const actual = Buffer.from(sha256(key), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return fail(reply, 401, 'invalid username or key')

    const token = createSession(row.id)
    setSessionCookie(reply, token)
    audit(row.id, 'key-login', username)
    return { user: { id: row.id, username: row.username } }
  })
}

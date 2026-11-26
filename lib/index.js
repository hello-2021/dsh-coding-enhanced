/**
 * dsh-coding-enhanced — host half.
 *
 * Codex-style "undo last turn" for DeepSeek Harness:
 *
 *  - Before every top-level turn starts, a shadow git repository (kept under
 *    `$DSH_HOME/coding-enhanced/repos`, never inside the workspace) records a
 *    tree of the whole working directory.  The first tool call of the turn
 *    waits for that snapshot, so no mutation can precede it.
 *  - Withdrawing a turn restores the working directory to that tree (modified,
 *    created, and deleted files alike), appends a model-only surface
 *    replacement that hides the turn from the AI's context, and records the
 *    withdrawal so the client can grey the transcript.
 *
 * The browser half talks to this file through the authenticated Connection
 * `/api` bridge: `POST /api/coding-enhanced` with `{ endpoint, payload }`.
 */
import { execFile } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectShellWrites } from './detect-writes.js'
import { createWebBridge } from './web-bridge.js'
import { fileURLToPath } from 'node:url'

export const name = 'coding-enhanced'
export const inject = ['sessions', 'connection', 'tools', 'systemPrompt', 'subagents', 'agents']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const compareVersions = (left, right) => {
  const parse = (value) => String(value).split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) === (b[index] ?? 0)) continue
    return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1
  }
  return 0
}

const execOnce = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { maxBuffer: 8 * 1024 * 1024, timeout: 120000, ...options }, (error, stdout, stderr) => {
    if (error !== null) {
      reject(new Error(`${command} ${args.join(' ')}: ${String(stderr || error.message).trim()}`))
      return
    }
    resolve({ stdout, stderr })
  })
})

const readConfiguredRegistry = () => {
  const files = [
    path.join(os.homedir(), '.npmrc'),
    path.join(path.dirname(path.dirname(PACKAGE_ROOT)), '.npmrc'),
  ]
  for (const file of files) {
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*registry\s*=\s*(\S+)\s*$/)
        if (match !== null) return match[1]
      }
    } catch {
      // ignore missing/unreadable npmrc
    }
  }
  return process.env.npm_config_registry
}

const registryBases = () => {
  const configured = readConfiguredRegistry()
  return [...new Set([
    configured,
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
  ].filter((value) => typeof value === 'string' && value.length > 0))]
}

const latestNpmVersion = async () => {
  const failures = []
  for (const base of registryBases()) {
    const url = `${base.replace(/\/+$/, '')}/dsh-coding-enhanced/latest`
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        signal: AbortSignal.timeout(12000),
      })
      if (response.ok !== true) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (typeof data.version !== 'string' || data.version === '') throw new Error('no version in response')
      return { version: data.version, registry: base }
    } catch (error) {
      failures.push(`${base} (${String(error)})`)
    }
  }
  throw new Error(`No npm registry reachable. Tried: ${failures.join('; ')}`)
}

const findBundledPnpm = () => {
  const candidates = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'runtime', 'pnpm', 'bin', 'pnpm.cjs'))
    candidates.push(path.join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  candidates.push(path.join(path.dirname(process.execPath), '..', 'Resources', 'app.asar', 'runtime', 'pnpm', 'bin', 'pnpm.cjs'))
  return candidates.find((candidate) => existsSync(candidate))
}

const installPackage = async (spec, profileDir) => {
  const failures = []
  try {
    await execOnce('pnpm', ['add', spec], { cwd: profileDir })
    return 'pnpm'
  } catch (error) {
    failures.push(String(error))
  }
  try {
    await execOnce('npm', ['install', spec, '--no-audit', '--no-fund'], { cwd: profileDir })
    return 'npm'
  } catch (error) {
    failures.push(String(error))
  }
  const bundled = findBundledPnpm()
  if (bundled !== undefined) {
    try {
      await execOnce(process.execPath, [bundled, 'add', spec], {
        cwd: profileDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      return 'dsh-bundled-pnpm'
    } catch (error) {
      failures.push(String(error))
    }
  }
  throw new Error(failures.join(' | '))
}

const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const DEFAULT_EXCLUDES = ['.git/', 'node_modules/', '.DS_Store', '.dsh-coding-enhanced/']
const GIT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_BUFFER = 512 * 1024 * 1024

/** Resolve a usable git executable once. */
function resolveGit() {
  const candidates = [
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
    'git',
  ]
  for (const candidate of candidates) {
    if (candidate !== 'git' && !existsSync(candidate)) continue
    return candidate
  }
  return 'git'
}

const GIT = resolveGit()

function runGit(args, { gitDir, workTree, encoding = 'utf8' } = {}) {
  const full = ['--git-dir', gitDir]
  if (workTree !== undefined) full.push('--work-tree', workTree)
  full.push(...args)
  return new Promise((resolve, reject) => {
    execFile(
      GIT,
      full,
      {
        ...(workTree === undefined ? {} : { cwd: workTree }),
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_INDEX_FILE: path.join(gitDir, 'index'),
        },
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        encoding,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const message = typeof stderr === 'string' && stderr.trim() !== ''
            ? stderr.trim()
            : error.message
          reject(new Error(`git ${args[0]} failed: ${message}`))
          return
        }
        resolve(stdout)
      },
    )
  })
}

function isSubagent(session) {
  const header = session.header ?? {}
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

function shadowRepoPath(root, cwd) {
  const key = createHash('sha1').update(cwd).digest('hex').slice(0, 20)
  return path.join(root, 'repos', `${key}.git`)
}

function assertSafeRelative(rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel)) {
    throw new Error(`unsafe restorable path: ${JSON.stringify(rel)}`)
  }
  const parts = rel.split(/[\\/]/)
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new Error(`unsafe restorable path: ${JSON.stringify(rel)}`)
  }
  return rel
}

function posixJoin(cwd, rel) {
  return path.join(cwd, ...rel.split('/'))
}

/** Whether `child` is inside `parent` (or equal to it). */
function insideDir(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Count non-overlapping literal occurrences. */
function countOccurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let from = 0
  while (true) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) return count
    count += 1
    from = index + needle.length
  }
}

/** Replace the first literal occurrence. */
function replaceFirst(haystack, needle, replacement) {
  const index = haystack.indexOf(needle)
  if (index < 0) return haystack
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length)
}

/** Split text into lines without the trailing newline artifact. */
function splitLines(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Line diff (LCS) with a bounded middle; large middles degrade to replace-all. */
function lcsOps(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ type: 'add', text }))
  if (m === 0) return a.map((text) => ({ type: 'del', text }))
  if (n > 1500 || m > 1500 || n * m > 4_000_000) {
    return [...a.map((text) => ({ type: 'del', text })), ...b.map((text) => ({ type: 'add', text }))]
  }
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      ops.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] })
  while (j < m) ops.push({ type: 'add', text: b[j++] })
  return ops
}

/** Unified-diff hunks with line numbers and three context lines. */
function computeDiff(beforeText, afterText) {
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length - 1
  let endAfter = after.length - 1
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
    endBefore -= 1
    endAfter -= 1
  }
  const ops = [
    ...before.slice(0, start).map((text) => ({ type: 'context', text })),
    ...lcsOps(before.slice(start, endBefore + 1), after.slice(start, endAfter + 1)),
    ...before.slice(endBefore + 1).map((text) => ({ type: 'context', text })),
  ]

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'add') added += 1
    else if (op.type === 'del') removed += 1
  }
  if (added === 0 && removed === 0) return { hunks: [], added: 0, removed: 0, truncated: false }

  let truncated = false
  let visible = ops
  if (visible.length > 5000) {
    visible = visible.slice(0, 5000)
    truncated = true
  }

  let oldNo = 1
  let newNo = 1
  for (const op of ops) {
    op.oldNo = op.type === 'add' ? null : oldNo
    op.newNo = op.type === 'del' ? null : newNo
    if (op.type !== 'add') oldNo += 1
    if (op.type !== 'del') newNo += 1
  }

  const context = 3
  const changes = []
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index].type !== 'context') changes.push(index)
  }
  if (changes.length === 0) return { hunks: [], added, removed, truncated }
  const ranges = []
  for (const index of changes) {
    const from = Math.max(0, index - context)
    const to = Math.min(visible.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to)
    else ranges.push({ from, to })
  }
  const hunks = ranges.map(({ from, to }) => {
    const lines = visible.slice(from, to + 1).map((op) => ({
      type: op.type,
      oldNo: op.oldNo,
      newNo: op.newNo,
      text: op.text,
    }))
    const oldStart = lines.find((line) => line.oldNo !== null)?.oldNo ?? 0
    const newStart = lines.find((line) => line.newNo !== null)?.newNo ?? 0
    const oldCount = lines.filter((line) => line.oldNo !== null).length
    const newCount = lines.filter((line) => line.newNo !== null).length
    return {
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    }
  })
  return { hunks, added, removed, truncated }
}

/** Optional AI explanations anchored to a new-file line or a 1-based hunk. */
function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return []
  const notes = []
  for (const item of raw.slice(0, 30)) {
    if (item === null || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (text === '') continue
    const line = Number.isSafeInteger(item.line) && item.line >= 1 ? item.line : undefined
    const hunk = Number.isSafeInteger(item.hunk) && item.hunk >= 1 ? item.hunk : undefined
    notes.push({
      id: `note-${notes.length + 1}`,
      ...(line === undefined ? {} : { line }),
      ...(hunk === undefined ? {} : { hunk }),
      text: text.slice(0, 1200),
      at: Date.now(),
    })
  }
  return notes
}

export function apply(ctx) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const root = path.join(home, 'coding-enhanced')
  const legacyRoot = path.join(home, 'withdraw-round')
  if (!existsSync(root) && existsSync(legacyRoot)) {
    try {
      renameSync(legacyRoot, root)
    } catch {}
  }
  const statePath = path.join(root, 'state.json')
  const settingsPath = path.join(root, 'settings.json')
  mkdirSync(root, { recursive: true })

  const REVIEW_CHANNELS = new Set(['web', 'both', 'builtin'])
  const featureFlags = { review: true, withdraw: true, autoReview: true, aiExplain: true, allowBlockingReviewWait: false, keepTurns: 10, nestedSnapshots: true, autoGc: true, reviewChannel: 'both', webUrl: '', webDeviceToken: '', webDeviceId: '' }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    if (typeof parsed.review === 'boolean') featureFlags.review = parsed.review
    if (typeof parsed.withdraw === 'boolean') featureFlags.withdraw = parsed.withdraw
    if (typeof parsed.autoReview === 'boolean') featureFlags.autoReview = parsed.autoReview
    if (typeof parsed.aiExplain === 'boolean') featureFlags.aiExplain = parsed.aiExplain
    if (typeof parsed.allowBlockingReviewWait === 'boolean') featureFlags.allowBlockingReviewWait = parsed.allowBlockingReviewWait
    if (Number.isSafeInteger(parsed.keepTurns)) {
      featureFlags.keepTurns = Math.min(50, Math.max(1, parsed.keepTurns))
    }
    if (typeof parsed.nestedSnapshots === 'boolean') featureFlags.nestedSnapshots = parsed.nestedSnapshots
    if (typeof parsed.autoGc === 'boolean') featureFlags.autoGc = parsed.autoGc
    if (REVIEW_CHANNELS.has(parsed.reviewChannel)) featureFlags.reviewChannel = parsed.reviewChannel
    if (typeof parsed.webUrl === 'string') featureFlags.webUrl = parsed.webUrl
    if (typeof parsed.webDeviceToken === 'string') featureFlags.webDeviceToken = parsed.webDeviceToken
    if (typeof parsed.webDeviceId === 'string') featureFlags.webDeviceId = parsed.webDeviceId
  } catch {}

  const saveFeatureFlags = () => {
    try {
      mkdirSync(root, { recursive: true })
      const tmp = `${settingsPath}.tmp`
      writeFileSync(tmp, JSON.stringify(featureFlags))
      renameSync(tmp, settingsPath)
    } catch (error) {
      ctx.logger?.warn?.(`coding-enhanced: cannot persist settings: ${String(error)}`)
    }
  }

  ctx.logger?.info?.(`coding-enhanced: state at ${root}`)

  // ---------------------------------------------------------------- state ---
  let state = { sessions: {}, snapshots: {} }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      if (parsed.sessions) state.sessions = parsed.sessions
      if (parsed.snapshots && typeof parsed.snapshots === 'object') state.snapshots = parsed.snapshots
    }
  } catch {}

  const saveState = () => {
    try {
      const sessions = Object.entries(state.sessions)
      if (sessions.length > 200) {
        sessions.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
        for (const [id] of sessions.slice(0, sessions.length - 200)) {
          delete state.sessions[id]
          delete state.snapshots[id]
        }
      }
      mkdirSync(root, { recursive: true })
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state))
      renameSync(tmp, statePath)
    } catch (error) {
      ctx.logger?.warn?.(`coding-enhanced: cannot persist state: ${String(error)}`)
    }
  }

  const withdrawnOf = (sessionId) => state.sessions[sessionId]?.withdrawn ?? {}

  const backupOf = (sessionId) => {
    const backup = state.sessions[sessionId]?.backup
    if (backup === null || typeof backup !== 'object') return undefined
    if (typeof backup.tree !== 'string' || typeof backup.cwd !== 'string' || typeof backup.gitDir !== 'string') return undefined
    return {
      tree: backup.tree,
      cwd: backup.cwd,
      gitDir: backup.gitDir,
      nested: Array.isArray(backup.nested)
        ? backup.nested.filter((nested) =>
            nested !== null && typeof nested === 'object'
            && typeof nested.cwd === 'string' && typeof nested.tree === 'string' && typeof nested.gitDir === 'string')
        : [],
      at: Number.isSafeInteger(backup.at) ? backup.at : undefined,
    }
  }

  const setBackup = (sessionId, backup) => {
    const record = state.sessions[sessionId] ?? {}
    record.backup = backup
    record.updatedAt = Date.now()
    state.sessions[sessionId] = record
    saveState()
  }

  // ------------------------------------------------------------ snapshots ---
  /** sessionId -> Map<turn, { sessionId, turn, tree, cwd, gitDir, endSeq, createdAt }> */
  const snapshots = new Map()

  const snapshotRef = (sessionId, turn) =>
    `refs/coding-enhanced/${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}/${turn}`

  const writeSnapshotRefs = async (snapshot) => {
    const ref = snapshotRef(snapshot.sessionId, snapshot.turn)
    try {
      await runGit(['update-ref', ref, snapshot.tree], { gitDir: snapshot.gitDir })
    } catch (error) {
      ctx.logger?.warn?.(`coding-enhanced: cannot create snapshot ref: ${String(error)}`)
    }
    for (const nested of Array.isArray(snapshot.nested) ? snapshot.nested : []) {
      try {
        await runGit(['update-ref', ref, nested.tree], { gitDir: nested.gitDir })
      } catch (error) {
        ctx.logger?.warn?.(`coding-enhanced: cannot create nested snapshot ref: ${String(error)}`)
      }
    }
  }

  const backupRef = (sessionId) =>
    `refs/coding-enhanced/${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}/backup`

  const writeBackupRefs = async (backup) => {
    const ref = backupRef(backup.sessionId)
    try {
      await runGit(['update-ref', ref, backup.tree], { gitDir: backup.gitDir })
    } catch (error) {
      ctx.logger?.warn?.(`coding-enhanced: cannot create backup ref: ${String(error)}`)
    }
    for (const nested of Array.isArray(backup.nested) ? backup.nested : []) {
      try {
        await runGit(['update-ref', ref, nested.tree], { gitDir: nested.gitDir })
      } catch (error) {
        ctx.logger?.warn?.(`coding-enhanced: cannot create nested backup ref: ${String(error)}`)
      }
    }
  }

  const deleteSnapshotRefs = async (snapshot) => {
    const ref = snapshotRef(snapshot.sessionId, snapshot.turn)
    try {
      await runGit(['update-ref', '-d', ref], { gitDir: snapshot.gitDir })
    } catch {}
    for (const nested of Array.isArray(snapshot.nested) ? snapshot.nested : []) {
      try {
        await runGit(['update-ref', '-d', ref], { gitDir: nested.gitDir })
      } catch {}
    }
  }

  for (const [sessionId, turns] of Object.entries(state.snapshots)) {
    if (turns === null || typeof turns !== 'object') continue
    const map = new Map()
    for (const [turnRaw, value] of Object.entries(turns)) {
      const turn = Number(turnRaw)
      if (!Number.isSafeInteger(turn) || value === null || typeof value !== 'object') continue
      if (typeof value.tree !== 'string' || typeof value.cwd !== 'string' || typeof value.gitDir !== 'string') continue
      const snapshot = {
        sessionId,
        turn,
        tree: value.tree,
        cwd: value.cwd,
        gitDir: value.gitDir,
        endSeq: Number.isSafeInteger(value.endSeq) ? value.endSeq : undefined,
        createdAt: Number.isSafeInteger(value.createdAt) ? value.createdAt : Date.now(),
        nested: Array.isArray(value.nested)
          ? value.nested.filter((nested) =>
              nested !== null && typeof nested === 'object'
              && typeof nested.cwd === 'string' && typeof nested.tree === 'string' && typeof nested.gitDir === 'string')
            .map((nested) => ({ cwd: nested.cwd, tree: nested.tree, gitDir: nested.gitDir }))
          : [],
      }
      map.set(turn, snapshot)
      void writeSnapshotRefs(snapshot)
    }
    if (map.size > 0) snapshots.set(sessionId, map)
  }

  for (const sessionId of Object.keys(state.sessions)) {
    const backup = backupOf(sessionId)
    if (backup !== undefined) void writeBackupRefs({ ...backup, sessionId })
  }

  const latestSnapshot = (sessionId) => {
    const map = snapshots.get(sessionId)
    if (map === undefined || map.size === 0) return undefined
    let latest
    for (const snapshot of map.values()) {
      if (latest === undefined || snapshot.turn > latest.turn) latest = snapshot
    }
    return latest
  }

  const snapshotOf = (sessionId, turn) => snapshots.get(sessionId)?.get(turn)

  const persistSnapshots = (sessionId) => {
    const map = snapshots.get(sessionId)
    if (map === undefined || map.size === 0) {
      delete state.snapshots[sessionId]
      saveState()
      return
    }
    const record = {}
    for (const [turn, snapshot] of map.entries()) {
      record[String(turn)] = {
        tree: snapshot.tree,
        cwd: snapshot.cwd,
        gitDir: snapshot.gitDir,
        endSeq: Number.isSafeInteger(snapshot.endSeq) ? snapshot.endSeq : null,
        createdAt: snapshot.createdAt ?? Date.now(),
        nested: Array.isArray(snapshot.nested) ? snapshot.nested : [],
      }
    }
    state.snapshots[sessionId] = record
    saveState()
  }

  const setSnapshot = (snapshot) => {
    let map = snapshots.get(snapshot.sessionId)
    if (map === undefined) {
      map = new Map()
      snapshots.set(snapshot.sessionId, map)
    }
    map.set(snapshot.turn, snapshot)
    persistSnapshots(snapshot.sessionId)
  }
  /** gitDir -> worktree for repos whose snapshots were dropped */
  const dirtyRepos = new Map()
  const gcTimestamps = new Map()

  const markSnapshotDirty = (snapshot) => {
    if (snapshot === undefined || snapshot === null) return
    if (typeof snapshot.gitDir === 'string' && typeof snapshot.cwd === 'string') {
      dirtyRepos.set(snapshot.gitDir, snapshot.cwd)
    }
    for (const nested of Array.isArray(snapshot.nested) ? snapshot.nested : []) {
      if (typeof nested.gitDir === 'string' && typeof nested.cwd === 'string') {
        dirtyRepos.set(nested.gitDir, nested.cwd)
      }
    }
  }

  const gcRepo = async (gitDir, cwd, force = false) => {
    const now = Date.now()
    if (!force && (gcTimestamps.get(gitDir) ?? 0) > now - 10 * 60 * 1000) return false
    gcTimestamps.set(gitDir, now)
    try {
      await serialized(`snapshot:${cwd}`, () =>
        runGit(['gc', '--prune=now', '--quiet'], { gitDir }))
      return true
    } catch (error) {
      ctx.logger?.warn?.(`coding-enhanced: git gc failed for ${gitDir}: ${String(error)}`)
      return false
    }
  }

  const flushGc = async (force = false) => {
    const entries = [...dirtyRepos.entries()]
    dirtyRepos.clear()
    let count = 0
    for (const [gitDir, cwd] of entries) {
      if (await gcRepo(gitDir, cwd, force)) count += 1
    }
    return count
  }

  const cleanupSnapshots = async () => {
    let pruned = 0
    for (const sessionId of [...snapshots.keys()]) {
      const map = snapshots.get(sessionId)
      if (map === undefined) continue
      const turns = [...map.keys()].sort((left, right) => left - right)
      while (turns.length > featureFlags.keepTurns) {
        const turn = turns.shift()
        const snapshot = map.get(turn)
        if (snapshot !== undefined) {
          await deleteSnapshotRefs(snapshot)
          markSnapshotDirty(snapshot)
          map.delete(turn)
          pruned += 1
        }
      }
      if (map.size === 0) snapshots.delete(sessionId)
      persistSnapshots(sessionId)
    }
    try {
      const entries = await fs.readdir(path.join(root, 'repos'), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue
        const gitDir = path.join(root, 'repos', entry.name)
        try {
          const cwd = (await runGit(['config', 'core.worktree'], { gitDir })).trim()
          if (cwd !== '') dirtyRepos.set(gitDir, cwd)
        } catch {}
      }
    } catch {}
    const repos = await flushGc(true)
    return { pruned, repos }
  }

  const pruneSnapshots = (sessionId) => {
    const map = snapshots.get(sessionId)
    if (map === undefined) return
    const turns = [...map.keys()].sort((left, right) => left - right)
    if (turns.length <= featureFlags.keepTurns) return
    let removed = 0
    while (turns.length > featureFlags.keepTurns) {
      const snapshot = map.get(turns.shift())
      if (snapshot !== undefined) {
        void deleteSnapshotRefs(snapshot)
        markSnapshotDirty(snapshot)
        map.delete(snapshot.turn)
        removed += 1
      }
    }
    if (map.size === 0) snapshots.delete(sessionId)
    persistSnapshots(sessionId)
    if (removed > 0 && featureFlags.autoGc === true) void flushGc()
  }

  const pruneAllSnapshots = () => {
    for (const sessionId of [...snapshots.keys()]) pruneSnapshots(sessionId)
  }
  /** sessionId -> turn number while a turn is running */
  const activeTurns = new Map()
  /** sessionId -> Promise of the in-flight snapshot */
  const pendingSnapshots = new Map()
  /** gitDir -> serialized git queue so concurrent sessions never race the index */
  const gitQueues = new Map()

  const serialized = (key, work) => {
    const previous = gitQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    gitQueues.set(key, next.catch(() => {}))
    return next
  }

  const ensureRepo = async (cwd) => {
    const gitDir = shadowRepoPath(root, cwd)
    if (existsSync(path.join(gitDir, 'HEAD'))) return gitDir
    mkdirSync(path.dirname(gitDir), { recursive: true })
    await runGit(['init', '--quiet', '--bare', gitDir], { gitDir })
    await runGit(['config', 'core.bare', 'false'], { gitDir })
    await runGit(['config', 'core.worktree', cwd], { gitDir })
    await runGit(['config', 'core.autocrlf', 'false'], { gitDir })
    await runGit(['config', 'core.quotepath', 'false'], { gitDir })
    mkdirSync(path.join(gitDir, 'info'), { recursive: true })
    writeFileSync(path.join(gitDir, 'info', 'exclude'), `${DEFAULT_EXCLUDES.join('\n')}\n`)
    return gitDir
  }

  const addAll = async (gitDir, cwd) => {
    try {
      await runGit(['add', '-A', '--ignore-errors'], { gitDir, workTree: cwd })
      return
    } catch (error) {
      const message = String(error?.message ?? error)
      const offenders = [...message.matchAll(/'([^']+)'/g)]
        .map((match) => match[1].replace(/\/+$/, ''))
        .filter((value) => value !== '' && !value.startsWith('/') && !value.split('/').includes('..'))
      if (offenders.length === 0) throw error
      const excludePath = path.join(gitDir, 'info', 'exclude')
      let current = ''
      try {
        current = readFileSync(excludePath, 'utf8')
      } catch {}
      const lines = new Set(current.split('\n').filter((line) => line !== ''))
      for (const offender of offenders) {
        lines.add(`/${offender}/`)
        lines.add(`/${offender}`)
      }
      mkdirSync(path.dirname(excludePath), { recursive: true })
      writeFileSync(excludePath, `${[...lines].join('\n')}\n`)
      ctx.logger?.warn?.(`coding-enhanced: excluded nested repositories from the snapshot: ${offenders.join(', ')}`)
      await runGit(['add', '-A', '--ignore-errors'], { gitDir, workTree: cwd })
    }
  }

  const findNestedRepos = async (cwd) => {
    const found = []
    const walk = async (dir, depth) => {
      if (depth > 12) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh-coding-enhanced') continue
        const absolute = path.join(dir, entry.name)
        if (existsSync(path.join(absolute, '.git'))) {
          found.push(absolute)
          continue
        }
        await walk(absolute, depth + 1)
      }
    }
    await walk(cwd, 0)
    return found
  }

  const captureWorkspace = async (sessionId, cwd) => {
    const gitDir = await ensureRepo(cwd)
    // `--ignore-errors` keeps unreadable files from failing the whole turn.
    try {
      await addAll(gitDir, cwd)
    } catch (error) {
      ctx.logger?.warn?.(`coding-enhanced: snapshot add failed for ${cwd}: ${String(error)}`)
      return undefined
    }
    const tree = (await runGit(['write-tree'], { gitDir, workTree: cwd })).trim()
    if (tree === '') return undefined
    const nested = []
    if (featureFlags.nestedSnapshots === true) {
      let candidates = []
      try {
        candidates = await findNestedRepos(cwd)
      } catch (error) {
        ctx.logger?.warn?.(`coding-enhanced: cannot scan nested repositories in ${cwd}: ${String(error)}`)
      }
      for (const nestedCwd of candidates) {
        try {
          const nestedGitDir = await ensureRepo(nestedCwd)
          await serialized(`snapshot:${nestedCwd}`, async () => {
            await addAll(nestedGitDir, nestedCwd)
            const nestedTree = (await runGit(['write-tree'], { gitDir: nestedGitDir, workTree: nestedCwd })).trim()
            if (nestedTree !== '') nested.push({ cwd: nestedCwd, tree: nestedTree, gitDir: nestedGitDir })
          })
        } catch (error) {
          ctx.logger?.warn?.(`coding-enhanced: cannot snapshot nested repository ${nestedCwd}: ${String(error)}`)
        }
      }
    }
    return { sessionId, tree, cwd, gitDir, nested }
  }

  const captureSnapshot = (sessionId, cwd, turn) => serialized(`snapshot:${cwd}`, async () => {
    const base = await captureWorkspace(sessionId, cwd)
    if (base === undefined) return
    const snapshot = {
      ...base,
      turn,
      endSeq: undefined,
      createdAt: Date.now(),
    }
    await writeSnapshotRefs(snapshot)
    setSnapshot(snapshot)
    pruneSnapshots(sessionId)
  })

  const captureBackup = (sessionId, cwd) => serialized(`snapshot:${cwd}`, async () => {
    const base = await captureWorkspace(sessionId, cwd)
    if (base === undefined) return undefined
    const backup = { ...base, at: Date.now() }
    await writeBackupRefs(backup)
    setBackup(sessionId, backup)
    return backup
  })

  // ------------------------------------------------------- review gate ---
  const REVIEW_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'multi_edit', 'notebook_edit'])
const ARTIFACT_DIRS = ['dist', 'build', 'out', 'target', 'node_modules', '.next', '.cache', 'coverage', '.vitest', '__pycache__', '.pytest_cache', '.turbo', '.parcel-cache']
const isArtifactPath = (value) => {
  const cleaned = String(value).replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')
  if (cleaned === '/dev/null' || cleaned.startsWith('/tmp/') || cleaned === '/tmp') return true
  return ARTIFACT_DIRS.some((dir) => cleaned === dir || cleaned.startsWith(`${dir}/`) || cleaned.includes(`/${dir}/`))
}
const detectShellWritesLegacy = (command) => {
  const reasons = []
  const targets = []
  const add = (reason, target) => {
    reasons.push(reason)
    if (typeof target === 'string' && target !== '') targets.push(target)
  }
  for (const match of command.matchAll(/(?:^|[^>])>{1,2}\s*([^\s;&|]+)/g)) add('shell redirection', match[1])
  const tee = /\btee\s+(?:-[A-Za-z]+\s+)*([^\s;&|]+)/.exec(command)
  if (tee !== null) add('tee', tee[1])
  const sed = /\bsed\s+(?:[^;&|]*\s)?-i(?:\.\w+)?\s+([^\s;&|]+)/.exec(command)
  if (sed !== null) add('in-place edit', sed[1])
  const perl = /\bperl\s+-i\s+([^\s;&|]+)/.exec(command)
  if (perl !== null) add('in-place edit', perl[1])
  for (const op of ['cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'chmod']) {
    const match = new RegExp(`\\b${op}\\b([^;&|]*)`).exec(command)
    if (match === null) continue
    const args = match[1].split(/\s+/).filter((part) => part !== '' && !part.startsWith('-') && !part.includes('='))
    add(op, args.length > 0 ? args[args.length - 1] : undefined)
  }
  if (/\bgit\s+apply\b/.test(command)) add('git apply')
  if (/\bpatch\b/.test(command)) add('patch')
  if (/\b(npm\s+(install|ci)|pnpm\s+add|yarn\s+add)\b/.test(command)) add('dependency install')
  if (/\b(python3?|node)\b/.test(command) && /\b(open|writeFileSync|writeFile|write_text|to_csv|savefig|fs\.write)/.test(command)) add('inline write')
  const sourceTargets = targets.filter((target) => !isArtifactPath(target))
  const blocked = reasons.length > 0 && (sourceTargets.length > 0 || targets.length < reasons.length)
  return { blocked, reasons, targets }
}

  const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024
  const MAX_EDITABLE_BYTES = 200 * 1024
  /** sessionId -> review { id, sessionId, entries, virtual, submitted, finished, canceled, waiters } */
  const reviews = new Map()
  const reviewWaiters = new Map()
  const audits = new Map()
  let reviewVersion = 0
  let webBridge = null

  const bumpReview = () => {
    reviewVersion += 1
    // The built-in channel has no web consumer; keep the bridge silent so the
    // DSH sidebar stays the only review surface in that mode.
    if (featureFlags.reviewChannel !== 'builtin') webBridge?.publishAll()
  }

  const ensureReview = (sessionId) => {
    let review = reviews.get(sessionId)
    if (review === undefined || review.finished) {
      review = {
        id: `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        waitKey: randomBytes(24).toString('hex'),
        sessionId,
        title: '',
        createdAt: Date.now(),
        entries: new Map(),
        virtual: new Map(),
        submitted: false,
        finished: false,
        canceled: false,
        waiters: [],
      }
      reviews.set(sessionId, review)
    }
    return review
  }

  const hasNotes = (notes) => Array.isArray(notes) && notes.some((note) => note !== null && typeof note === 'object' && typeof note.text === 'string' && note.text.trim() !== '')

  const cleanupReview = (sessionId) => {
    const review = reviews.get(sessionId)
    if (review === undefined) return
    for (const waiter of review.waiters) waiter()
    review.waiters = []
    review.entries.clear()
    reviews.delete(sessionId)
    bumpReview()
  }

  const uniqueReviewName = (base, reviewId) => {
    const taken = new Set()
    for (const review of reviews.values()) {
      if (review.id === reviewId) continue
      if (typeof review.title === 'string' && review.title !== '') taken.add(review.title)
    }
    for (const review of webReviewCatalog) {
      if (review === null || typeof review !== 'object') continue
      const name = typeof review.title === 'string' ? review.title : (typeof review.name === 'string' ? review.name : '')
      if (name !== '') taken.add(name)
    }
    let candidate = base
    let index = 2
    while (taken.has(candidate)) {
      candidate = base + '-' + index
      index += 1
    }
    return candidate.slice(0, 64)
  }

  const stageFileChange = async (session, call) => {
    if (call === null || typeof call !== 'object' || typeof call.id !== 'string' || call.id === '') {
      throw new Error('Invalid review change.')
    }
    let args
    try {
      args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    } catch {
      throw new Error('Invalid review arguments.')
    }
    if (args === null || typeof args !== 'object') throw new Error('Invalid review arguments.')
    const filePath = typeof args.file_path === 'string' ? args.file_path : ''
    if (filePath === '') throw new Error('file_path is required.')

    const cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd()
    const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath)
    const display = insideDir(cwd, absolute) ? path.relative(cwd, absolute) : absolute

    const review = ensureReview(session.id)
    if (review.title === '') {
      const requested = typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
      const fallback = display.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase()
      const slug = (requested || fallback).replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      review.title = uniqueReviewName((slug.startsWith('review-') ? slug : 'review-' + (slug || 'change')).slice(0, 64), review.id)
    }
    let entry = review.entries.get(absolute)
    if (entry === undefined) {
      let before = ''
      let exists = false
      let warning
      let tooLarge = false
      try {
        const info = await fs.stat(absolute)
        if (info.isFile()) {
          exists = true
          if (info.size > MAX_REVIEW_FILE_BYTES) {
            tooLarge = true
            warning = 'This file is too large to preview; its change is reviewed without a diff.'
          } else {
            before = await fs.readFile(absolute, 'utf8')
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') warning = `Cannot read the current file: ${String(error)}`
      }
      entry = {
        id: absolute,
        callId: call.id,
        tool: call.name,
        path: absolute,
        display,
        isNew: !exists,
        tooLarge,
        before,
        after: before,
        warning,
        added: 0,
        removed: 0,
        truncated: false,
        hunks: [],
        notes: [],
        editable: false,
        canApply: true,
        updatedAt: Date.now(),
        decision: null,
        callIds: [call.id],
        round: 1,
        roundKey: activeTurns.get(session.id) ?? 0,
        roundBaseAfter: null,
        roundHunks: [],
        roundAdded: 0,
        roundRemoved: 0,
        roundPending: false,
        roundUnread: false,
      }
      review.entries.set(absolute, entry)
    } else if (Array.isArray(entry.callIds)) {
      entry.callIds.push(call.id)
    }

    if (call.name === 'edit') {
      if (entry.isNew) {
        throw new Error(`Cannot queue the edit to "${display}": the file does not exist. Use review_write with the full content.`)
      }
      if (entry.tooLarge === true) {
        throw new Error(`Cannot queue the edit to "${display}": the file is too large to edit through the review gate. Use review_write with the full content.`)
      }
    }

    const turn = activeTurns.get(session.id) ?? 0
    if (entry.roundKey !== turn) {
      entry.roundKey = turn
      entry.roundBaseAfter = entry.after
      entry.roundPending = true
    }
    if (call.name === 'write') {
      entry.after = typeof args.content === 'string' ? args.content : ''
    } else if (call.name === 'edit') {
      const oldString = typeof args.old_string === 'string' ? args.old_string : ''
      const newString = typeof args.new_string === 'string' ? args.new_string : ''
      if (oldString === '') throw new Error(`Cannot queue the edit to "${display}": old_string is empty.`)
      const matches = countOccurrences(entry.after, oldString)
      if (matches === 0) {
        throw new Error(`Cannot queue the edit to "${display}": old_string was not found in the current queued content. Read the file and try again.`)
      }
      if (matches > 1 && args.replace_all !== true) {
        throw new Error(`Cannot queue the edit to "${display}": old_string matches ${matches} places; set replace_all or use a more specific old_string.`)
      }
      entry.after = args.replace_all === true
        ? entry.after.split(oldString).join(newString)
        : replaceFirst(entry.after, oldString, newString)
    } else {
      throw new Error(`Unsupported review change: ${String(call.name)}`)
    }

    if (entry.roundPending === true && entry.roundBaseAfter !== null && entry.after !== entry.roundBaseAfter) {
      entry.round += 1
      entry.roundPending = false
    }
    entry.tool = call.name
    entry.updatedAt = Date.now()
    entry.decision = null
    const binary = entry.before.includes('\u0000') || entry.after.includes('\u0000')
    if (binary || entry.after.length > MAX_REVIEW_FILE_BYTES) {
      entry.warning = entry.warning ?? (binary
        ? 'Binary file: preview unavailable.'
        : 'The resulting file is too large to preview.')
      entry.added = 0
      entry.removed = 0
      entry.truncated = false
      entry.hunks = []
      entry.editable = false
    } else {
      const diff = computeDiff(entry.before, entry.after)
      entry.added = diff.added
      entry.removed = diff.removed
      entry.truncated = diff.truncated
      entry.hunks = diff.hunks
      entry.editable = entry.before.length <= MAX_EDITABLE_BYTES && entry.after.length <= MAX_EDITABLE_BYTES
    }
    if (binary !== true && entry.round > 1 && entry.roundBaseAfter !== null && entry.after !== entry.roundBaseAfter) {
      const roundDiff = computeDiff(entry.roundBaseAfter, entry.after)
      entry.roundAdded = roundDiff.added
      entry.roundRemoved = roundDiff.removed
      entry.roundHunks = roundDiff.hunks
      entry.roundUnread = true
    } else if (entry.round === 1) {
      entry.roundHunks = []
    }
    entry.notes = normalizeNotes(args.notes)
    bumpReview()
    return { review, entry }
  }

  const reviewResults = (review) => {
    if (review.canceled === true) return { status: 'canceled', files: [] }
    if (review.finished !== true) return { status: 'open', files: [] }
    const files = []
    for (const entry of review.entries.values()) {
      if (entry.applyError !== undefined) {
        files.push({ path: entry.display, outcome: 'failed', error: entry.applyError })
      } else if (entry.outcome === 'rejected') {
        files.push({
          path: entry.display,
          outcome: 'rejected',
          comment: entry.decision?.comment ?? '',
        })
      } else if (entry.outcome === 'edited') {
        files.push({ path: entry.display, outcome: 'edited' })
      } else {
        files.push({ path: entry.display, outcome: 'applied' })
      }
    }
    return { status: 'finished', files }
  }

  const applyReview = async (review) => {
    for (const entry of review.entries.values()) {
      if (entry.outcome === 'rejected') continue
      const content = typeof entry.editedAfter === 'string' ? entry.editedAfter : entry.after
      try {
        await fs.mkdir(path.dirname(entry.path), { recursive: true })
        await fs.writeFile(entry.path, content, 'utf8')
        entry.applied = true
      } catch (error) {
        entry.applyError = String(error)
      }
    }
  }

  const waitForReviewFinish = (review, signal) => {
    if (review.finished === true) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', done)
        resolve()
      }
      review.waiters.push(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  const serializeReview = (review) => ({
    id: review.id,
    sessionId: review.sessionId,
    title: review.title ?? '',
    createdAt: review.createdAt,
    submitted: review.submitted === true,
    applying: review.applying === true,
    finished: review.finished === true,
    canceled: review.canceled === true,
    entries: [...review.entries.values()].map((entry) => ({
      id: entry.id,
      callId: entry.callId,
      updatedAt: entry.updatedAt,
      tool: entry.tool,
      path: entry.path,
      display: entry.display,
      isNew: entry.isNew,
      warning: entry.warning ?? null,
      added: entry.added,
      removed: entry.removed,
      truncated: entry.truncated,
      hunks: entry.hunks,
      notes: Array.isArray(entry.notes) ? entry.notes : [],
      editable: entry.editable === true,
      canApply: entry.canApply !== false,
      beforeText: entry.editable === true ? entry.before : null,
      afterText: entry.editable === true ? entry.after : null,
      round: entry.round ?? 1,
      roundUnread: entry.roundUnread === true,
      roundAdded: entry.roundAdded ?? 0,
      roundRemoved: entry.roundRemoved ?? 0,
      roundHunks: Array.isArray(entry.roundHunks) ? entry.roundHunks : [],
      decision: entry.decision,
    })),
  })

  // --------------------------------------------------- review chat ---
  // Web chat is appended to the live main Agent as a user turn, so it reuses
  // the session cache and can queue changes into the open review. No fork and
  // no sidecar copy of the project context.
  let webReviewCatalog = []
  const chatQueue = []
  let activeChat = null

  const chatError = (requestId, message) => {
    webBridge?.send({ type: 'chat.error', requestId, message: String(message) })
  }

  const extractChatText = (event) => {
    const message = event.data?.message ?? event.data
    const content = message?.content ?? event.data?.content
    if (Array.isArray(content)) {
      return content
        .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
    }
    return typeof message?.text === 'string' ? message.text : ''
  }

  const compactReview = (review) => ({
    id: review.id,
    title: review.title ?? review.name ?? review.id,
    sessionId: review.sessionId,
    submitted: review.submitted === true,
    finished: review.finished === true,
    canceled: review.canceled === true,
    entries: (Array.isArray(review.entries) ? review.entries : []).slice(0, 20).map((entry) => ({
      display: entry.display,
      tool: entry.tool,
      isNew: entry.isNew,
      added: entry.added,
      removed: entry.removed,
      warning: entry.warning,
      notes: entry.notes,
      hunks: Array.isArray(entry.hunks) ? entry.hunks.slice(0, 20) : [],
    })),
  })

  const reviewById = () => {
    const byId = new Map()
    for (const review of reviews.values()) byId.set(review.id, compactReview(serializeReview(review)))
    for (const review of webReviewCatalog) {
      if (review !== null && typeof review === 'object' && typeof review.id === 'string' && !byId.has(review.id)) byId.set(review.id, review)
    }
    return byId
  }

  const reviewIndex = () => [...reviewById().values()].slice(0, 50).map((review) => ({
    name: review.title ?? review.name ?? review.id,
    id: review.id,
    sessionId: review.sessionId,
    status: review.canceled === true ? 'canceled' : review.finished === true ? 'finished' : review.submitted === true ? 'submitted' : 'open',
    files: (Array.isArray(review.entries) ? review.entries : []).map((entry) => entry.display),
  }))

  const referencedDetails = (text) => {
    const names = new Set((String(text).match(/review-[a-z0-9-]+/gi) ?? []).map((name) => name.toLowerCase()))
    if (names.size === 0) return []
    return [...reviewById().values()].filter((review) => names.has(String(review.title ?? review.name ?? review.id).toLowerCase()))
  }

  const buildChatMessage = (text) => {
    const details = referencedDetails(text)
    const payload = [
      '[Review chat from the standalone web review app]',
      'This is a user question about the reviews. Answer using the full session and project context.',
      '',
      'Review index:',
      JSON.stringify(reviewIndex(), null, 2),
      '',
      'Referenced review details:',
      JSON.stringify(details, null, 2),
      '',
      'Question:',
      text,
      '',
      'Rules:',
      '- Do not finish, approve or reject the review. The user decides in the review UI.',
      '- If the user asks for changes, queue them into the open review with review_write/review_patch.',
      '- Do not call review_wait.',
      '- Use read/grep/glob for project files when needed; keep the answer concise.',
    ].join('\n')
    const clipped = payload.length > 120000 ? payload.slice(0, 120000) + '\n[review chat context truncated]' : payload
    return { id: 'review-chat-' + randomBytes(8).toString('hex'), role: 'user', content: [{ type: 'text', text: clipped }], source: { kind: 'user' } }
  }

  const pickAgent = (sessionId) => {
    const list = typeof ctx.agents?.list === 'function' ? ctx.agents.list().filter((agent) => !isSubagent(agent)) : []
    if (sessionId !== '') {
      const exact = list.find((agent) => agent.id === sessionId)
      if (exact !== undefined) return exact
    }
    return list[0]
  }

  const finishChat = () => {
    const active = activeChat
    if (active === null || active.waitingForTurn === true) return
    activeChat = null
    const text = typeof active.pendingText === 'string' ? active.pendingText.trim() : ''
    if (text === '') chatError(active.requestId, 'The main agent returned no text.')
    else webBridge?.send({ type: 'chat.message', requestId: active.requestId, role: 'assistant', text })
    const next = chatQueue.shift()
    if (next !== undefined) startChat(next)
  }

  const startChat = (request) => {
    if (activeChat !== null) {
      chatQueue.push(request)
      return
    }
    const agent = pickAgent(request.sessionId)
    if (agent === undefined) {
      chatError(request.requestId, 'No live DSH session is available for review chat.')
      return
    }
    activeChat = { requestId: request.requestId, sessionId: agent.id, pendingText: '', waitingForTurn: true }
    try {
      agent.followup(buildChatMessage(request.text))
    } catch (error) {
      activeChat = null
      chatError(request.requestId, String(error))
    }
  }

  const handleGlobalChat = (message) => {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : ''
    const text = typeof message?.text === 'string' ? message.text.trim() : ''
    const sessionId = typeof message?.sessionId === 'string' ? message.sessionId : ''
    if (text === '') { chatError(requestId, 'Write a question first.'); return }
    if (text.length > 8000) { chatError(requestId, 'Keep the question under 8000 characters.'); return }
    const request = { requestId, text, sessionId }
    if (activeChat !== null) { chatQueue.push(request); return }
    startChat(request)
  }

  ctx.on('session/event', (session, event) => {
    if (activeChat === null || session.id !== activeChat.sessionId) return
    if (event.type === 'turn/start') {
      if (activeChat.waitingForTurn === true) {
        activeChat.waitingForTurn = false
        activeChat.turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : undefined
      }
      return
    }
    if (event.type === 'assistant/message') {
      if (activeChat.waitingForTurn === true) return
      const text = extractChatText(event)
      if (text.trim() !== '') activeChat.pendingText = text
      return
    }
    if (event.type === 'turn/end') {
      if (activeChat.waitingForTurn === true) return
      finishChat()
    }
  })

  webBridge = createWebBridge({
    getConfig: () => ({ url: featureFlags.webUrl, token: featureFlags.webDeviceToken, deviceId: featureFlags.webDeviceId }),
    saveConfig: (config) => {
      if (typeof config.url === 'string') featureFlags.webUrl = config.url
      if (typeof config.token === 'string') featureFlags.webDeviceToken = config.token
      if (typeof config.deviceId === 'string') featureFlags.webDeviceId = config.deviceId
      saveFeatureFlags()
    },
    isEnabled: () => featureFlags.reviewChannel !== 'builtin',
    serializeReview,
    getReviews: () => [...reviews.values()],
    getVersion: () => reviewVersion,
    pluginVersion: PLUGIN_VERSION,
    onChat: (message) => handleGlobalChat(message),
    onCatalog: (message) => { webReviewCatalog = Array.isArray(message?.reviews) ? message.reviews : [] },
    onDecision: (message) => {
      const result = decideReview(message.reviewId, message.decisions)
      if (result.ok !== true) {
        webBridge.send({ type: 'review.result', reviewId: message.reviewId, results: [], error: result.error ?? result.message ?? 'decision failed' })
      }
    },
  })
  // 'builtin' means DSH's own review UI only; do not open the outbound WSS.
  if (featureFlags.reviewChannel !== 'builtin') webBridge.start()

  const decideReview = (id, decisions) => {
    const review = [...reviews.values()].find((candidate) => candidate.id === id)
    if (review === undefined) return fail('review-not-found', 'This review is no longer open')
    if (review.finished) return fail('review-finished', 'This review was already finished')
    if (review.submitted !== true) return fail('not-submitted', 'The agent has not submitted this review yet')
    const byEntry = new Map()
    for (const decision of Array.isArray(decisions) ? decisions : []) {
      if (decision !== null && typeof decision === 'object' && typeof decision.entryId === 'string') {
        byEntry.set(decision.entryId, decision)
      }
    }
    const entries = [...review.entries.values()]
    const missing = []
    const tooLarge = []
    const stale = []
    const normalized = new Map()
    for (const entry of entries) {
      const decision = byEntry.get(entry.id)
      if (decision !== undefined && decision !== null && typeof decision.baseAfterText === 'string' && entry.editable === true && entry.after !== decision.baseAfterText) {
        stale.push(entry.display)
        continue
      }
      if (decision !== undefined && decision.outcome === 'edited') {
        const text = decision.editedAfter
        if (entry.editable !== true || typeof text !== 'string' || text === entry.after) {
          missing.push(entry.display)
          continue
        }
        if (text.length > MAX_EDITABLE_BYTES * 2) {
          tooLarge.push(entry.display)
          continue
        }
        normalized.set(entry.id, { outcome: 'edited', editedAfter: text, comment: typeof decision.comment === 'string' ? decision.comment.slice(0, 4000) : '' })
        continue
      }
      if (decision === undefined || typeof decision.approved !== 'boolean') {
        missing.push(entry.display)
        continue
      }
      normalized.set(entry.id, {
        outcome: decision.approved === true ? 'approved' : 'rejected',
        comment: typeof decision.comment === 'string' ? decision.comment.slice(0, 4000) : '',
      })
    }
    if (missing.length > 0) return fail('incomplete', `No decision for: ${missing.join(', ')}`)
    if (tooLarge.length > 0) return fail('edit-too-large', `The edited content is too large for: ${tooLarge.join(', ')}`)
    if (stale.length > 0) return fail('stale', `The file changed while you were reviewing: ${stale.join(', ')}. Reopen the review and decide again.`)

    for (const entry of entries) {
      const decision = normalized.get(entry.id)
      entry.outcome = decision.outcome
      entry.decision = {
        outcome: decision.outcome,
        approved: decision.outcome === 'approved',
        edited: decision.outcome === 'edited',
        comment: decision.comment,
      }
      entry.roundUnread = false
      if (decision.outcome === 'edited') entry.editedAfter = decision.editedAfter
    }
    review.applying = true
    bumpReview()
    void applyReview(review).then(() => {
      review.applying = false
      review.finished = true
      for (const waiter of review.waiters) waiter()
      review.waiters = []
      bumpReview()
    }).catch((error) => {
      review.applying = false
      review.finished = true
      review.applyError = String(error)
      for (const waiter of review.waiters) waiter()
      review.waiters = []
      bumpReview()
    })
    return ok({ reviewId: review.id, applying: true })
  }

  const parsePatchHeaderPath = (line) => {
    let rest = line.slice(4).trim()
    if (rest.startsWith('"')) {
      let out = ''
      let index = 1
      for (; index < rest.length; index += 1) {
        const char = rest[index]
        if (char === '\\' && index + 1 < rest.length) {
          out += rest[index + 1]
          index += 1
          continue
        }
        if (char === '"') break
        out += char
      }
      return out
    }
    const tab = rest.indexOf('\t')
    if (tab >= 0) rest = rest.slice(0, tab)
    return rest.trim()
  }

  const stagePatch = async (session, exec, patch, notes, name) => {
    if (typeof patch !== 'string' || patch.trim() === '') throw new Error('patch is required.')
    if (patch.length > MAX_REVIEW_FILE_BYTES) throw new Error('The patch is too large for the review gate.')
    const cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd()
    const lines = patch.split(/\r?\n/)
    const pairs = []
    let pendingOld
    for (const line of lines) {
      if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
        throw new Error('Binary patches are not supported; use review_write.')
      }
      if (line.startsWith('rename from ') || line.startsWith('rename to ') || line.startsWith('copy from ') || line.startsWith('copy to ')) {
        throw new Error('Renames and copies are not supported; use review_write for the new path.')
      }
      if (line.startsWith('--- ')) {
        pendingOld = parsePatchHeaderPath(line)
      } else if (line.startsWith('+++ ')) {
        if (pendingOld === undefined) throw new Error('Malformed patch: "+++" without a preceding "---".')
        pairs.push({ oldPath: pendingOld, newPath: parsePatchHeaderPath(line) })
        pendingOld = undefined
      }
    }
    if (pairs.length === 0) throw new Error('The patch has no file headers (---/+++).')

    const prefixed = pairs.every((pair) =>
      (pair.oldPath === '/dev/null' || /^[ab]\//.test(pair.oldPath))
      && (pair.newPath === '/dev/null' || /^[ab]\//.test(pair.newPath)))
    const anyPrefixed = pairs.some((pair) =>
      (pair.oldPath !== '/dev/null' && /^[ab]\//.test(pair.oldPath))
      || (pair.newPath !== '/dev/null' && /^[ab]\//.test(pair.newPath)))
    if (anyPrefixed && !prefixed) {
      throw new Error('Use a/ and b/ prefixes on every path or omit them everywhere.')
    }
    const strip = prefixed ? 1 : 0
    const normalize = (raw) => {
      if (raw === '/dev/null') return null
      let value = raw
      if (strip === 1) value = value.replace(/^[ab]\//, '')
      if (value === '' || value.startsWith('/')) throw new Error(`Unsupported patch path: ${raw}`)
      const absolute = path.resolve(cwd, value)
      if (!insideDir(cwd, absolute)) throw new Error(`Patch path escapes the working directory: ${raw}`)
      return { absolute, relative: path.relative(cwd, absolute).split(path.sep).join('/') }
    }

    const targets = new Map()
    for (const pair of pairs) {
      const oldTarget = normalize(pair.oldPath)
      const newTarget = normalize(pair.newPath)
      if (newTarget === null) {
        throw new Error('Deleting files is not supported in review_patch; reject the change or use review_write for the new content.')
      }
      if (oldTarget !== null && oldTarget.relative !== newTarget.relative) {
        throw new Error('Renaming files is not supported in review_patch; use review_write for the new path.')
      }
      targets.set(newTarget.relative, { ...newTarget, newFile: oldTarget === null })
    }

    if (featureFlags.aiExplain === true) {
      const missing = []
      for (const target of targets.values()) {
        const covered = Array.isArray(notes) && notes.some((note) => {
          if (note === null || typeof note !== 'object') return false
          if (typeof note.text !== 'string' || note.text.trim() === '') return false
          const rawPath = typeof note.path === 'string' ? note.path.replace(/^[ab]\//, '').replace(/^\.\//, '') : ''
          return rawPath === '' ? targets.size === 1 : rawPath === target.relative
        })
        if (!covered) missing.push(target.relative)
      }
      if (missing.length > 0) {
        throw new Error(`AI explanations are on: add at least one note for each changed file. Missing: ${missing.join(', ')}. Turn off AI explanations in the input bar to queue without notes.`)
      }
    }
    const review = ensureReview(session.id)
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ce-patch-'))
    try {
      for (const target of targets.values()) {
        if (target.newFile) continue
        const filePath = path.join(tmp, target.relative)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const existing = review.entries.get(target.absolute)
        let content
        if (existing !== undefined) {
          content = existing.after
        } else {
          try {
            content = await fs.readFile(target.absolute, 'utf8')
          } catch (error) {
            if (error.code === 'ENOENT') throw new Error(`The patch targets a file that does not exist: ${target.relative}`)
            throw error
          }
        }
        await fs.writeFile(filePath, content, 'utf8')
      }
      const diffStarts = []
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].startsWith('diff --git ')) diffStarts.push(index)
      }
      let sections
      if (diffStarts.length > 0) {
        sections = diffStarts.map((start, index) => lines.slice(start, diffStarts[index + 1] ?? lines.length).join('\n').replace(/\n+$/, '') + '\n')
      } else {
        const starts = []
        for (let index = 0; index < lines.length - 1; index += 1) {
          if (lines[index].startsWith('--- ') && lines[index + 1].startsWith('+++ ')) starts.push(index)
        }
        sections = starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n').replace(/\n+$/, '') + '\n')
      }
      if (sections.length === 0) throw new Error('The patch has no hunks to apply.')
      const gitDir = path.join(tmp, '.git')
      await runGit(['init', '-q'], { gitDir, workTree: tmp })
      for (let index = 0; index < sections.length; index += 1) {
        const sectionPath = path.join(tmp, `.dsh-review-${index}.patch`)
        await fs.writeFile(sectionPath, sections[index], 'utf8')
        await runGit(['apply', `-p${strip}`, '--recount', '--whitespace=nowarn', sectionPath], { gitDir, workTree: tmp })
      }
      const staged = []
      for (const target of targets.values()) {
        staged.push({
          target,
          content: await fs.readFile(path.join(tmp, target.relative), 'utf8'),
        })
      }
      const files = []
      for (const { target, content } of staged) {
        const targetNotes = Array.isArray(notes)
          ? notes.filter((note) => {
              if (note === null || typeof note !== 'object') return false
              const rawPath = typeof note.path === 'string' ? note.path.replace(/^[ab]\//, '').replace(/^\.\//, '') : ''
              if (rawPath !== '') return rawPath === target.relative
              return targets.size <= 1
            })
          : []
        const queued = await stageFileChange(session, {
          id: exec.callId,
          name: 'write',
          arguments: { file_path: target.absolute, content, notes: targetNotes, name },
        })
        files.push(queued.entry.display)
      }
      return { files, review, session: session }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  const ensureReviewWaiter = async (session, review, exec) => {
    const subagents = ctx.subagents
    if (subagents === undefined) return { started: false, reason: 'subagents-service-unavailable' }
    const prompt = `You are the persistent review waiter for this conversation. Call review_wait with {"reviewId":"${review.id}","waitKey":"${review.waitKey}"} and wait. When it returns, report the per-file outcomes in a compact list; do not edit files, do not start reviews, and stay ready for the next review message.`
    const existing = reviewWaiters.get(session.id)
    if (existing !== undefined) {
      try {
        await subagents.sendMessage(exec.agent, existing, [{ type: 'text', text: prompt }], { signal: exec.signal })
        return { started: true, childId: existing, reused: true }
      } catch {
        reviewWaiters.delete(session.id)
      }
    }
    // 1) The agent-scoped subagent tool: it knows the provider and the exact
    //    parent, and returns the child id.
    const scopedTool = ctx.tools.get('subagent', exec.scope)
    if (scopedTool !== undefined) {
      try {
        const result = await scopedTool.execute({ description: 'Review waiter', prompt }, exec)
        const childId = result?.subagentId ?? result?.childId
        if (typeof childId === 'string' && childId !== '') {
          reviewWaiters.set(session.id, childId)
          return { started: true, childId, reused: false }
        }
      } catch {
        // fall through to the direct provider path
      }
    }
    // 2) Direct provider path; the in-process spawn backend names itself "spawn".
    const providers = typeof subagents.listProviders === 'function' ? subagents.listProviders() : []
    const provider = Array.isArray(providers) && providers.length > 0 ? providers[0] : 'spawn'
    try {
      const activation = await subagents.startActivation({
        provider,
        label: 'Review waiter',
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: exec.agent,
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      const childId = activation?.childId
      if (typeof childId === 'string' && childId !== '') {
        reviewWaiters.set(session.id, childId)
        return { started: true, childId, reused: false }
      }
      return { started: false, reason: 'no-child-id' }
    } catch (error) {
      return { started: false, reason: String(error) }
    }
  }



  const registerReviewTools = () => {
    ctx.tools.register(defineTool({
      name: 'review_write',
      description: 'Queue a new file or a full-file rewrite for the user\'s review. This does not write the file: the change is held in the Code review tab until the user finishes. Use review_patch for edits to existing files. At least one notes entry per changed file is required while AI explanations are on; prefer line-level notes (line/hunk) for user-requested, key or hard-to-understand changes. Each note is 1-2 sentences explaining why. The plugin starts or reuses the review waiter automatically; just queue and continue, and never call review_wait from the main agent.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to write, resolved like the write tool.' },
        content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
        name: { type: 'string', description: 'Short review-group name in review-xxxx kebab-case, based on the change content.' },
        notes: {
          type: 'array',
          description: 'Optional 1-2 sentence explanations for groups of added lines.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line: { type: 'integer', description: '1-based new-file line inside the added group (recommended).' },
              hunk: { type: 'integer', description: '1-based hunk index when the line is not known.' },
              text: { type: 'string', required: true, description: 'Why this group changed.' },
            },
          },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) return 'No active session.'
        if (featureFlags.review !== true) return 'The review gate is off. Use the write tool instead.'
        if (featureFlags.aiExplain === true && !hasNotes(args.notes)) {
          throw new Error('AI explanations are on: add at least one note for this file. Use line-level notes for user-requested, key or hard-to-understand changes. Turn off AI explanations in the input bar to queue without notes.')
        }
        const queued = await stageFileChange(session, { id: exec.callId, name: 'write', arguments: { file_path: args.file_path, content: args.content, notes: args.notes, name: args.name } })
        if (queued === undefined) return 'Could not queue this change (missing or invalid file_path).'
        const waiter = await ensureReviewWaiter(session, queued.review, exec)
        if (waiter.started === true) return `Queued for review: ${queued.entry.display} (${queued.review.entries.size} file(s) queued). Nothing is written until the user finishes. A review waiter is running; continue or end your turn and it will wake you.`
        return `Queued for review: ${queued.entry.display} (${queued.review.entries.size} file(s) queued). Nothing is written until the user finishes. reviewId: ${queued.review.id}; waitKey: ${queued.review.waitKey}; start or send the persistent review waiter and continue; do not call review_wait from the main agent. (${waiter.reason})`
      },
    }), { when: () => featureFlags.review === true && featureFlags.autoReview === true })

    ctx.tools.register(defineTool({
      name: 'review_patch',
      description: 'Queue a unified diff for the user\'s review. The patch must use ---/+++ headers and @@ hunks with paths relative to the working directory; a/ and b/ prefixes and diff --git headers are accepted. Use one patch per file when possible; multiple files are allowed. This does not modify the workspace: the change is held in the Code review tab until the user finishes. At least one notes entry per changed file is required while AI explanations are on; prefer line-level notes (line/hunk) for user-requested, key or hard-to-understand changes. Each note is 1-2 sentences explaining why. The plugin starts or reuses the review waiter automatically; just queue and continue, and never call review_wait from the main agent. Example:\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,7 +10,9 @@\n   const app = createApp()\n-  app.use(oldRouter)\n+  app.use(newRouter)\n+  app.use(logger)\n   app.listen(3000)',
      parameters: {
        patch: { type: 'string', required: true, description: 'A unified diff (---/+++/@@) to queue for review.' },
        name: { type: 'string', description: 'Short review-group name in review-xxxx kebab-case, based on the change content.' },
        notes: {
          type: 'array',
          description: 'Optional 1-2 sentence explanations for groups of added lines.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'File path this note belongs to when the patch touches several files.' },
              line: { type: 'integer', description: '1-based new-file line inside the added group (recommended).' },
              hunk: { type: 'integer', description: '1-based hunk index when the line is not known.' },
              text: { type: 'string', required: true, description: 'Why this group changed.' },
            },
          },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) return 'No active session.'
        if (featureFlags.review !== true) return 'The review gate is off. Use apply_patch or edit instead.'
        const queued = await stagePatch(session, exec, args.patch, args.notes, args.name)
        const waiter = await ensureReviewWaiter(session, queued.review, exec)
        if (waiter.started === true) return `Queued for review: ${queued.files.join(', ')} (${queued.review.entries.size} file(s) in this review). Nothing is written until the user finishes. A review waiter is running; continue or end your turn and it will wake you.`
        return `Queued for review: ${queued.files.join(', ')} (${queued.review.entries.size} file(s) in this review). Nothing is written until the user finishes. reviewId: ${queued.review.id}; waitKey: ${queued.review.waitKey}; start or send the persistent review waiter and continue; do not call review_wait from the main agent. (${waiter.reason})`
      },
    }), { when: () => featureFlags.review === true && featureFlags.autoReview === true })

    ctx.tools.register(defineTool({
      name: 'review_wait',
      description: 'Wait for a review. Only a review waiter subagent should call this: pass the reviewId and waitKey from review_write/review_patch. The main agent must not call it; if it does, the call is refused so the turn never blocks. Returns one structured result per file: applied, rejected (with the user\'s comment), edited, or failed.',
      parameters: {
        reviewId: { type: 'string', description: 'Review id returned by review_write/review_patch.' },
        waitKey: { type: 'string', description: 'Wait key returned by the same tool result.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string' },
            message: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  outcome: { type: 'string' },
                  comment: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) return { status: 'open', files: [] }
        const reviewId = typeof args?.reviewId === 'string' && args.reviewId !== '' ? args.reviewId : undefined
        const waitKey = typeof args?.waitKey === 'string' && args.waitKey !== '' ? args.waitKey : undefined
        let review
        if (reviewId !== undefined) {
          review = [...reviews.values()].find((candidate) => candidate.id === reviewId)
          if (review === undefined) return { status: 'not-found', files: [] }
          if (review.waitKey !== waitKey) return { status: 'forbidden', files: [] }
        } else {
          review = reviews.get(session.id)
          if (review === undefined || review.entries.size === 0) return { status: 'empty', files: [] }
        }
        if (review.sessionId === session.id && featureFlags.allowBlockingReviewWait !== true) {
          return {
            status: 'blocked',
            files: [],
            message: 'The main agent must not call review_wait: start a review waiter subagent with the reviewId and waitKey (or send them to the existing persistent waiter) and continue; only the child may wait. If delegation is unavailable, the user can enable allowBlockingReviewWait in settings.',
          }
        }
        if (review.submitted !== true) {
          review.submitted = true
          bumpReview()
        }
        await waitForReviewFinish(review, exec.signal)
        return reviewResults(review)
      },
    }), { when: () => featureFlags.review === true && featureFlags.autoReview === true })
  }

  const execShell = (command, cwd) => new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1), stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })

  const registerBashTool = () => {
    ctx.tools.register(defineTool({
      name: 'review_bash',
      description: 'Run a shell command for inspection or tests. The first call does not execute: it returns the write-detection result and asks you to self-check whether the command creates, modifies or deletes files. If it does, use review_write / review_patch instead. If it does not, call again with confirmed:true. The second call re-checks, then runs /bin/sh -c. Build/test artifacts under dist, build, node_modules and similar directories are allowed; writes to source are blocked.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command to run.' },
        confirmed: { type: 'boolean', description: 'Set true only after you have checked that the command does not create, modify or delete source files.' },
        cwd: { type: 'string', description: 'Optional working directory; defaults to the session workspace.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string' },
            command: { type: 'string' },
            writes: { type: 'boolean' },
            reasons: { type: 'array', items: { type: 'string' } },
            exitCode: { type: 'integer' },
            stdout: { type: 'string' },
            stderr: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) return { status: 'error', command: '', writes: false, message: 'No active session.' }
        const command = typeof args?.command === 'string' ? args.command : ''
        if (command.trim() === '') return { status: 'error', command, writes: false, message: 'command is required.' }
        const base = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd()
        const cwd = typeof args?.cwd === 'string' && args.cwd !== '' ? path.resolve(base, args.cwd) : base
        const detection = detectShellWrites(command, cwd)
        if (args?.confirmed !== true) {
          return {
            status: 'confirm',
            command,
            writes: detection.blocked,
            reasons: detection.reasons,
            message: detection.blocked
              ? 'This command appears to write source files. Use review_write / review_patch for file changes.'
              : 'Self-check: does this command create, modify or delete files? If yes, use review_write / review_patch. If no, call review_bash again with confirmed:true.',
          }
        }
        if (detection.blocked === true) {
          return {
            status: 'blocked',
            command,
            writes: true,
            reasons: detection.reasons,
            message: 'Write detection blocked this command. Use review_write / review_patch for file changes.',
          }
        }
        const result = await execShell(command, cwd)
        return {
          status: result.code === 0 ? 'ok' : 'error',
          command,
          writes: false,
          reasons: detection.reasons,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        }
      },
    }), { when: () => featureFlags.review === true && featureFlags.autoReview === true })
  }

  registerReviewTools()
  registerBashTool()

  const nativeGate = async (exec, next) => {
    if (featureFlags.review !== true || featureFlags.autoReview !== true) return next()
    if (exec.name === 'bash') {
      return {
        kind: 'deny',
        reason: 'Use review_bash for shell commands while Pre-review is on. It self-checks writes and asks for a second confirmation; file changes must use review_write / review_patch. Do not use bash to write files.',
      }
    }
    if (!REVIEW_TOOLS.has(exec.name)) return next()
    return {
      kind: 'deny',
      reason: 'File changes must go through the review gate while Pre-review is on. Use review_write (new file / full file) or review_patch (unified diff) with at least one note per changed file; the plugin starts or reuses the review waiter automatically; just continue. Never call review_wait from the main agent. Run shell commands with review_bash.',
    }
  }

  ctx.on('tools/pre-execute', nativeGate, { prepend: true })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'tool:review-gate',
      order: 110,
      text: () => featureFlags.review === true && featureFlags.autoReview === true
        ? '🎟️ FILE-EDIT VELVET ROPE: The human personally reviews every file change. Read with read; change files with review_write (new file / full file) or review_patch (unified diff); run commands with review_bash. Do not use write/edit/apply_patch/str_replace_editor. Never use bash to write files: review_bash first returns the write-detection result, you self-check whether the command creates/modifies/deletes files, and only a second call with confirmed:true runs it when it writes no source files. Name each review group with name="review-xxxx" based on the change content. Include at least one note per changed file while AI explanations are on; add line-level notes for user-requested, key or hard-to-understand changes (no upper limit). The plugin starts or reuses the review waiter automatically: after queueing, just continue or end the turn; never call review_wait and do not manage a subagent. If a file is rejected, read the comment and revise. This is house rules. 💅'
        : '',
    }), 'coding-enhanced: review prompt')
  })

  const runAudit = async (session, turn) => {
    try {
      const snapshot = snapshotOf(session.id, turn)
      if (snapshot === undefined) return
      const cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd()
      const review = reviews.get(session.id)
      const reviewed = review === undefined ? [] : [...review.entries.values()].map((entry) => entry.display)
      const base = await captureWorkspace(session.id, cwd)
      if (base === undefined) return
      const diff = await runGit(['diff', '--name-status', snapshot.tree, base.tree], { gitDir: snapshot.gitDir, workTree: cwd })
      const changed = diff.split('\n').map((line) => line.trim()).filter((line) => line !== '').map((line) => {
        const parts = line.split('\t')
        return parts.length >= 2 ? parts[parts.length - 1] : ''
      }).filter((value) => value !== '')
      const outside = changed.filter((file) => !reviewed.includes(file) && !isArtifactPath(file))
      audits.set(session.id, {
        turn,
        outside,
        reviewed,
        artifacts: changed.filter((file) => isArtifactPath(file)),
        at: Date.now(),
      })
      bumpReview()
    } catch (error) {
      ctx.logger?.warn?.(`coding-enhanced: audit failed: ${String(error)}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const cwd = session.header?.cwd
      if (typeof cwd !== 'string' || cwd === '' || isSubagent(session)) return
      const turn = event.data?.turn
      activeTurns.set(session.id, turn)
      audits.delete(session.id)
      if (featureFlags.withdraw === true) {
        const promise = captureSnapshot(session.id, cwd, turn).catch((error) => {
          ctx.logger?.warn?.(`coding-enhanced: cannot snapshot ${cwd}: ${String(error)}`)
        })
        pendingSnapshots.set(session.id, promise)
        void promise.finally(() => {
          if (pendingSnapshots.get(session.id) === promise) pendingSnapshots.delete(session.id)
        })
      }
      return
    }
    if (event.type === 'turn/end') {
      const turn = event.data?.turn
      void runAudit(session, turn)
      activeTurns.delete(session.id)
      const review = reviews.get(session.id)
      if (review !== undefined) {
        if (review.finished === true) cleanupReview(session.id)
        else if (review.entries.size > 0 && review.submitted !== true) {
          review.submitted = true
          bumpReview()
        }
      }
      const snapshot = snapshotOf(session.id, turn)
      if (snapshot !== undefined) {
        snapshot.endSeq = event.seq
        persistSnapshots(session.id)
      }
    }
  })

  // The first tool of a turn must never mutate files before the snapshot is written.
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const sessionId = exec.agent?.session?.id
      const pending = sessionId === undefined ? undefined : pendingSnapshots.get(sessionId)
      if (pending !== undefined) await pending
      return next()
    },
    { prepend: true },
  )

  ctx.on('session/disposed', (session) => {
    activeTurns.delete(session.id)
    pendingSnapshots.delete(session.id)
    cleanupReview(session.id)
  })

  // ------------------------------------------------------------- inspect ---
  const inspectSession = (session) => {
    const events = session.snapshotEvents()
    let endIndex = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'turn/end') {
        endIndex = index
        break
      }
    }
    if (endIndex < 0) return { latestTurn: undefined, latestMessageIds: [], events }
    const turn = events[endIndex].data.turn
    let startIndex = -1
    for (let index = endIndex; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'turn/start' && event.data.turn === turn) {
        startIndex = index
        break
      }
    }
    if (startIndex < 0) return { latestTurn: turn, latestMessageIds: [], events }
    const ids = new Set()
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const event = events[index]
      if (event.surfaceOp !== 'append' || !SURFACE_TYPES.has(event.type)) continue
      const message = event.type === 'user/message' ? event.data : event.data?.message
      if (typeof message?.id === 'string' && message.id !== '') ids.add(message.id)
    }
    return { latestTurn: turn, latestMessageIds: [...ids], startIndex, endIndex, events }
  }

  const surfaceRange = (session, turn) => {
    const events = session.snapshotEvents()
    // Everything already shadowed by an earlier replacement is not on the surface.
    const shadowed = new Set()
    for (const event of events) {
      const op = event.surfaceOp
      if (op === undefined || typeof op !== 'object' || op.op !== 'replace') continue
      const from = Math.min(op.startSeq, op.endSeq)
      const to = Math.max(op.startSeq, op.endSeq)
      for (let seq = from; seq <= to; seq += 1) shadowed.add(seq)
    }
    let startSeq
    let endSeq
    const seqs = []
    let inside = false
    for (const event of events) {
      if (event.type === 'turn/start' && event.data.turn === turn) {
        inside = true
        continue
      }
      if (event.type === 'turn/end' && event.data.turn === turn) break
      if (!inside) continue
      if (event.surfaceOp !== 'append' || !SURFACE_TYPES.has(event.type)) continue
      if (shadowed.has(event.seq)) continue
      if (startSeq === undefined) startSeq = event.seq
      endSeq = event.seq
      seqs.push(event.seq)
    }
    if (startSeq === undefined || endSeq === undefined) return undefined
    return { startSeq, endSeq, seqs }
  }

  const turnMessageIds = (session, turn) => {
    const events = session.snapshotEvents()
    let inside = false
    const ids = []
    for (const event of events) {
      if (event.type === 'turn/start' && event.data?.turn === turn) {
        inside = true
        continue
      }
      if (event.type === 'turn/end' && event.data?.turn === turn) break
      if (!inside) continue
      if (event.surfaceOp !== 'append' || !SURFACE_TYPES.has(event.type)) continue
      const message = event.type === 'user/message' ? event.data : event.data?.message
      if (typeof message?.id === 'string' && message.id !== '') ids.push(message.id)
    }
    return ids
  }

  const turnEndSeq = (session, turn) => {
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/end' && event.data?.turn === turn) return event.seq
    }
    return undefined
  }

  // ------------------------------------------------------------- restore ---
  const restoreWorktree = (gitDir, cwd, tree) => serialized(`snapshot:${cwd}`, async () => {
      await addAll(gitDir, cwd)
      const current = (await runGit(['write-tree'], { gitDir, workTree: cwd })).trim()
      if (current === tree) return { count: 0, files: [], skipped: [] }

      const raw = await runGit(['diff-tree', '-r', '--name-status', '-z', tree, current], {
        gitDir,
        workTree: cwd,
      })
      const tokens = raw.split('\0')
      const entries = []
      for (let index = 0; index + 1 < tokens.length; index += 2) {
        const status = tokens[index]
        const rel = tokens[index + 1]
        if (status === '' || rel === '') continue
        entries.push({ status: status[0], rel: assertSafeRelative(rel) })
      }

      const modes = new Map()
      const listing = await runGit(['ls-tree', '-r', '-z', tree], { gitDir, workTree: cwd })
      for (const record of listing.split('\0')) {
        if (record === '') continue
        const tab = record.indexOf('\t')
        if (tab < 0) continue
        const meta = record.slice(0, tab).split(' ')
        const rel = record.slice(tab + 1)
        modes.set(rel, meta[0])
      }

      const skipped = []
      const restoredFiles = []
      for (const entry of entries) {
        const absolute = posixJoin(cwd, entry.rel)
        const mode = modes.get(entry.rel)
        // A nested git repository is recorded as a gitlink commit (160000), not
        // as blobs. Its contents are not in this snapshot, so restoring (or
        // deleting) it would fail or destroy the user's repository.
        if (mode === '160000' || existsSync(path.join(absolute, '.git'))) {
          skipped.push(entry.rel)
          continue
        }
        if (entry.status === 'A') {
          await fs.rm(absolute, { recursive: true, force: true })
          restoredFiles.push(entry.rel)
          continue
        }
        const blob = await runGit(['cat-file', 'blob', `${tree}:${entry.rel}`], {
          gitDir,
          workTree: cwd,
          encoding: 'buffer',
        })
        await fs.mkdir(path.dirname(absolute), { recursive: true })
        await fs.rm(absolute, { recursive: true, force: true })
        if (mode === '120000') {
          await fs.symlink(blob.toString('utf8'), absolute)
        } else {
          await fs.writeFile(absolute, blob, { mode: mode === '100755' ? 0o755 : 0o644 })
        }
        restoredFiles.push(entry.rel)
      }

      if (skipped.length > 0) {
        ctx.logger?.warn?.(`coding-enhanced: withdraw left nested git repositories untouched: ${skipped.join(', ')}`)
      }

      // Leave the shared index at the restored tree so the next turn diffs cleanly.
      await runGit(['read-tree', tree], { gitDir, workTree: cwd })
      return { count: restoredFiles.length, files: restoredFiles, skipped }
  })

  const restoreTree = async (snapshot) => {
    const main = await restoreWorktree(snapshot.gitDir, snapshot.cwd, snapshot.tree)
    const nestedSnapshots = Array.isArray(snapshot.nested) ? snapshot.nested : []
    const nestedPaths = new Set(nestedSnapshots.map((nested) =>
      path.relative(snapshot.cwd, nested.cwd).split(path.sep).join('/')))
    let count = main.count
    const files = [...main.files]
    const skipped = main.skipped.filter((rel) => !nestedPaths.has(rel))
    for (const nested of nestedSnapshots) {
      const rel = path.relative(snapshot.cwd, nested.cwd).split(path.sep).join('/')
      try {
        await fs.mkdir(nested.cwd, { recursive: true })
        const result = await restoreWorktree(nested.gitDir, nested.cwd, nested.tree)
        count += result.count
        for (const file of result.files) files.push(rel === '' ? file : `${rel}/${file}`)
        for (const skip of result.skipped) skipped.push(rel === '' ? skip : `${rel}/${skip}`)
      } catch (error) {
        ctx.logger?.warn?.(`coding-enhanced: cannot restore nested repository ${nested.cwd}: ${String(error)}`)
        skipped.push(rel)
      }
    }
    try {
      for (const nestedCwd of await findNestedRepos(snapshot.cwd)) {
        const rel = path.relative(snapshot.cwd, nestedCwd).split(path.sep).join('/')
        if (!nestedPaths.has(rel)) skipped.push(rel)
      }
    } catch {}
    return { count, files, skipped: [...new Set(skipped)] }
  }

  // ---------------------------------------------------------------- rpc ---
  const ok = (value) => ({ ok: true, value })
  const fail = (code, message) => ({
    ok: false,
    error: { code: `coding-enhanced/${code}`, message },
  })

  const handleStatus = (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return fail('session-not-live', 'Session is not active in this Host')
    const info = inspectSession(session)
    const latestTurn = info.latestTurn
    const withdrawn = withdrawnOf(sessionId)
    const snapshotMap = snapshots.get(sessionId)
    const snapshotTurns = snapshotMap === undefined ? [] : [...snapshotMap.keys()].sort((left, right) => left - right)
    const backup = backupOf(sessionId)
    const anchors = {}
    const withdrawable = {}
    if (featureFlags.withdraw === true && !activeTurns.has(sessionId)) {
      const map = snapshots.get(sessionId)
      if (map !== undefined) {
        let changed = false
        for (const [turn, snapshot] of map.entries()) {
          if (snapshot.endSeq !== undefined) continue
          const endSeq = turnEndSeq(session, turn)
          if (endSeq !== undefined) {
            snapshot.endSeq = endSeq
            changed = true
          }
        }
        if (changed) persistSnapshots(sessionId)
        for (const [turn, snapshot] of map.entries()) {
          if (snapshot.endSeq === undefined) continue
          if (withdrawn[turn] !== undefined) continue
          if (surfaceRange(session, turn) === undefined) continue
          for (const id of turnMessageIds(session, turn)) anchors[id] = turn
          withdrawable[turn] = true
        }
      }
    }
    if (latestTurn !== undefined && withdrawable[latestTurn] === undefined && withdrawn[latestTurn] === undefined) {
      for (const id of info.latestMessageIds) anchors[id] = latestTurn
    }
    for (const key of Object.keys(withdrawn)) {
      const withdrawnTurn = Number(key)
      if (!Number.isSafeInteger(withdrawnTurn)) continue
      if (anchors[withdrawnTurn] !== undefined) continue
      for (const id of turnMessageIds(session, withdrawnTurn)) anchors[id] = withdrawnTurn
    }
    let reason = null
    if (featureFlags.withdraw !== true) reason = 'disabled'
    else if (latestTurn === undefined) reason = 'no-turn'
    else if (withdrawn[latestTurn] !== undefined) reason = 'already'
    else if (activeTurns.has(sessionId)) reason = 'active'
    else if (snapshotOf(sessionId, latestTurn) === undefined) reason = 'no-snapshot'
    else if (snapshotOf(sessionId, latestTurn).endSeq === undefined) reason = 'incomplete'
    return ok({
      latestTurn: latestTurn ?? null,
      active: activeTurns.has(sessionId),
      canWithdraw: withdrawable[latestTurn] === true,
      reason,
      turns: withdrawn,
      anchors,
      withdrawable,
      snapshotTurns,
      backupAt: backup?.at ?? null,
    })
  }

  const handleWithdraw = async (payload) => {
    const sessionId = payload?.sessionId
    const turn = payload?.turn
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(turn)) {
      return fail('bad-request', 'sessionId and turn are required')
    }
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return fail('session-not-live', 'Session is not active in this Host')
    if (featureFlags.withdraw !== true) return fail('withdraw-disabled', 'Turn withdraw is turned off in Settings')
    if (activeTurns.has(sessionId)) return fail('turn-active', 'A turn is still running')
    const withdrawn = withdrawnOf(sessionId)
    if (withdrawn[turn] !== undefined) return fail('already-withdrawn', 'This turn was already withdrawn')
    const snapshot = snapshotOf(sessionId, turn)
    if (snapshot === undefined) {
      return fail('no-snapshot', 'No workspace snapshot exists for this turn (it was pruned or started before the plugin loaded)')
    }
    if (snapshot.endSeq === undefined) {
      const endSeq = turnEndSeq(session, turn)
      if (endSeq !== undefined) {
        snapshot.endSeq = endSeq
        persistSnapshots(sessionId)
      }
    }
    if (snapshot.endSeq === undefined) return fail('turn-active', 'This turn has not finished yet')
    const info = inspectSession(session)
    if (info.latestTurn === undefined) return fail('no-turn', 'This session has no completed turn')
    if (turn > info.latestTurn) return fail('not-latest', 'This turn is newer than the latest completed turn')
    const target = surfaceRange(session, turn)
    if (target === undefined) {
      return fail('no-surface', 'This turn has no model-visible messages to cancel')
    }

    const events = session.snapshotEvents()
    const shadowed = new Set()
    for (const event of events) {
      const op = event.surfaceOp
      if (op === undefined || typeof op !== 'object' || op.op !== 'replace') continue
      const from = Math.min(op.startSeq, op.endSeq)
      const to = Math.max(op.startSeq, op.endSeq)
      for (let seq = from; seq <= to; seq += 1) shadowed.add(seq)
    }
    const seqs = []
    for (const event of events) {
      if (event.seq < target.startSeq) continue
      if (event.surfaceOp !== 'append' || !SURFACE_TYPES.has(event.type)) continue
      if (shadowed.has(event.seq)) continue
      seqs.push(event.seq)
    }
    if (seqs.length === 0) return fail('no-surface', 'This turn has no model-visible messages to cancel')
    // End on a model-visible surface event; tool results and turn/end are not
    // part of the surface and would be rejected by session.append.
    const endSeq = seqs[seqs.length - 1]
    const affected = new Set([turn])
    for (const event of events) {
      if (event.type === 'turn/start' && event.seq >= target.startSeq && Number.isSafeInteger(event.data?.turn) && event.data.turn >= turn) {
        affected.add(event.data.turn)
      }
    }

    let backup
    try {
      backup = await captureBackup(sessionId, session.header?.cwd ?? snapshot.cwd)
    } catch (error) {
      ctx.logger?.error?.(`coding-enhanced: backup failed: ${String(error)}`)
      return fail('backup-failed', `Could not capture the pre-withdraw backup, so nothing was restored: ${String(error)}`)
    }
    if (backup === undefined) {
      return fail('backup-failed', 'Could not capture the pre-withdraw backup, so nothing was restored.')
    }

    let restored
    try {
      restored = await restoreTree(snapshot)
    } catch (error) {
      ctx.logger?.error?.(`coding-enhanced: restore failed: ${String(error)}`)
      return fail('restore-failed', String(error))
    }

    // A withdrawal lands after turn/end, so there is no open turn and step to
    // join. A developer/message there is accepted by the live append but the
    // session format rejects it when the log is replayed, corrupting the
    // session. A user/message replacement is valid outside a turn (compaction
    // checkpoints use the same shape), and an empty user message projects to no
    // wire message, so the cancelled turn stays hidden without a synthetic turn.
    try {
      session.append(
        'user/message',
        {
          id: `coding-enhanced-withdraw-${turn}-${Date.now().toString(36)}`,
          role: 'user',
          source: { kind: 'coding-enhanced-withdraw' },
          content: [],
        },
        {
          surfaceOp: { op: 'replace', startSeq: target.startSeq, endSeq },
          sourceEventSeqs: seqs,
        },
      )
    } catch (error) {
      ctx.logger?.error?.(`coding-enhanced: cancel append failed: ${String(error)}`)
      return fail(
        'cancel-failed',
        `Files were restored, but hiding the turn from the model failed: ${String(error)}`,
      )
    }

    const restoredAt = Date.now()
    const record = state.sessions[sessionId] ?? {}
    if (record.withdrawn === undefined) record.withdrawn = {}
    for (const affectedTurn of affected) {
      record.withdrawn[affectedTurn] = {
        at: restoredAt,
        files: affectedTurn === turn ? restored.count : 0,
      }
    }
    record.updatedAt = restoredAt
    state.sessions[sessionId] = record

    const map = snapshots.get(sessionId)
    if (map !== undefined) {
      for (const affectedTurn of affected) {
        const dropped = map.get(affectedTurn)
        if (dropped !== undefined) {
          void deleteSnapshotRefs(dropped)
          markSnapshotDirty(dropped)
        }
        map.delete(affectedTurn)
      }
      if (map.size === 0) snapshots.delete(sessionId)
    }
    persistSnapshots(sessionId)
    saveState()
    if (featureFlags.autoGc === true) void flushGc()

    return ok({
      turn,
      files: restored.count,
      paths: restored.files,
      skipped: restored.skipped,
      withdrawn: [...affected].sort((left, right) => left - right),
    })
  }

  const cancelReview = (id, reasonFor) => {
    const review = [...reviews.values()].find((candidate) => candidate.id === id)
    if (review === undefined) return ok({ reviewId: id, canceled: true })
    if (review.finished) return ok({ reviewId: id, canceled: true })
    review.finished = true
    review.canceled = true
    for (const entry of review.entries.values()) {
      entry.canceled = true
      const reason = typeof reasonFor === 'function' ? reasonFor(entry) : reasonFor
      if (typeof reason === 'string' && reason !== '') entry.cancelReason = reason
    }
    for (const waiter of review.waiters) waiter()
    review.waiters = []
    bumpReview()
    return ok({ reviewId: id, canceled: true })
  }

  const updateSettings = (patch) => {
    if (patch === null || typeof patch !== 'object') {
      return fail('bad-request', 'settings patch must be an object')
    }
    let changed = false
    if (typeof patch.reviewChannel === 'string' && REVIEW_CHANNELS.has(patch.reviewChannel) && patch.reviewChannel !== featureFlags.reviewChannel) {
      const previous = featureFlags.reviewChannel
      featureFlags.reviewChannel = patch.reviewChannel
      changed = true
      // Start only on a transition away from 'builtin'; stop only when entering
      // it, so web <-> both never reconnects an already-live bridge.
      if (previous === 'builtin' && patch.reviewChannel !== 'builtin') {
        webBridge.start()
      } else if (previous !== 'builtin' && patch.reviewChannel === 'builtin') {
        webBridge.stop()
      }
    }
    if (typeof patch.review === 'boolean' && patch.review !== featureFlags.review) {
      featureFlags.review = patch.review
      changed = true
    }
    if (typeof patch.withdraw === 'boolean' && patch.withdraw !== featureFlags.withdraw) {
      featureFlags.withdraw = patch.withdraw
      changed = true
    }
    if (typeof patch.autoReview === 'boolean' && patch.autoReview !== featureFlags.autoReview) {
      featureFlags.autoReview = patch.autoReview
      changed = true
    }
    if (typeof patch.aiExplain === 'boolean' && patch.aiExplain !== featureFlags.aiExplain) {
      featureFlags.aiExplain = patch.aiExplain
      changed = true
    }
    if (typeof patch.allowBlockingReviewWait === 'boolean' && patch.allowBlockingReviewWait !== featureFlags.allowBlockingReviewWait) {
      featureFlags.allowBlockingReviewWait = patch.allowBlockingReviewWait
      changed = true
    }
    if (Number.isSafeInteger(patch.keepTurns)) {
      const next = Math.min(50, Math.max(1, patch.keepTurns))
      if (next !== featureFlags.keepTurns) {
        featureFlags.keepTurns = next
        changed = true
        pruneAllSnapshots()
      }
    }
    if (typeof patch.nestedSnapshots === 'boolean' && patch.nestedSnapshots !== featureFlags.nestedSnapshots) {
      featureFlags.nestedSnapshots = patch.nestedSnapshots
      changed = true
    }
    if (typeof patch.autoGc === 'boolean' && patch.autoGc !== featureFlags.autoGc) {
      featureFlags.autoGc = patch.autoGc
      changed = true
    }
    if (changed) saveFeatureFlags()
    if (featureFlags.review !== true) {
      for (const review of [...reviews.values()]) {
        if (review.finished) continue
        cancelReview(review.id, (entry) => `The review gate was turned off in Settings. Nothing was written for "${entry.display}". Do not retry immediately; wait for the user.`)
      }
    }
    return ok({ review: featureFlags.review, withdraw: featureFlags.withdraw, autoReview: featureFlags.autoReview, aiExplain: featureFlags.aiExplain, allowBlockingReviewWait: featureFlags.allowBlockingReviewWait, keepTurns: featureFlags.keepTurns, nestedSnapshots: featureFlags.nestedSnapshots, autoGc: featureFlags.autoGc, reviewChannel: featureFlags.reviewChannel, version: PLUGIN_VERSION })
  }

  const handleUpdateCheck = async () => {
    try {
      const check = await latestNpmVersion()
      return ok({ current: PLUGIN_VERSION, latest: check.version, registry: check.registry, available: compareVersions(check.version, PLUGIN_VERSION) > 0 })
    } catch (error) {
      return fail('update-check-failed', String(error))
    }
  }

  const handleUpdateInstall = async () => {
    let latest
    try {
      latest = (await latestNpmVersion()).version
    } catch (error) {
      return fail('update-check-failed', String(error))
    }
    if (compareVersions(latest, PLUGIN_VERSION) <= 0) {
      return ok({ updated: false, current: PLUGIN_VERSION, latest })
    }
    const profileDir = path.dirname(path.dirname(PACKAGE_ROOT))
    if (!existsSync(path.join(profileDir, 'package.json')) || !existsSync(path.join(profileDir, 'node_modules'))) {
      return fail('update-not-profile', 'This plugin is linked from a development checkout; update it through Plugins or npm install.')
    }
    const spec = `dsh-coding-enhanced@${latest}`
    const profileName = path.basename(profileDir)
    let manager
    try {
      manager = await installPackage(spec, profileDir)
    } catch (error) {
      return fail('update-failed', `Could not install ${spec}. Run \`dsh plugin --profile ${profileName} add ${spec}\` and restart DSH. ${String(error)}`)
    }
    return ok({
      updated: true,
      from: PLUGIN_VERSION,
      to: latest,
      restart: true,
      profile: profileName,
      manager,
      command: manager === 'dsh-bundled-pnpm' ? `dsh-bundled pnpm add ${spec}` : `${manager} add ${spec}`,
    })
  }

  const handleRestoreBackup = async (payload) => {
    const sessionId = payload?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return fail('bad-request', 'sessionId is required')
    if (ctx.sessions.get(sessionId) === undefined) return fail('session-not-live', 'Session is not active in this Host')
    if (activeTurns.has(sessionId)) return fail('turn-active', 'A turn is still running')
    const backup = backupOf(sessionId)
    if (backup === undefined) return fail('no-backup', 'No pre-withdraw backup exists for this session')
    let restored
    try {
      restored = await restoreTree({ ...backup, sessionId })
    } catch (error) {
      ctx.logger?.error?.(`coding-enhanced: restore backup failed: ${String(error)}`)
      return fail('restore-backup-failed', String(error))
    }
    return ok({ restored: restored.count, files: restored.files, skipped: restored.skipped, at: backup.at ?? null })
  }

  const dispatch = async (endpoint, payload) => {
    try {
      if (endpoint === 'status') return handleStatus(payload?.sessionId)
      if (endpoint === 'webStatus') return ok(webBridge.status())
      if (endpoint === 'webPair') return ok(await webBridge.pair(payload))
      if (endpoint === 'webDisconnect') return ok(webBridge.disconnect())
      if (endpoint === 'settings') return ok({ review: featureFlags.review, withdraw: featureFlags.withdraw, autoReview: featureFlags.autoReview, aiExplain: featureFlags.aiExplain, allowBlockingReviewWait: featureFlags.allowBlockingReviewWait, keepTurns: featureFlags.keepTurns, nestedSnapshots: featureFlags.nestedSnapshots, autoGc: featureFlags.autoGc, reviewChannel: featureFlags.reviewChannel, version: PLUGIN_VERSION })
      if (endpoint === 'setSettings') return updateSettings(payload)
      if (endpoint === 'cleanup') return ok(await cleanupSnapshots())
      if (endpoint === 'withdraw') return await handleWithdraw(payload)
      if (endpoint === 'restoreBackup') return await handleRestoreBackup(payload)
      if (endpoint === 'updateCheck') return await handleUpdateCheck()
      if (endpoint === 'updateInstall') return await handleUpdateInstall()
      if (endpoint === 'reviews') {
        const since = payload?.since
        if (Number.isSafeInteger(since) && since === reviewVersion) {
          return ok({ version: reviewVersion, unchanged: true })
        }
        return ok({
          version: reviewVersion,
          unchanged: false,
          reviews: [...reviews.values()].map(serializeReview),
          audits: Object.fromEntries(audits),
        })
      }
      if (endpoint === 'decide') return decideReview(payload?.reviewId, payload?.decisions)
      if (endpoint === 'cancel') return cancelReview(payload?.reviewId)
      return fail('not-found', `Unknown endpoint ${JSON.stringify(endpoint)}`)
    } catch (error) {
      ctx.logger?.error?.(`coding-enhanced: ${String(error)}`)
      return fail('internal', String(error))
    }
  }

  // The shared `/api` bridge admits the request (browser trust, cookie auth and
  // the owner-Peer check) before an exact route sees it.
  ctx.connection.fetch.register({
    path: '/api/coding-enhanced',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return Response.json(fail('bad-request', 'Body must be JSON'), { status: 400 })
      }
      const result = await dispatch(body?.endpoint, body?.payload)
      return Response.json(result)
    },
  })

}

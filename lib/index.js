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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'coding-enhanced'
export const inject = ['sessions', 'connection']

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

  const featureFlags = { review: true, withdraw: true }
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
    if (typeof parsed.review === 'boolean') featureFlags.review = parsed.review
    if (typeof parsed.withdraw === 'boolean') featureFlags.withdraw = parsed.withdraw
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
  let state = { sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.sessions) state = parsed
  } catch {}

  const saveState = () => {
    try {
      const sessions = Object.entries(state.sessions)
      if (sessions.length > 200) {
        sessions.sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))
        for (const [id] of sessions.slice(0, sessions.length - 200)) delete state.sessions[id]
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

  // ------------------------------------------------------------ snapshots ---
  /** sessionId -> { turn, tree, cwd, gitDir, endSeq } */
  const snapshots = new Map()
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

  const captureSnapshot = (sessionId, cwd, turn) => {
    const work = (async () => {
      const gitDir = await ensureRepo(cwd)
      // `--ignore-errors` keeps unreadable files from failing the whole turn.
      try {
        await runGit(['add', '-A', '--ignore-errors'], { gitDir, workTree: cwd })
      } catch (error) {
        ctx.logger?.warn?.(`coding-enhanced: snapshot add failed for ${cwd}: ${String(error)}`)
        return
      }
      const tree = (await runGit(['write-tree'], { gitDir, workTree: cwd })).trim()
      if (tree === '') return
      snapshots.set(sessionId, { turn, tree, cwd, gitDir, endSeq: undefined })
    })()
    return serialized(`snapshot:${cwd}`, () => work)
  }


  // ------------------------------------------------------- review gate ---
  const REVIEW_TOOLS = new Set(['write', 'edit'])
  const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024
  const MAX_EDITABLE_BYTES = 200 * 1024
  /** sessionId -> open review { id, sessionId, createdAt, entries: Map, finished } */
  const reviews = new Map()
  /** sessionId -> Promise of the in-flight assistant-message staging */
  const reviewPrep = new Map()
  /** callId -> reviewed content that replaces the tool's own write after it succeeds */
  const pendingApplies = new Map()
  let reviewVersion = 0

  const bumpReview = () => {
    reviewVersion += 1
  }

  const ensureReview = (sessionId) => {
    let review = reviews.get(sessionId)
    if (review === undefined || review.finished) {
      review = {
        id: `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        createdAt: Date.now(),
        entries: new Map(),
        virtual: new Map(),
        finished: false,
      }
      reviews.set(sessionId, review)
    }
    return review
  }

  const decisionFor = (entry) => {
    if (entry.canceled === true) {
      return {
        kind: 'deny',
        reason: typeof entry.cancelReason === 'string' && entry.cancelReason !== ''
          ? entry.cancelReason
          : `The user closed the code review tab without approving the change to "${entry.display}". Nothing was written. Do not retry immediately; tell the user what happened and wait for their instruction.`,
      }
    }
    if (entry.outcome === 'edited' || entry.decision?.approved === true || entry.decision?.edited === true) return { kind: 'allow' }
    const comment = typeof entry.decision?.comment === 'string' ? entry.decision.comment.trim() : ''
    const verb = entry.tool === 'write' ? 'write' : 'edit'
    return {
      kind: 'deny',
      reason: `The user rejected the ${verb} to "${entry.display}".${comment === '' ? ' No further instruction was provided.' : ` User instruction: ${comment}`}`,
    }
  }

  const consumeEntry = (review, entry) => {
    entry.cancelAbort?.()
    entry.cancelAbort = undefined
    review.entries.delete(entry.id)
    if (review.entries.size === 0 && reviews.get(review.sessionId) === review) {
      reviews.delete(review.sessionId)
    }
    bumpReview()
  }

  const waitForDecision = (review, entry, signal) => {
    if (review.finished) return Promise.resolve(decisionFor(entry))
    if (signal?.aborted === true) return Promise.resolve({ kind: 'cancel' })
    return new Promise((resolve) => {
      entry.waiter = resolve
      if (signal !== undefined) {
        const onAbort = () => {
          if (entry.waiter === undefined) return
          entry.waiter = undefined
          resolve({ kind: 'cancel' })
        }
        signal.addEventListener('abort', onAbort, { once: true })
        entry.cancelAbort = () => signal.removeEventListener('abort', onAbort)
      }
    })
  }

  const cleanupReview = (sessionId) => {
    for (const [callId, apply] of pendingApplies) {
      if (apply.sessionId === sessionId) pendingApplies.delete(callId)
    }
    const review = reviews.get(sessionId)
    if (review === undefined) return
    for (const entry of review.entries.values()) {
      if (entry.waiter !== undefined) {
        const resolve = entry.waiter
        entry.waiter = undefined
        entry.cancelAbort?.()
        resolve({ kind: 'cancel' })
      }
    }
    review.entries.clear()
    reviews.delete(sessionId)
    bumpReview()
  }

  const buildReviewEntry = async (session, call, virtual) => {
    if (call === null || typeof call !== 'object' || typeof call.id !== 'string' || call.id === '') return undefined
    let args
    try {
      args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    } catch {
      return undefined
    }
    if (args === null || typeof args !== 'object') return undefined
    const filePath = typeof args.file_path === 'string' ? args.file_path : undefined
    if (filePath === undefined || filePath === '') return undefined

    const cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : process.cwd()
    const absolute = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath)
    const display = insideDir(cwd, absolute) ? path.relative(cwd, absolute) : absolute

    let before = ''
    let exists = false
    let warning
    const staged = virtual?.get(absolute)
    if (staged !== undefined) {
      before = staged
      exists = true
    } else {
      try {
        const info = await fs.stat(absolute)
        if (info.isFile()) {
          exists = true
          if (info.size > MAX_REVIEW_FILE_BYTES) {
            warning = 'This file is too large to preview here; review the change without a diff.'
          } else {
            before = await fs.readFile(absolute, 'utf8')
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') warning = `Cannot read the current file: ${String(error)}`
      }
    }

    let after = before
    const isNew = !exists
    if (call.name === 'write') {
      after = typeof args.content === 'string' ? args.content : ''
    } else if (call.name === 'edit') {
      const oldString = typeof args.old_string === 'string' ? args.old_string : ''
      const newString = typeof args.new_string === 'string' ? args.new_string : ''
      if (oldString === '') {
        warning = warning ?? 'old_string is empty; the edit will likely fail.'
      } else if (!exists) {
        warning = warning ?? 'The target file does not exist; the edit will likely fail.'
      } else {
        const matches = countOccurrences(before, oldString)
        if (matches === 0) {
          warning = warning ?? 'old_string was not found in the current file; the edit will likely fail.'
        } else {
          if (matches > 1 && args.replace_all !== true) {
            warning = warning ?? `old_string matches ${matches} places; the edit will likely fail unless replace_all is set.`
          }
          after = args.replace_all === true
            ? before.split(oldString).join(newString)
            : replaceFirst(before, oldString, newString)
        }
      }
    } else {
      return undefined
    }

    if (before.includes('\u0000') || after.includes('\u0000') || after.length > MAX_REVIEW_FILE_BYTES) {
      return {
        id: call.id,
        callId: call.id,
        tool: call.name,
        path: absolute,
        display,
        isNew,
        warning: warning ?? (after.length > MAX_REVIEW_FILE_BYTES
          ? 'The proposed content is too large to preview here; review the change without a diff.'
          : 'Binary file: preview unavailable.'),
        added: 0,
        removed: 0,
        truncated: false,
        hunks: [],
        editable: false,
        before: null,
        after: null,
        decision: null,
        waiter: undefined,
        cancelAbort: undefined,
      }
    }

    if (virtual !== undefined && after.length <= MAX_REVIEW_FILE_BYTES) virtual.set(absolute, after)
    const editable = before.length <= MAX_EDITABLE_BYTES && after.length <= MAX_EDITABLE_BYTES
    const diff = computeDiff(before, after)
    return {
      id: call.id,
      callId: call.id,
      tool: call.name,
      path: absolute,
      display,
      isNew,
      warning,
      added: diff.added,
      removed: diff.removed,
      truncated: diff.truncated,
      hunks: diff.hunks,
      editable,
      before: editable ? before : null,
      after: editable ? after : null,
      decision: null,
      waiter: undefined,
      cancelAbort: undefined,
    }
  }

  const stageReviewCalls = (session, calls) => {
    if (featureFlags.review !== true) return Promise.resolve()
    const work = (async () => {
      const review = ensureReview(session.id)
      for (const call of calls) {
        try {
          const entry = await buildReviewEntry(session, call, review.virtual)
          if (reviews.get(session.id) !== review) return
          if (entry !== undefined && !review.entries.has(entry.id)) review.entries.set(entry.id, entry)
        } catch (error) {
          ctx.logger?.warn?.(`coding-enhanced: cannot stage review entry: ${String(error)}`)
        }
      }
      if (review.entries.size === 0 && reviews.get(session.id) === review) reviews.delete(session.id)
      bumpReview()
    })()
    reviewPrep.set(session.id, work)
    void work.finally(() => {
      if (reviewPrep.get(session.id) === work) reviewPrep.delete(session.id)
    })
    return work
  }

  const stageSingleEntry = async (session, exec) => {
    const review = ensureReview(session.id)
    const entry = await buildReviewEntry(session, {
      id: exec.callId,
      name: exec.name,
      arguments: exec.arguments,
    }, review.virtual)
    if (entry === undefined) return undefined
    if (!review.entries.has(entry.id)) review.entries.set(entry.id, entry)
    bumpReview()
    return { review, entry: review.entries.get(entry.id) }
  }

  const reviewGate = async (exec, next) => {
    if (!REVIEW_TOOLS.has(exec.name)) return next()
    if (featureFlags.review !== true) return next()
    const session = exec.agent?.session
    if (session === undefined) return next()
    const preparing = reviewPrep.get(session.id)
    if (preparing !== undefined) await preparing

    let review = reviews.get(session.id)
    let entry = review?.entries.get(exec.callId)
    if (entry === undefined) {
      const staged = await stageSingleEntry(session, exec)
      if (staged === undefined) return next()
      review = staged.review
      entry = staged.entry
    }

    if (exec.signal?.aborted === true) {
      consumeEntry(review, entry)
      return { kind: 'cancel' }
    }

    let downstream
    try {
      downstream = await next()
    } catch (error) {
      consumeEntry(review, entry)
      throw error
    }
    if (downstream === undefined || (downstream.kind !== 'allow' && downstream.kind !== 'ask')) {
      consumeEntry(review, entry)
      return downstream
    }

    const decision = await waitForDecision(review, entry, exec.signal)
    consumeEntry(review, entry)
    if (decision.kind === 'allow') return downstream
    if (decision.kind === 'cancel') return { kind: 'cancel' }
    return { kind: 'deny', reason: decision.reason }
  }

  const serializeReview = (review) => ({
    id: review.id,
    sessionId: review.sessionId,
    createdAt: review.createdAt,
    finished: review.finished,
    entries: [...review.entries.values()].map((entry) => ({
      id: entry.id,
      callId: entry.callId,
      tool: entry.tool,
      path: entry.path,
      display: entry.display,
      isNew: entry.isNew,
      warning: entry.warning ?? null,
      added: entry.added,
      removed: entry.removed,
      truncated: entry.truncated,
      hunks: entry.hunks,
      editable: entry.editable === true,
      beforeText: entry.editable === true ? entry.before : null,
      afterText: entry.editable === true ? entry.after : null,
      decision: entry.decision,
    })),
  })

  const decideReview = (id, decisions) => {
    const review = [...reviews.values()].find((candidate) => candidate.id === id)
    if (review === undefined) return fail('review-not-found', 'This review is no longer open')
    if (review.finished) return fail('review-finished', 'This review was already finished')
    const byEntry = new Map()
    for (const decision of Array.isArray(decisions) ? decisions : []) {
      if (decision !== null && typeof decision === 'object' && typeof decision.entryId === 'string') {
        byEntry.set(decision.entryId, decision)
      }
    }
    const entries = [...review.entries.values()]
    const missing = []
    const tooLarge = []
    const normalized = new Map()
    for (const entry of entries) {
      const decision = byEntry.get(entry.id)
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
        normalized.set(entry.id, { outcome: 'edited', editedAfter: text, comment: '' })
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

    for (const entry of entries) {
      const decision = normalized.get(entry.id)
      entry.outcome = decision.outcome
      entry.decision = {
        outcome: decision.outcome,
        approved: decision.outcome === 'approved',
        edited: decision.outcome === 'edited',
        comment: decision.comment,
      }
      if (decision.outcome === 'edited') {
        entry.editedAfter = decision.editedAfter
        pendingApplies.set(entry.callId, {
          sessionId: review.sessionId,
          path: entry.path,
          display: entry.display,
          content: decision.editedAfter,
        })
      }
      if (entry.waiter !== undefined) {
        const resolve = entry.waiter
        entry.waiter = undefined
        entry.cancelAbort?.()
        resolve(decisionFor(entry))
      }
    }
    review.finished = true
    bumpReview()
    return ok({ reviewId: review.id })
  }

  ctx.on('tools/pre-execute', reviewGate, { prepend: true })

  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      const downstream = await next()
      const apply = pendingApplies.get(exec.callId)
      if (apply === undefined) return downstream
      pendingApplies.delete(exec.callId)
      if (result?.isError === true || downstream === undefined || downstream.kind !== 'accept') {
        return downstream
      }
      try {
        await fs.writeFile(apply.path, apply.content, 'utf8')
      } catch (error) {
        if ('value' in downstream) return downstream
        return {
          ...downstream,
          content: [{
            type: 'text',
            text: `The tool ran, but the user's reviewed version could not be written to "${apply.display}": ${String(error)}`,
          }],
        }
      }
      if ('value' in downstream) return downstream
      return {
        ...downstream,
        content: [{
          type: 'text',
          text: `Outcome: edited by the user. The user replaced your proposal for "${apply.display}" with their own reviewed version, which is now on disk. Do not re-apply your proposal.`,
        }],
      }
    },
    { prepend: true },
  )

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
      const calls = (event.data?.message?.content ?? [])
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call' && REVIEW_TOOLS.has(block.name))
        .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }))
      if (calls.length > 0) void stageReviewCalls(session, calls)
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const cwd = session.header?.cwd
      if (typeof cwd !== 'string' || cwd === '' || isSubagent(session)) return
      const turn = event.data?.turn
      activeTurns.set(session.id, turn)
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
      activeTurns.delete(session.id)
      cleanupReview(session.id)
      const snapshot = snapshots.get(session.id)
      if (snapshot !== undefined && snapshot.turn === turn) snapshot.endSeq = event.seq
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
    snapshots.delete(session.id)
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

  // ------------------------------------------------------------- restore ---
  const restoreTree = async (snapshot) => {
    const { gitDir, cwd, tree } = snapshot
    return serialized(`snapshot:${cwd}`, async () => {
      await runGit(['add', '-A', '--ignore-errors'], { gitDir, workTree: cwd })
      const current = (await runGit(['write-tree'], { gitDir, workTree: cwd })).trim()
      if (current === tree) return { count: 0, files: [] }

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

      for (const entry of entries) {
        const absolute = posixJoin(cwd, entry.rel)
        if (entry.status === 'A') {
          await fs.rm(absolute, { recursive: true, force: true })
          continue
        }
        const mode = modes.get(entry.rel) ?? '100644'
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
      }

      // Leave the shared index at the restored tree so the next turn diffs cleanly.
      await runGit(['read-tree', tree], { gitDir, workTree: cwd })
      return { count: entries.length, files: entries.map((entry) => entry.rel) }
    })
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
    const snapshot = snapshots.get(sessionId)
    const withdrawn = withdrawnOf(sessionId)
    const anchors = {}
    if (latestTurn !== undefined) {
      for (const id of info.latestMessageIds) anchors[id] = latestTurn
    }
    let reason = null
    if (featureFlags.withdraw !== true) reason = 'disabled'
    else if (latestTurn === undefined) reason = 'no-turn'
    else if (withdrawn[latestTurn] !== undefined) reason = 'already'
    else if (activeTurns.has(sessionId)) reason = 'active'
    else if (snapshot === undefined || snapshot.turn !== latestTurn) reason = 'no-snapshot'
    return ok({
      latestTurn: latestTurn ?? null,
      active: activeTurns.has(sessionId),
      canWithdraw: reason === null,
      reason,
      turns: withdrawn,
      anchors,
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
    const info = inspectSession(session)
    if (info.latestTurn !== turn) {
      return fail('not-latest', 'Only the latest completed turn can be withdrawn')
    }
    if (withdrawnOf(sessionId)[turn] !== undefined) {
      return fail('already-withdrawn', 'This turn was already withdrawn')
    }
    const snapshot = snapshots.get(sessionId)
    if (snapshot === undefined || snapshot.turn !== turn) {
      return fail('no-snapshot', 'No workspace snapshot exists for this turn (it started before the plugin loaded)')
    }
    const range = surfaceRange(session, turn)
    if (range === undefined) {
      return fail('no-surface', 'This turn has no model-visible messages to cancel')
    }

    let restored
    try {
      restored = await restoreTree(snapshot)
    } catch (error) {
      ctx.logger?.error?.(`coding-enhanced: restore failed: ${String(error)}`)
      return fail('restore-failed', String(error))
    }

    try {
      session.append(
        'developer/message',
        {
          message: {
            id: `coding-enhanced-${turn}-${Date.now().toString(36)}`,
            role: 'developer',
            source: { kind: 'user' },
            content: [],
          },
        },
        {
          surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
          sourceEventSeqs: range.seqs,
        },
      )
    } catch (error) {
      ctx.logger?.error?.(`coding-enhanced: cancel append failed: ${String(error)}`)
      return fail(
        'cancel-failed',
        `Files were restored, but hiding the turn from the model failed: ${String(error)}`,
      )
    }

    const record = state.sessions[sessionId] ?? { withdrawn: {} }
    record.withdrawn[turn] = { at: Date.now(), files: restored.count }
    record.updatedAt = Date.now()
    state.sessions[sessionId] = record
    saveState()

    return ok({ turn, files: restored.count, paths: restored.files })
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
      if (entry.waiter !== undefined) {
        const resolve = entry.waiter
        entry.waiter = undefined
        entry.cancelAbort?.()
        resolve(decisionFor(entry))
      }
    }
    bumpReview()
    return ok({ reviewId: id, canceled: true })
  }

  const updateSettings = (patch) => {
    if (patch === null || typeof patch !== 'object') {
      return fail('bad-request', 'settings patch must be an object')
    }
    let changed = false
    if (typeof patch.review === 'boolean' && patch.review !== featureFlags.review) {
      featureFlags.review = patch.review
      changed = true
    }
    if (typeof patch.withdraw === 'boolean' && patch.withdraw !== featureFlags.withdraw) {
      featureFlags.withdraw = patch.withdraw
      changed = true
    }
    if (changed) saveFeatureFlags()
    if (featureFlags.review !== true) {
      for (const review of [...reviews.values()]) {
        if (review.finished) continue
        cancelReview(review.id, (entry) => `The review gate was turned off in Settings. Nothing was written for "${entry.display}". Do not retry immediately; wait for the user.`)
      }
    }
    return ok({ review: featureFlags.review, withdraw: featureFlags.withdraw })
  }

  const dispatch = async (endpoint, payload) => {
    try {
      if (endpoint === 'status') return handleStatus(payload?.sessionId)
      if (endpoint === 'settings') return ok({ review: featureFlags.review, withdraw: featureFlags.withdraw })
      if (endpoint === 'setSettings') return updateSettings(payload)
      if (endpoint === 'withdraw') return await handleWithdraw(payload)
      if (endpoint === 'reviews') {
        const since = payload?.since
        if (Number.isSafeInteger(since) && since === reviewVersion) {
          return ok({ version: reviewVersion, unchanged: true })
        }
        return ok({
          version: reviewVersion,
          unchanged: false,
          reviews: [...reviews.values()].map(serializeReview),
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

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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'coding-enhanced'
export const inject = ['sessions', 'connection', 'tools', 'systemPrompt']

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
  const REVIEW_TOOLS = new Set(['write', 'edit', 'apply_patch'])
  const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024
  const MAX_EDITABLE_BYTES = 200 * 1024
  /** sessionId -> review { id, sessionId, entries, virtual, submitted, finished, canceled, waiters } */
  const reviews = new Map()
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
        submitted: false,
        finished: false,
        canceled: false,
        waiters: [],
      }
      reviews.set(sessionId, review)
    }
    return review
  }

  const cleanupReview = (sessionId) => {
    const review = reviews.get(sessionId)
    if (review === undefined) return
    for (const waiter of review.waiters) waiter()
    review.waiters = []
    review.entries.clear()
    reviews.delete(sessionId)
    bumpReview()
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
        editable: false,
        canApply: true,
        updatedAt: Date.now(),
        decision: null,
        callIds: [call.id],
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
    bumpReview()
    return { review, entry }
  }

  const reviewSummary = (review) => {
    if (review.canceled === true) {
      return 'The user closed the code review tab. No changes were applied. Do not retry immediately; wait for the user\'s instruction.'
    }
    if (review.finished !== true) {
      return 'The review is still open; no result has been applied yet.'
    }
    const applied = []
    const rejected = []
    const failed = []
    for (const entry of review.entries.values()) {
      if (entry.applyError !== undefined) {
        failed.push(`${entry.display}: ${entry.applyError}`)
      } else if (entry.outcome === 'rejected') {
        rejected.push(`${entry.display}${entry.decision?.comment ? ` — user instruction: ${entry.decision.comment}` : ''}`)
      } else {
        applied.push(`${entry.display}${entry.outcome === 'edited' ? ' (edited by user)' : ''}`)
      }
    }
    const lines = ['Review finished.']
    if (applied.length > 0) lines.push(`Applied (${applied.length}): ${applied.join(', ')}`)
    if (rejected.length > 0) lines.push(`Rejected (${rejected.length}): ${rejected.join('; ')}`)
    if (failed.length > 0) lines.push(`Failed (${failed.length}): ${failed.join('; ')}`)
    if (applied.length === 0 && rejected.length === 0 && failed.length === 0) lines.push('No changes.')
    return lines.join('\n')
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
      editable: entry.editable === true,
      canApply: entry.canApply !== false,
      beforeText: entry.editable === true ? entry.before : null,
      afterText: entry.editable === true ? entry.after : null,
      decision: entry.decision,
    })),
  })

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

  const registerReviewTools = () => {
    ctx.tools.register(defineTool({
      name: 'review_write',
      description: 'Queue a file write for the user\'s review. This does not write the file: the change is held in the Code review tab until the user finishes. Use review_edit for an existing file. After queueing every change for this turn, call review_wait.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to write, resolved like the write tool.' },
        content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) return 'No active session.'
        if (featureFlags.review !== true) return 'The review gate is off. Use the write tool instead.'
        const queued = await stageFileChange(session, { id: exec.callId, name: 'write', arguments: { file_path: args.file_path, content: args.content } })
        if (queued === undefined) return 'Could not queue this change (missing or invalid file_path).'
        return `Queued for review: ${queued.entry.display} (${queued.review.entries.size} file(s) queued). Nothing is written until the user finishes. After all changes, call review_wait.`
      },
    }), { when: () => featureFlags.review === true })

    ctx.tools.register(defineTool({
      name: 'review_edit',
      description: 'Queue a literal text replacement in an existing file for the user\'s review. This does not write the file: the change is held in the Code review tab until the user finishes. After queueing every change, call review_wait.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to edit, resolved like the edit tool.' },
        old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
        new_string: { type: 'string', required: true, description: 'Literal replacement text. Use an empty string to delete the match.' },
        replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined) return 'No active session.'
        if (featureFlags.review !== true) return 'The review gate is off. Use the edit tool instead.'
        const queued = await stageFileChange(session, {
          id: exec.callId,
          name: 'edit',
          arguments: {
            file_path: args.file_path,
            old_string: args.old_string,
            new_string: args.new_string,
            ...(args.replace_all === true ? { replace_all: true } : {}),
          },
        })
        if (queued === undefined) return 'Could not queue this change (missing or invalid file_path).'
        return `Queued for review: ${queued.entry.display} (${queued.review.entries.size} file(s) queued). Nothing is written until the user finishes. After all changes, call review_wait.`
      },
    }), { when: () => featureFlags.review === true })

    ctx.tools.register(defineTool({
      name: 'review_wait',
      description: 'Wait for the user to finish reviewing every change queued in this turn. Call this exactly once after queueing all changes with review_write/review_edit. It returns which files were applied, which were rejected (with the user\'s instructions), and which failed.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        const session = exec.agent?.session
        if (session === undefined) return 'No active session.'
        const review = reviews.get(session.id)
        if (review === undefined || review.entries.size === 0) return 'No queued changes to review.'
        if (review.submitted !== true) {
          review.submitted = true
          bumpReview()
        }
        await waitForReviewFinish(review, exec.signal)
        return reviewSummary(review)
      },
    }), { when: () => featureFlags.review === true })
  }

  const nativeGate = async (exec, next) => {
    if (featureFlags.review !== true) return next()
    if (!REVIEW_TOOLS.has(exec.name)) return next()
    return {
      kind: 'deny',
      reason: 'File changes must go through the review gate. Use review_write (new file or full content) or review_edit (literal replacement) to queue the change, then call review_wait after all changes. Nothing is written until the user finishes the review.',
    }
  }

  ctx.on('tools/pre-execute', nativeGate, { prepend: true })

  registerReviewTools()

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'tool:review-gate',
      order: 110,
      text: () => featureFlags.review === true
        ? 'File changes are reviewed by the user before they are written. Use review_write (new file or full content) and review_edit (literal replacement) to queue every change; these tools do not write files. When every change is queued, call review_wait once, wait for its result, and then continue. Do not call write, edit, or apply_patch while the review gate is on.'
        : '',
    }), 'coding-enhanced: review prompt')
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
      const review = reviews.get(session.id)
      if (review !== undefined) {
        if (review.finished === true) cleanupReview(session.id)
        else if (review.entries.size > 0 && review.submitted !== true) {
          review.submitted = true
          bumpReview()
        }
      }
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

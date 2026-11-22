import path from 'node:path'

const ARTIFACT_DIRS = ['dist', 'build', 'out', 'target', 'node_modules', '.next', '.cache', 'coverage', '.vitest', '__pycache__', '.pytest_cache', '.turbo', '.parcel-cache']

const cleanTarget = (value) => String(value).replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')

const isArtifactPath = (value) => {
  const cleaned = cleanTarget(value)
  if (cleaned === '/dev/null' || cleaned.startsWith('/tmp/') || cleaned === '/tmp') return true
  return ARTIFACT_DIRS.some((dir) => cleaned === dir || cleaned.startsWith(`${dir}/`) || cleaned.includes(`/${dir}/`))
}

const isInsideQuotes = (value, index) => {
  let quote = null
  for (let i = 0; i < index; i += 1) {
    const ch = value[i]
    if (quote !== null) {
      if (ch === quote && value[i - 1] !== '\\') quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    }
  }
  return quote !== null
}

const isProtectedTarget = (target, cwd) => {
  const cleaned = cleanTarget(target)
  if (cleaned === '' || cleaned.startsWith('&') || /^\d+$/.test(cleaned)) return false
  if (isArtifactPath(cleaned)) return false
  const root = path.resolve(cwd)
  const resolved = path.resolve(root, cleaned)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

const splitArgs = (value) => value.split(/\s+/).filter((part) => part !== '')
const optionless = (args) => args.filter((part) => !part.startsWith('-') && !part.includes('='))

/**
 * Detect shell commands that write protected workspace files.
 *
 * The unit of protection is a file target, not a command. Installs, builds,
 * tests and environment commands pass; only targets inside the workspace that
 * are not artifacts block. Ambiguous writes (patch/apply, git worktree,
 * archives, wrapped commands, inline interpreters) require a second
 * confirmation; the turn/end audit remains the backstop.
 */
export const detectShellWrites = (command, cwd) => {
  const reasons = []
  const targets = []
  const add = (reason, target) => {
    reasons.push(reason)
    if (typeof target === 'string' && target !== '') targets.push(target)
  }

  for (const match of command.matchAll(/(?:^|[^>=-])>{1,2}\s*([^\s;&|]+)/g)) {
    const index = match.index + match[1].length
    if (isInsideQuotes(command, index)) continue
    const target = cleanTarget(match[2])
    if (target.startsWith('&') || /^\d+$/.test(target)) continue
    add('shell redirection', target)
  }
  for (const match of command.matchAll(/(?:^|[^>=-])>\|\s*([^\s;&|]+)/g)) {
    const index = match.index + match[1].length
    if (isInsideQuotes(command, index)) continue
    add('shell redirection', cleanTarget(match[2]))
  }

  const tee = /\btee\s+(?:-[A-Za-z]+\s+)*([^\s;&|]+)/.exec(command)
  if (tee !== null && !isInsideQuotes(command, tee.index + tee[0].lastIndexOf(tee[1]))) add('tee', tee[1])
  const sed = /\bsed\s+(?:[^;&|]*\s)?-i(?:\.\w+)?\s+([^\s;&|]+)/.exec(command)
  if (sed !== null) add('in-place edit', sed[1])
  const perl = /\bperl\s+-i\s+([^\s;&|]+)/.exec(command)
  if (perl !== null) add('in-place edit', perl[1])
  const ruby = /\bruby\s+-i(?:\.\w+)?\s+([^\s;&|]+)/.exec(command)
  if (ruby !== null) add('in-place edit', ruby[1])
  const dd = /\bdd\b[^;&|]*\bof=([^\s;&|]+)/.exec(command)
  if (dd !== null) add('dd', dd[1])
  const curl = /\bcurl\b[^;&|]*\s-o\s*([^\s;&|]+)/.exec(command)
  if (curl !== null) add('curl -o', curl[1])
  const wget = /\bwget\b[^;&|]*\s-O\s*([^\s;&|]+)/.exec(command)
  if (wget !== null) add('wget -O', wget[1])

  const cp = /\bcp\b([^;&|]*)/.exec(command)
  if (cp !== null) {
    const args = optionless(splitArgs(cp[1]))
    if (args.length > 0) add('cp', args[args.length - 1])
  }
  const mv = /\bmv\b([^;&|]*)/.exec(command)
  if (mv !== null) {
    for (const arg of optionless(splitArgs(mv[1]))) add('mv', arg)
  }
  const rm = /\brm\b([^;&|]*)/.exec(command)
  if (rm !== null) {
    for (const arg of optionless(splitArgs(rm[1]))) add('rm', arg)
  }
  const touch = /\btouch\b([^;&|]*)/.exec(command)
  if (touch !== null) {
    for (const arg of optionless(splitArgs(touch[1]))) add('touch', arg)
  }
  const ln = /\bln\b([^;&|]*)/.exec(command)
  if (ln !== null) {
    const args = optionless(splitArgs(ln[1]))
    if (args.length > 0) add('ln', args[args.length - 1])
  }
  const rsync = /\brsync\b([^;&|]*)/.exec(command)
  if (rsync !== null) {
    const args = optionless(splitArgs(rsync[1]))
    if (args.length > 0) add('rsync', args[args.length - 1])
  }
  const scp = /\bscp\b([^;&|]*)/.exec(command)
  if (scp !== null) {
    const args = optionless(splitArgs(scp[1]))
    if (args.length > 0) add('scp', args[args.length - 1])
  }

  for (const op of ['truncate', 'shred', 'unlink']) {
    const match = new RegExp(`\\b${op}\\b([^;&|]*)`).exec(command)
    if (match !== null) {
      for (const arg of optionless(splitArgs(match[1]))) add(op, arg)
    }
  }

  if (/\bgit\s+apply\b/.test(command)) add('git apply')
  if (/\bpatch\b/.test(command)) add('patch')
  if (/\bgit\s+(?:restore|checkout\s+--|reset\s+--hard|clean\s+-[A-Za-z]*f[A-Za-z]*|stash)\b/.test(command)) add('git worktree write')
  if (/\btar\b[^;&|]*\s-[A-Za-z]*x[A-Za-z]*/.test(command)) add('archive extract')
  if (/\bunzip\b/.test(command)) add('archive extract')
  if (/\bgit\s+clone\b/.test(command)) add('git clone')
  if (/\b(?:bash|sh|zsh)\s+-c\b|\beval\b|\bsource\b|\bfind\b[^;&|]*\s-exec\b|\bxargs\b/.test(command)) add('wrapped command')
  if (/\b(?:python3?|node|ruby|perl)\b/.test(command) && /\b(?:open|writeFileSync|writeFile|write_text|to_csv|savefig|fs\.write|shutil\.(?:copy|move|rmtree)|os\.(?:rename|remove|unlink))\b/.test(command)) add('inline write')

  const protectedTargets = targets.filter((target) => isProtectedTarget(target, cwd))
  const blocked = protectedTargets.length > 0
  const needsConfirm = !blocked && reasons.length > 0
  return { blocked, needsConfirm, reasons, targets, protectedTargets }
}

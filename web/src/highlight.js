// A tiny, dependency-free syntax highlighter for the standalone review diff.
// It highlights one source line at a time: comments and strings that span lines
// are intentionally out of scope, which keeps the review page fast and safe.

const JS_KEYWORDS = [
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false',
  'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private',
  'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
  'with', 'yield',
]

const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'True', 'try', 'while', 'with', 'yield',
]

const GO_KEYWORDS = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map',
  'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
  'true', 'false', 'nil',
]

const RUST_KEYWORDS = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
  'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
  'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
]

const C_KEYWORDS = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'true',
  'false', 'nullptr', 'class', 'namespace', 'public', 'private', 'protected',
]

const SH_KEYWORDS = [
  'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function',
  'if', 'in', 'local', 'return', 'select', 'then', 'until', 'while',
]

const SQL_KEYWORDS = [
  'ALTER', 'AND', 'AS', 'ASC', 'BEGIN', 'BY', 'CREATE', 'DELETE', 'DESC',
  'DISTINCT', 'DROP', 'FROM', 'GROUP', 'HAVING', 'INSERT', 'INTO', 'JOIN', 'LIMIT',
  'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'SELECT', 'SET', 'TABLE', 'UPDATE', 'VALUES',
  'WHERE',
]

const YAML_WORDS = ['true', 'false', 'null', 'yes', 'no', 'on', 'off']
const JSON_WORDS = ['true', 'false', 'null']

const keywordSource = (list) => list.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')

const rule = (cls, pattern) => ({ cls, pattern })

const rulesFor = (language) => {
  switch (language) {
    case 'js':
    case 'ts':
      return [
        rule('com', /\/\/.*$|\/\*.*?\*\//),
        rule('str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/),
        rule('key', new RegExp(`\\b(?:${keywordSource(JS_KEYWORDS)})\\b`)),
        rule('num', /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)\b/),
        rule('fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/),
      ]
    case 'json':
      return [
        rule('str', /"(?:\\.|[^"\\])*"/),
        rule('key', new RegExp(`\\b(?:${JSON_WORDS.join('|')})\\b`)),
        rule('num', /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/),
      ]
    case 'css':
      return [
        rule('com', /\/\*.*?\*\//),
        rule('str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/),
        rule('key', /@[\w-]+/),
        rule('num', /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|ms|s|%|fr|deg)?\b/),
        rule('fn', /\b[-a-zA-Z]+(?=\s*:)/),
      ]
    case 'html':
      return [
        rule('com', /<!--.*?-->/),
        rule('tag', /<\/?[A-Za-z][\w:-]*|\/?>/),
        rule('attr', /\b[A-Za-z_:][\w:.-]*(?=\s*=)/),
        rule('str', /"(?:[^"]*)"|'(?:[^']*)'/),
        rule('var', /&[\w#]+;/),
      ]
    case 'py':
      return [
        rule('com', /#.*$/),
        rule('str', /"""|[\s\S]*?"""|'''(?:[\s\S]*?)'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/),
        rule('key', new RegExp(`\\b(?:${keywordSource(PY_KEYWORDS)})\\b`)),
        rule('fn', /@[\w.]+|\b[A-Za-z_][\w]*(?=\s*\()/),
        rule('num', /\b\d+(?:\.\d+)?\b/),
      ]
    case 'sh':
      return [
        rule('com', /#.*$/),
        rule('str', /"(?:\\.|[^"\\])*"|'[^']*'/),
        rule('var', /\$\{?[\w-]+\}?/),
        rule('key', new RegExp(`\\b(?:${keywordSource(SH_KEYWORDS)})\\b`)),
        rule('num', /\b\d+\b/),
      ]
    case 'go':
      return [
        rule('com', /\/\/.*$|\/\*.*?\*\//),
        rule('str', /"(?:\\.|[^"\\])*"|`[^`]*`/),
        rule('key', new RegExp(`\\b(?:${keywordSource(GO_KEYWORDS)})\\b`)),
        rule('fn', /\b[A-Za-z_][\w]*(?=\s*\()/),
        rule('num', /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)\b/),
      ]
    case 'rust':
      return [
        rule('com', /\/\/.*$|\/\*.*?\*\//),
        rule('str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'/),
        rule('key', new RegExp(`\\b(?:${keywordSource(RUST_KEYWORDS)})\\b`)),
        rule('fn', /\b[A-Za-z_][\w]*(?=\s*[(!])/),
        rule('num', /\b\d+(?:\.\d+)?\b/),
      ]
    case 'c':
    case 'cpp':
      return [
        rule('com', /\/\/.*$|\/\*.*?\*\//),
        rule('str', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])'/),
        rule('key', new RegExp(`\\b(?:${keywordSource(C_KEYWORDS)})\\b`)),
        rule('fn', /\b[A-Za-z_][\w]*(?=\s*\()/),
        rule('num', /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)\b/),
      ]
    case 'yaml':
      return [
        rule('com', /#.*$/),
        rule('key', /^\s*[\w.-]+(?=\s*:)/),
        rule('str', /"(?:[^"]*)"|'(?:[^']*)'/),
        rule('key', new RegExp(`\\b(?:${YAML_WORDS.join('|')})\\b`)),
        rule('num', /\b-?\d+(?:\.\d+)?\b/),
      ]
    case 'sql':
      return [
        rule('com', /--.*$/),
        rule('str', /'(?:[^']*)'/),
        rule('key', new RegExp(`\\b(?:${keywordSource(SQL_KEYWORDS)})\\b`, 'i')),
        rule('num', /\b\d+(?:\.\d+)?\b/),
      ]
    case 'md':
      return [
        rule('head', /^#{1,6}\s.*$/),
        rule('str', /`[^`]*`/),
        rule('fn', /\[[^\]]*\]\([^)]*\)/),
        rule('key', /\*\*[^*]+\*\*/),
      ]
    default:
      return []
  }
}

const compiled = new Map()

const compiledRules = (language) => {
  let entry = compiled.get(language)
  if (entry !== undefined) return entry
  const rules = rulesFor(language)
  if (rules.length === 0) {
    entry = { rules: [], regex: null }
  } else {
    const parts = rules.map((item, index) => `(?<t${index}>${item.pattern.source})`)
    entry = { rules, regex: new RegExp(parts.join('|'), 'g') }
  }
  compiled.set(language, entry)
  return entry
}

const EXTENSIONS = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html',
  py: 'py', pyw: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh',
  go: 'go', rs: 'rust',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql',
  md: 'md', markdown: 'md',
}

/** Map a workspace path to one of the supported highlighting languages. */
export function languageOf(path) {
  const value = String(path ?? '').toLowerCase()
  const dot = value.lastIndexOf('.')
  if (dot < 0) return 'text'
  return EXTENSIONS[value.slice(dot + 1)] ?? 'text'
}

/** Tokenize one source line into text runs, each with an optional severity class. */
export function highlightLine(text, language) {
  const source = String(text ?? '')
  if (source === '' || language === 'text') return [{ text: source }]
  const { rules, regex } = compiledRules(language)
  if (rules.length === 0 || regex === null) return [{ text: source }]
  const tokens = []
  let last = 0
  regex.lastIndex = 0
  for (const match of source.matchAll(regex)) {
    if (match.index > last) tokens.push({ text: source.slice(last, match.index) })
    let cls = 'text'
    for (let index = 0; index < rules.length; index += 1) {
      if (match.groups?.[`t${index}`] !== undefined) {
        cls = rules[index].cls
        break
      }
    }
    tokens.push({ text: match[0], cls })
    last = match.index + match[0].length
  }
  if (last < source.length) tokens.push({ text: source.slice(last) })
  return tokens
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-round-home-'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-round-work-'))
const stateDir = path.join(home, 'coding-enhanced')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({
  reviewChannel: 'both',
  webUrl: 'http://127.0.0.1:4317',
  webDeviceToken: 'smoke-token',
  webDeviceId: 'smoke-device',
}))
process.env.DSH_HOME = home
globalThis.WebSocket = class {
  constructor() { this.readyState = 1 }
  addEventListener() {}
  send() {}
  close() {}
}

const tools = new Map()
const handlers = new Map()
let apiHandler = null
const session = { id: 'session-round', header: { origin: 'human', delegationDepth: 0, cwd: work } }
const agent = { id: session.id, session, status: 'idle', followup() {}, steer() {} }
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: {
    get() { return undefined },
    register(tool) { if (tool?.name) tools.set(tool.name, tool) },
  },
  on(event, fn) {
    const list = handlers.get(event) ?? []
    list.push(fn)
    handlers.set(event, list)
  },
  inject(names, callback) {
    callback({ effect(fn) { fn() }, systemPrompt: { section() { return {} } } })
  },
  sessions: { get(id) { return id === session.id ? session : undefined } },
  agents: { get(id) { return id === session.id ? agent : undefined }, list() { return [agent] } },
  subagents: {
    listProviders() { return ['spawn'] },
    async startActivation() { return { childId: 'waiter-1', result: Promise.resolve(), dispose: async () => {} } },
    async sendMessage() { return 'ok' },
  },
  connection: { fetch: { register(options) { apiHandler = options.fetch } } },
}
apply(ctx)
assert.equal(typeof apiHandler, 'function')
const api = async (endpoint, payload) => {
  const response = await apiHandler({ json: async () => ({ endpoint, payload }) })
  return response.json()
}
const event = (type, data) => {
  for (const fn of handlers.get('session/event') ?? []) fn(session, { type, data })
}
const write = tools.get('review_write')
assert.ok(write)
const exec = { agent, callId: 'call-1', scope: {}, signal: new AbortController().signal }

event('turn/start', { turn: 1 })
const first = await write.execute({ file_path: 'demo.txt', content: 'one\n', notes: [{ line: 1, text: 'first' }], name: 'review-demo' }, exec)
assert.match(first, /Queued for review/)
event('turn/end', { turn: 1, reason: { kind: 'completed' } })

exec.callId = 'call-2'
event('turn/start', { turn: 2 })
await write.execute({ file_path: 'demo.txt', content: 'one\ntwo\n', notes: [{ line: 2, text: 'second' }], name: 'review-demo' }, exec)
event('turn/end', { turn: 2, reason: { kind: 'completed' } })

const list = await api('reviews')
const review = list.value.reviews[0]
assert.ok(review)
const entry = review.entries[0]
assert.equal(entry.round, 2, 'second AI turn is round 2')
assert.equal(entry.roundUnread, true, 'round is marked new')
const roundAdded = entry.roundHunks.flatMap((hunk) => hunk.lines).filter((line) => line.type === 'add').map((line) => line.newNo)
assert.deepEqual(roundAdded, [2], 'round diff contains only the new line')

const decided = await api('decide', { reviewId: review.id, decisions: [{ entryId: entry.id, approved: true, comment: '' }] })
assert.equal(decided.ok, true)
await new Promise((resolve) => setTimeout(resolve, 200))
const after = await api('reviews')
assert.equal(after.value.reviews[0].finished, true)
assert.equal(after.value.reviews[0].entries[0].roundUnread, false, 'decide clears the round marker')
assert.equal(fs.readFileSync(path.join(work, 'demo.txt'), 'utf8'), 'one\ntwo\n', 'latest round applied')
console.log('review rounds smoke: ok')
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(work, { recursive: true, force: true })

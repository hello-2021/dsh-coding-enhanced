import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-host-'))
const stateDir = path.join(home, 'coding-enhanced')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({
  reviewChannel: 'both',
  webUrl: 'http://127.0.0.1:4317',
  webDeviceToken: 'smoke-token',
  webDeviceId: 'smoke-device',
}))
process.env.DSH_HOME = home

const sockets = []
const sent = []
class MockWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 1
    this.listeners = {}
    sockets.push(this)
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn)
  }
  emit(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
  send(raw) {
    sent.push(JSON.parse(raw))
  }
  close() {
    this.readyState = 3
  }
}
globalThis.WebSocket = MockWebSocket

let activationSpec = null
let followUp = null
const handlers = new Map()
const parent = { session: { id: 'session-smoke', header: { origin: 'human', delegationDepth: 0 } } }
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { get() { return undefined }, register() {} },
  on(event, fn) {
    const list = handlers.get(event) ?? []
    list.push(fn)
    handlers.set(event, list)
  },
  inject(names, callback) {
    callback({ effect(fn) { fn() }, systemPrompt: { section() { return {} } } })
  },
  sessions: { get(id) { return id === 'session-smoke' ? parent.session : undefined } },
  agents: {
    list() { return [parent] },
    get(id) { return id === 'session-smoke' ? parent : undefined },
  },
  subagents: {
    listProviders() { return ['spawn'] },
    async startActivation(spec) {
      activationSpec = spec
      return { childId: 'child-chat-1', result: Promise.resolve(), dispose: async () => {} }
    },
    async sendMessage(sender, target, content, options) {
      followUp = { sender, target, content, options }
      return 'msg-2'
    },
  },
  connection: { fetch: { register() {} } },
}
apply(ctx)

const bridge = sockets[0]
assert.ok(bridge)
bridge.emit('message', { data: JSON.stringify({ type: 'review.catalog', reviews: [{ id: 'review-auth', title: 'review-auth-cleanup', sessionId: 'session-smoke', entries: [] }] }) })

bridge.emit('message', { data: JSON.stringify({ type: 'chat.send', requestId: 'req-1', text: 'What changed in review-auth-cleanup?' }) })
await new Promise((resolve) => setTimeout(resolve, 20))
assert.ok(activationSpec, 'global activation was started')
assert.equal(activationSpec.delivery, 'caller')
assert.match(activationSpec.request.prompt[0].text, /review-auth-cleanup/)
assert.match(activationSpec.request.prompt[0].text, /What changed/)

for (const fn of handlers.get('session/event') ?? []) {
  fn({ id: 'child-chat-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'It renamed the auth helper.' }] } } })
  fn({ id: 'child-chat-1' }, { type: 'turn/end', data: { turn: 1 } })
}
await new Promise((resolve) => setTimeout(resolve, 20))
const answer = sent.find((message) => message.type === 'chat.message')
assert.ok(answer, 'chat.message was sent to the bridge')
assert.equal(answer.requestId, 'req-1')
assert.equal(answer.role, 'assistant')
assert.equal(answer.text, 'It renamed the auth helper.')

bridge.emit('message', { data: JSON.stringify({ type: 'chat.send', requestId: 'req-2', text: 'And review-web-chat?' }) })
await new Promise((resolve) => setTimeout(resolve, 20))
assert.ok(followUp, 'follow-up used sendMessage')
assert.equal(followUp.target, 'child-chat-1')
assert.match(followUp.content[0].text, /review-web-chat/)

for (const fn of handlers.get('session/event') ?? []) {
  fn({ id: 'child-chat-1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', message: 'boom' } } })
}
await new Promise((resolve) => setTimeout(resolve, 20))
const failed = sent.find((message) => message.type === 'chat.error' && message.requestId === 'req-2')
assert.ok(failed, 'chat.error was sent')
console.log('host chat smoke: ok')
fs.rmSync(home, { recursive: true, force: true })

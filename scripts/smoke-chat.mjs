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

const handlers = new Map()
const messages = []
const parent = {
  id: 'session-smoke',
  status: 'idle',
  session: { id: 'session-smoke', header: { origin: 'human', delegationDepth: 0 } },
  followup(message) { messages.push(message) },
  steer(message) { messages.push(message) },
  whenIdle() { return Promise.resolve() },
}
let liveAgents = [parent]
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
    list() { return liveAgents },
    get(id) { return id === 'session-smoke' ? parent : undefined },
  },
  subagents: {
    listProviders() { return ['spawn'] },
    async startActivation() { return { childId: 'child-chat-1', result: Promise.resolve(), dispose: async () => {} } },
    async sendMessage() { return 'msg-2' },
  },
  connection: { fetch: { register() {} } },
}
apply(ctx)

const bridge = sockets[0]
assert.ok(bridge)
const send = (message) => bridge.emit('message', { data: JSON.stringify(message) })
const sessionEvent = (type, data = {}) => {
  for (const fn of handlers.get('session/event') ?? []) fn({ id: 'session-smoke' }, { type, data })
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

send({ type: 'review.catalog', reviews: [{ id: 'review-auth', title: 'review-auth-cleanup', sessionId: 'session-smoke', entries: [] }] })
send({ type: 'chat.send', requestId: 'req-1', sessionId: 'session-smoke', text: 'What changed in review-auth-cleanup?' })
await tick()
assert.equal(messages.length, 1, 'main agent received the question')
assert.equal(messages[0].source.kind, 'user')
assert.match(messages[0].content[0].text, /review-auth-cleanup/)
assert.match(messages[0].content[0].text, /What changed/)
assert.match(messages[0].content[0].text, /Do not finish, approve or reject/)

sessionEvent('turn/start', { turn: 7 })
sessionEvent('assistant/message', { message: { content: [{ type: 'text', text: 'It renamed the auth helper.' }] } })
sessionEvent('turn/end', { turn: 7 })
await tick()
const first = sent.find((message) => message.type === 'chat.message' && message.requestId === 'req-1')
assert.ok(first, 'answer forwarded to the web chat')
assert.equal(first.role, 'assistant')
assert.equal(first.text, 'It renamed the auth helper.')

parent.status = 'running'
send({ type: 'chat.send', requestId: 'req-2', sessionId: 'session-smoke', text: 'And review-web-chat?' })
send({ type: 'chat.send', requestId: 'req-3', sessionId: 'session-smoke', text: 'One more.' })
await tick()
assert.equal(messages.length, 2, 'running agent still gets a follow-up')
assert.match(messages[1].content[0].text, /review-web-chat/)
assert.equal(messages.filter((message) => message.content[0].text.includes('One more')).length, 0, 'second message queued')

sessionEvent('turn/end', { turn: 8 })
await tick()
assert.equal(sent.filter((message) => message.type === 'chat.message' && message.requestId === 'req-2').length, 0, 'previous turn end does not resolve the chat')
sessionEvent('turn/start', { turn: 9 })
sessionEvent('assistant/message', { message: { content: [{ type: 'text', text: 'Web chat uses the global thread.' }] } })
sessionEvent('turn/end', { turn: 9 })
await tick()
const second = sent.find((message) => message.type === 'chat.message' && message.requestId === 'req-2')
assert.ok(second, 'queued answer resolves after the next turn')
assert.equal(messages.length, 3, 'third message started after the second finished')
assert.match(messages[2].content[0].text, /One more/)

sessionEvent('turn/start', { turn: 10 })
sessionEvent('assistant/message', { message: { content: [{ type: 'text', text: 'Third answer.' }] } })
sessionEvent('turn/end', { turn: 10 })
await tick()
assert.ok(sent.find((message) => message.type === 'chat.message' && message.requestId === 'req-3'), 'third answer forwarded')

liveAgents = []
send({ type: 'chat.send', requestId: 'req-4', text: 'Anybody there?' })
await tick()
const failed = sent.find((message) => message.type === 'chat.error' && message.requestId === 'req-4')
assert.ok(failed, 'chat.error when no live session exists')
console.log('host chat smoke: ok')
fs.rmSync(home, { recursive: true, force: true })

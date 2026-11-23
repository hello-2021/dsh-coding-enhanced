import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

// Isolated DSH home so the smoke test never touches the real plugin state.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ce-smoke-'))
const stateDir = path.join(home, 'coding-enhanced')
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({
  reviewChannel: 'both',
  webUrl: 'http://127.0.0.1:4317',
  webDeviceToken: 'smoke-token',
  webDeviceId: 'smoke-device',
}))
process.env.DSH_HOME = home

let sockets = 0
globalThis.WebSocket = class {
  constructor() {
    sockets += 1
    this.readyState = 0
  }
  addEventListener() {}
  send() {}
  close() {}
}

let handler
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { get() { return undefined }, register() {} },
  on() {},
  inject(names, callback) {
    callback({ effect(fn) { fn() }, systemPrompt: { section() { return {} } } })
  },
  sessions: { get() { return undefined } },
  subagents: {},
  connection: { fetch: { register(options) { handler = options.fetch } } },
}

apply(ctx)
assert.equal(typeof handler, 'function', 'the plugin must register the /api bridge')

const call = async (endpoint, payload) => {
  const response = await handler({ json: async () => ({ endpoint, payload }) })
  return response.json()
}

try {
  const initial = await call('settings')
  assert.equal(initial.ok, true)
  assert.equal(initial.value.reviewChannel, 'both', 'both is the default channel')
  assert.equal(sockets, 1, 'both starts the web bridge')

  const builtin = await call('setSettings', { reviewChannel: 'builtin' })
  assert.equal(builtin.value.reviewChannel, 'builtin')
  assert.equal(sockets, 1, 'builtin must not open another bridge')

  const web = await call('setSettings', { reviewChannel: 'web' })
  assert.equal(web.value.reviewChannel, 'web')
  assert.equal(sockets, 2, 'leaving builtin starts the bridge again')

  const both = await call('setSettings', { reviewChannel: 'both' })
  assert.equal(both.value.reviewChannel, 'both')
  assert.equal(sockets, 2, 'web <-> both must not reconnect')

  const invalid = await call('setSettings', { reviewChannel: 'nope' })
  assert.equal(invalid.value.reviewChannel, 'both', 'invalid channels are ignored')

  const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'settings.json'), 'utf8'))
  assert.equal(saved.reviewChannel, 'both', 'channel is persisted')

  console.log('smoke: ok')
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}

import os from 'node:os'

const RECONNECT_MS = [1000, 2000, 5000, 10000]

/**
 * Outbound bridge from the DSH plugin host to the standalone web review server.
 *
 * The plugin is the authority; this module only mirrors review snapshots and
 * carries decisions back. It never opens an inbound port: the plugin connects
 * to /ws/device with a device token obtained through the web pairing code.
 */
export const createWebBridge = (options) => {
  const { getConfig, saveConfig, serializeReview, getReviews, getVersion, pluginVersion, isEnabled } = options
  let socket = null
  let timer = null
  let attempt = 0
  let connected = false
  let stopped = true
  let lastError = null

  const status = () => {
    const config = getConfig()
    return {
      url: config.url ?? '',
      deviceId: config.deviceId ?? '',
      paired: Boolean(config.token && config.deviceId),
      connected,
      lastError,
    }
  }

  const send = (value) => {
    if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(value))
  }

  const envelope = (review) => ({
    ...serializeReview(review),
    version: getVersion(),
    status: review.finished ? 'finished' : review.canceled ? 'canceled' : review.submitted ? 'submitted' : 'open',
  })

  const publish = (review) => {
    send({ type: 'review.snapshot', review: envelope(review) })
  }

  const publishAll = () => {
    for (const review of getReviews()) publish(review)
  }

  const schedule = () => {
    if (stopped) return
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]
    attempt += 1
    timer = setTimeout(connect, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const connect = () => {
    const config = getConfig()
    if (!config.url || !config.token) return
    if (typeof WebSocket === 'undefined') {
      lastError = 'WebSocket is not available in this Node runtime'
      return
    }
    try {
      const base = String(config.url).replace(/^http/, 'ws').replace(/\/+$/, '')
      const ws = new WebSocket(`${base}/ws/device?token=${encodeURIComponent(config.token)}`)
      socket = ws
      ws.addEventListener('open', () => {
        connected = true
        attempt = 0
        lastError = null
        send({ type: 'hello', deviceId: config.deviceId, pluginVersion: pluginVersion ?? '', capabilities: {} })
        publishAll()
      })
      ws.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (message === null || typeof message !== 'object') return
        if (message.type === 'ping') {
          send({ type: 'pong' })
          return
        }
        if (message.type === 'decision' && typeof options.onDecision === 'function') {
          options.onDecision(message)
        }
      })
      ws.addEventListener('close', () => {
        connected = false
        if (socket === ws) socket = null
        schedule()
      })
      ws.addEventListener('error', () => {
        lastError = 'WebSocket error'
      })
    } catch (error) {
      lastError = String(error)
      schedule()
    }
  }

  const start = () => {
    stopped = false
    // 'builtin' keeps the web channel off even when pairing saves a token.
    if (typeof isEnabled === 'function' && isEnabled() === false) return
    const config = getConfig()
    if (config.url && config.token) connect()
  }

  const stop = () => {
    stopped = true
    // A disabled channel must not leave a reconnect timer or socket behind.
    if (typeof isEnabled === 'function' && isEnabled() === false) {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (socket !== null) {
      try {
        socket.close()
      } catch {
        // Ignore close errors; the bridge is best-effort.
      }
      socket = null
    }
    connected = false
  }

  const pair = async (payload) => {
    const base = String(payload?.url ?? '').trim().replace(/\/+$/, '')
    const code = String(payload?.code ?? '').trim().toUpperCase()
    if (!/^https?:\/\//.test(base)) return { ok: false, error: 'Web URL must start with http:// or https://' }
    if (code === '') return { ok: false, error: 'Pairing code is required' }
    try {
      const response = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          deviceName: String(payload?.deviceName ?? os.hostname()).slice(0, 64),
          instanceId: os.hostname(),
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return { ok: false, error: data.error ?? `pair failed (${response.status})` }
      if (typeof data.token !== 'string' || data.token === '' || typeof data.deviceId !== 'string') {
        return { ok: false, error: 'pair response did not include a device token' }
      }
      saveConfig({ url: base, token: data.token, deviceId: data.deviceId })
      stop()
      start()
      return { ok: true, status: status() }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  const disconnect = () => {
    stop()
    saveConfig({ token: '', deviceId: '' })
    return { ok: true, status: status() }
  }

  return { start, stop, pair, disconnect, status, publish, publishAll, connect, send }
}

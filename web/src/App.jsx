import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, login, register } from './api.js'
import WebReviewDetail from './ReviewDetail.jsx'
import ChatPanel from './ChatPanel.jsx'

const NAV_ITEMS = [
  { id: 'standby', label: 'Standby' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'devices', label: 'Devices' },
]

const SIDEBAR_KEY = 'dsh-review.sidebar-collapsed'

function timeAgo(value) {
  if (!value) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - Number(value)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function reviewTitle(review) {
  return review?.title || review?.id || 'Untitled review'
}

function statusOf(review) {
  if (review?.finished) return 'finished'
  if (review?.canceled) return 'canceled'
  if (review?.submitted) return 'submitted'
  if (review?.status && ['open', 'submitted', 'finished', 'canceled'].includes(review.status)) return review.status
  return 'open'
}

function AuthScreen({ onUser }) {
  const [mode, setMode] = useState('login')
  const [username, setUsername] = useState('')
  const [key, setKey] = useState('')
  const [generated, setGenerated] = useState(null)
  const [generatedUser, setGeneratedUser] = useState(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (event) => {
    event.preventDefault()
    if (busy || username.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'register') {
        const data = await register(username.trim())
        setGenerated(data.key)
        setGeneratedUser(data.user)
      } else {
        const data = await login(username.trim(), key.trim())
        onUser(data.user)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(generated)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  if (generated) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="brand-mark">DSH</div>
          <h1>Save your user key</h1>
          <p className="muted">This key is shown once. It is the only way to sign in to this account.</p>
          <code style={{ display: 'block', padding: '10px', margin: '12px 0', border: '1px solid var(--border)', borderRadius: '7px', background: 'var(--bg)', wordBreak: 'break-all' }}>{generated}</code>
          <button type="button" className="button" onClick={copyKey}>{copied ? 'Copied' : 'Copy key'}</button>
          <p className="fineprint">Store it in a password manager. If you lose it, this local account cannot be recovered yet.</p>
          <button type="button" className="button primary wide" onClick={() => onUser(generatedUser)}>I saved it — continue</button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand-mark">DSH</div>
        <h1>Review, remotely.</h1>
        <p className="muted">Sign in with a username and user key. No passkey.</p>

        <div className="auth-tabs">
          <button type="button" className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => { setMode('login'); setError(null) }}>
            Sign in
          </button>
          <button type="button" className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => { setMode('register'); setError(null) }}>
            Register
          </button>
        </div>

        <form onSubmit={submit}>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="your-name"
              disabled={busy}
            />
          </label>
          {mode === 'login' ? (
            <label className="field">
              <span>User key</span>
              <input
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                autoComplete="off"
                placeholder="paste your user key"
                disabled={busy}
              />
            </label>
          ) : null}
          {error ? <div className="error">{error}</div> : null}
          <button className="button primary wide" type="submit" disabled={busy || username.trim() === '' || (mode === 'login' && key.trim() === '')}>
            {busy ? '…' : mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="fineprint">
          Registration issues a user key once. Use username + key to sign in. Bots and multiple DSH instances can pair later as devices.
        </p>
      </div>
    </div>
  )
}

function Shell({ user, view, onNavigate, onBack, socketState, devices, onLogout, children, chat, onSendChat }) {
  const online = devices.filter((device) => device.online).length
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
    } catch {
      // Keep the toggle usable for this page even when storage is unavailable.
    }
  }, [collapsed])
  return (
    <div className={`app${collapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="sidebar" id="app-sidebar">
        <div className="sidebar-brand">
          <span className="brand-dot" />
          <span>DSH Review</span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id || (view === 'review' && item.id === 'reviews') ? 'nav-item active' : 'nav-item'}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <ChatPanel messages={chat.messages} busy={chat.busy} error={chat.error} onSend={onSendChat} />
        <div className="sidebar-foot">
          <div className="device-summary">
            <span className={online > 0 ? 'dot online' : 'dot'} />
            {online} of {devices.length} device{devices.length === 1 ? '' : 's'} online
          </div>
          <div className="user-line">
            <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <span className="username">{user.username}</span>
          </div>
          <button type="button" className="link-button" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="sidebar-toggle"
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setCollapsed((value) => !value)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
                <path d="M6.2 2.5v11" />
              </svg>
            </button>
            {view !== 'standby' ? (
              <button
                type="button"
                className="sidebar-toggle topbar-back"
                title={view === 'review' ? 'Back to Reviews' : 'Back to Standby'}
                aria-label={view === 'review' ? 'Back to Reviews' : 'Back to Standby'}
                onClick={onBack}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9.5 3.5 5 8l4.5 4.5" />
                  <path d="M5 8h8" />
                </svg>
              </button>
            ) : null}
            <div className="topbar-title">{view === 'review' ? 'Review' : NAV_ITEMS.find((item) => item.id === view)?.label ?? 'Standby'}</div>
          </div>
          <div className={`conn ${socketState}`}>
            <span className="dot" />
            {socketState === 'online' ? 'Live' : socketState === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  )
}

function PairingCard({ pairing }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pairing.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className="card pairing">
      <div className="card-head">
        <h3>Pairing code</h3>
        <span className="muted">expires {new Date(pairing.expiresAt).toLocaleTimeString()}</span>
      </div>
      <div className="pairing-code">{pairing.code}</div>
      <p className="muted">
        In DSH open <strong>Coding Enhanced → Web review</strong>, enter the server URL and this code, then pair.
      </p>
      <button type="button" className="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy code'}
      </button>
    </section>
  )
}

function DeviceRow({ device, onRevoke }) {
  return (
    <div className="device-row">
      <span className={device.online ? 'dot online' : 'dot'} />
      <div className="device-main">
        <strong>{device.name}</strong>
        <span className="muted">
          {device.instanceId || 'DSH instance'} · {device.online ? 'online' : `last seen ${timeAgo(device.lastSeen)}`}
        </span>
      </div>
      <span className={device.online ? 'pill ok' : 'pill'}>{device.online ? 'online' : 'offline'}</span>
      {onRevoke ? (
        <button type="button" className="link-button danger" onClick={() => onRevoke(device.id)}>
          Revoke
        </button>
      ) : null}
    </div>
  )
}

function ReviewRow({ review, onOpen }) {
  const status = statusOf(review)
  return (
    <button type="button" className="review-row" onClick={onOpen}>
      <div className="review-main">
        <strong>{reviewTitle(review)}</strong>
        <span className="muted">
          {review.deviceName || review.deviceId || 'DSH'} · {timeAgo(review.updatedAt)}
        </span>
      </div>
      <span className={`pill ${status}`}>{status}</span>
    </button>
  )
}

function Empty({ title, hint }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  )
}

function Standby({ devices, reviews, pairing, onPair, onOpenReview, onDevices }) {
  return (
    <div className="stack">
      <section className="card hero">
        <div>
          <h2>Review from anywhere</h2>
          <p className="muted">
            Pair a DSH instance, then reviews appear here in real time. AI still runs inside DSH; this page only sees review data.
          </p>
        </div>
        <button className="button primary" type="button" onClick={onPair}>
          Pair a DSH instance
        </button>
      </section>

      {pairing ? <PairingCard pairing={pairing} /> : null}

      <section className="card">
        <div className="card-head">
          <h3>Devices</h3>
          <button type="button" className="link-button" onClick={onDevices}>
            Manage
          </button>
        </div>
        {devices.length === 0 ? (
          <Empty title="No devices yet" hint="Generate a pairing code and enter it in the DSH plugin's Web review settings." />
        ) : (
          <div className="device-list">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Recent reviews</h3>
          <span className="muted">{reviews.length} total</span>
        </div>
        {reviews.length === 0 ? (
          <Empty title="No reviews yet" hint="When the agent queues a review, it will show up here." />
        ) : (
          <div className="review-list">
            {reviews.slice(0, 5).map((item) => (
              <ReviewRow key={item.id} review={item} onOpen={() => onOpenReview(item.id)} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Devices({ devices, pairing, onPair, onRevoke }) {
  return (
    <div className="stack">
      <section className="card hero">
        <div>
          <h2>Devices</h2>
          <p className="muted">Each paired DSH instance can push reviews here. Revoking cuts its token immediately.</p>
        </div>
        <button className="button primary" type="button" onClick={onPair}>
          Generate pairing code
        </button>
      </section>

      {pairing ? <PairingCard pairing={pairing} /> : null}

      <section className="card">
        <div className="card-head">
          <h3>Paired devices</h3>
          <span className="muted">{devices.length}</span>
        </div>
        {devices.length === 0 ? (
          <Empty title="No devices yet" hint="Generate a pairing code, then enter it in the DSH plugin." />
        ) : (
          <div className="device-list">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} onRevoke={onRevoke} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Reviews({ reviews, onOpen }) {
  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h3>Reviews</h3>
          <span className="muted">{reviews.length}</span>
        </div>
        {reviews.length === 0 ? (
          <Empty title="No reviews yet" hint="Reviews queued by the agent will appear here." />
        ) : (
          <div className="review-list">
            {reviews.map((item) => (
              <ReviewRow key={item.id} review={item} onOpen={() => onOpen(item.id)} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState(null)
  const [booting, setBooting] = useState(true)
  const [view, setView] = useState('standby')
  const [devices, setDevices] = useState([])
  const [reviews, setReviews] = useState([])
  const [review, setReview] = useState(null)
  const [pairing, setPairing] = useState(null)
  const [error, setError] = useState(null)
  const [socketState, setSocketState] = useState('connecting')
  const socketRef = useRef(null)
  const [chat, setChat] = useState({ messages: [], busy: false, error: null })

  const loadDevices = useCallback(async () => {
    const data = await api('/api/devices')
    setDevices(Array.isArray(data.devices) ? data.devices : [])
  }, [])

  const loadReviews = useCallback(async () => {
    const data = await api('/api/reviews')
    setReviews(Array.isArray(data.reviews) ? data.reviews : [])
  }, [])

  const loadChat = useCallback(async () => {
    try {
      const data = await api('/api/chat')
      setChat({ messages: Array.isArray(data.messages) ? data.messages : [], busy: false, error: null })
    } catch (cause) {
      setChat({ messages: [], busy: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [])

  useEffect(() => {
    api('/api/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setBooting(false))
  }, [])

  useEffect(() => {
    if (!user) return undefined
    loadDevices().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    loadReviews().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    return undefined
  }, [user, loadDevices, loadReviews])

  useEffect(() => {
    if (user) void loadChat()
  }, [user, loadChat])

  useEffect(() => {
    if (!user) return undefined
    let disposed = false
    let timer = null
    let socket = null

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${protocol}://${window.location.host}/ws/browser`)
      socketRef.current = socket
      socket.onopen = () => setSocketState('online')
      socket.onmessage = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.type === 'device.status') {
          setDevices((current) =>
            current.map((device) =>
              device.id === message.deviceId ? { ...device, online: message.online === true, lastSeen: message.lastSeen } : device,
            ),
          )
        } else if (message.type === 'review.snapshot') {
          const next = message.review
          if (!next || typeof next.id !== 'string') return
          setReview((current) => (current && current.id === next.id ? next : current))
          setReviews((current) => {
            const summary = {
              id: next.id,
              title: next.title ?? next.id,
              status: next.status ?? (next.finished ? 'finished' : 'open'),
              version: next.version ?? 0,
              updatedAt: Date.now(),
              deviceId: next.deviceId ?? '',
              deviceName: next.deviceName ?? '',
            }
            return [summary, ...current.filter((item) => item.id !== next.id)]
          })
        } else if (message.type === 'review.result') {
          if (typeof message.error === 'string' && message.error !== '') setError(message.error)
          loadReviews().catch(() => {})
        } else if (message.type === 'chat.message') {
          const incoming = { id: message.id, role: message.role, text: message.text, createdAt: message.createdAt ?? Date.now() }
          setChat((current) => {
            if (incoming.id !== undefined && current.messages.some((item) => item.id === incoming.id)) return current
            return { ...current, messages: [...current.messages, incoming], busy: message.role === 'assistant' ? false : current.busy, error: null }
          })
        } else if (message.type === 'chat.error') {
          setChat((current) => ({ ...current, busy: false, error: message.message ?? 'Chat failed' }))
        } else if (message.type === 'error') {
          setError(message.message ?? 'WebSocket error')
        }
      }
      socket.onclose = () => {
        setSocketState('offline')
        if (!disposed) timer = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => {}
    }

    connect()
    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      socket?.close()
      socketRef.current = null
    }
  }, [user, loadReviews])

  useEffect(() => {
    if (!error) return undefined
    const timer = window.setTimeout(() => setError(null), 6000)
    return () => window.clearTimeout(timer)
  }, [error])

  const onUser = (next) => {
    setUser(next)
    setView('standby')
    setError(null)
  }

  const onLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      // Ignore logout transport errors; local state is cleared below.
    }
    setUser(null)
    setReview(null)
    setReviews([])
    setDevices([])
    setPairing(null)
    setChat({ messages: [], busy: false, error: null })
    setView('standby')
  }

  const onNavigate = (next) => {
    setView(next)
    if (next !== 'review') setReview(null)
  }

  const goBack = () => {
    if (view === 'review') {
      setView('reviews')
    } else {
      setView('standby')
    }
    setReview(null)
  }

  const createPairing = async () => {
    try {
      const data = await api('/api/devices/pairing-code', { method: 'POST' })
      setPairing(data)
      setView('devices')
      await loadDevices()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const revokeDevice = async (id) => {
    try {
      await api(`/api/devices/${id}`, { method: 'DELETE' })
      await loadDevices()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openReview = async (id) => {
    try {
      const data = await api(`/api/reviews/${id}`)
      setReview(data.review)
      setView('review')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const sendChat = (text) => {
    const socket = socketRef.current
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      setChat((current) => ({ ...current, error: 'WebSocket is not connected.' }))
      return
    }
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now())
    setChat((current) => ({ ...current, busy: true, error: null }))
    socket.send(JSON.stringify({ type: 'chat.send', requestId, text }))
  }

  const sendWs = (payload) => {
    const socket = socketRef.current
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  if (booting) return <div className="boot">Loading…</div>
  if (!user) return <AuthScreen onUser={onUser} />

  return (
    <Shell user={user} view={view} onNavigate={onNavigate} onBack={goBack} socketState={socketState} devices={devices} onLogout={onLogout} chat={chat} onSendChat={sendChat}>
      {view === 'standby' ? (
        <Standby
          devices={devices}
          reviews={reviews}
          pairing={pairing}
          onPair={createPairing}
          onOpenReview={openReview}
          onDevices={() => setView('devices')}
        />
      ) : null}
      {view === 'reviews' ? <Reviews reviews={reviews} onOpen={openReview} /> : null}
      {view === 'devices' ? <Devices devices={devices} pairing={pairing} onPair={createPairing} onRevoke={revokeDevice} /> : null}
      {view === 'review' ? (
        <WebReviewDetail
          review={review}
          send={sendWs}
          onBack={() => {
            setView('reviews')
            setReview(null)
          }}
        />
      ) : null}
      {error ? <div className="toast">{error}</div> : null}
    </Shell>
  )
}

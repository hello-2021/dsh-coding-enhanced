import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, login, register } from './api.js'

const NAV_ITEMS = [
  { id: 'standby', label: 'Standby' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'devices', label: 'Devices' },
]

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

function shortId(value) {
  return String(value ?? '').slice(0, 18)
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const supported = typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'

  const submit = async (event) => {
    event.preventDefault()
    if (busy || username.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const data = mode === 'register' ? await register(username.trim()) : await login(username.trim())
      onUser(data.user)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand-mark">DSH</div>
        <h1>Review, remotely.</h1>
        <p className="muted">A passkey-protected review surface for DSH. No password.</p>

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
              autoComplete="username webauthn"
              placeholder="your-name"
              disabled={busy}
            />
          </label>
          {error ? <div className="error">{error}</div> : null}
          {!supported ? <div className="error">This browser does not expose WebAuthn. Use Safari/Chrome on localhost.</div> : null}
          <button className="button primary wide" type="submit" disabled={busy || !supported || username.trim() === ''}>
            {busy ? 'Waiting for passkey…' : mode === 'register' ? 'Create passkey' : 'Continue with passkey'}
          </button>
        </form>

        <p className="fineprint">
          Open <code>http://localhost:4317</code> (or the Vite origin) so WebAuthn has a secure context.
        </p>
      </div>
    </div>
  )
}

function Shell({ user, view, onNavigate, socketState, devices, onLogout, children }) {
  const online = devices.filter((device) => device.online).length
  return (
    <div className="app">
      <aside className="sidebar">
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
          <div className="topbar-title">{view === 'review' ? 'Review' : NAV_ITEMS.find((item) => item.id === view)?.label ?? 'Standby'}</div>
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

function NoteBar({ notes }) {
  if (!Array.isArray(notes) || notes.length === 0) return null
  return (
    <div className="notes">
      {notes.map((note, index) => (
        <div className="note" key={`${note.line ?? note.hunk ?? 'note'}-${index}`}>
          <span className="ai">AI</span>
          <span className="note-text">{note.text}</span>
          {note.line ? <span className="note-anchor">line {note.line}</span> : note.hunk ? <span className="note-anchor">hunk {note.hunk}</span> : null}
        </div>
      ))}
    </div>
  )
}

function DiffView({ entry }) {
  if (!entry) return null
  const hunks = Array.isArray(entry.hunks) ? entry.hunks : []
  if (hunks.length === 0) {
    return (
      <div className="empty">
        <strong>No text hunks</strong>
        <span>The file may be binary, too large, or unchanged in this round.</span>
      </div>
    )
  }
  return (
    <div className="diff">
      {hunks.map((hunk, hunkIndex) => (
        <div className="hunk" key={hunkIndex}>
          <div className="hunk-head">{hunk.header ?? `@@ hunk ${hunkIndex + 1} @@`}</div>
          {(hunk.lines ?? []).map((line, lineIndex) => (
            <div className={`line ${line.type}`} key={lineIndex}>
              <span className="no">{line.oldNo ?? ''}</span>
              <span className="no">{line.newNo ?? ''}</span>
              <span className="sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
              <span className="text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function ReviewDetail({ review, onBack }) {
  const entries = Array.isArray(review?.entries) ? review.entries : []
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    setActiveIndex(0)
  }, [review?.id])

  if (!review) {
    return (
      <div className="stack">
        <button type="button" className="link-button" onClick={onBack}>
          ← Reviews
        </button>
        <Empty title="Review not loaded" hint="Open it again from the Reviews list." />
      </div>
    )
  }

  const index = Math.min(activeIndex, Math.max(0, entries.length - 1))
  const entry = entries[index]
  const status = statusOf(review)

  return (
    <div className="review-page">
      <div className="review-head">
        <button type="button" className="link-button" onClick={onBack}>
          ← Reviews
        </button>
        <div className="review-title">
          <h2>{reviewTitle(review)}</h2>
          <span className={`pill ${status}`}>{status}</span>
        </div>
        <div className="muted">
          session {shortId(review.sessionId)} · {entries.length} file{entries.length === 1 ? '' : 's'} · v{review.version ?? 0}
        </div>
      </div>

      {entries.length === 0 ? (
        <Empty title="No files in this review" hint="The snapshot has no entries yet." />
      ) : (
        <div className="review-layout">
          <aside className="file-rail">
            {entries.map((item, itemIndex) => (
              <button
                key={item.id ?? item.path ?? itemIndex}
                type="button"
                className={itemIndex === index ? 'file-item active' : 'file-item'}
                onClick={() => setActiveIndex(itemIndex)}
              >
                <span className="file-path">{item.display ?? item.path}</span>
                <span className="file-stat">
                  <span className="add">+{item.added ?? 0}</span>
                  <span className="del">−{item.removed ?? 0}</span>
                </span>
                {item.warning ? <span className="file-warning">!</span> : null}
              </button>
            ))}
          </aside>
          <section className="diff-pane">
            {entry ? (
              <>
                <div className="diff-head">
                  <div>
                    <strong>{entry.display ?? entry.path}</strong>
                    <span className="muted">
                      {entry.isNew ? 'new file' : 'modified'}
                      {entry.truncated ? ' · truncated' : ''}
                    </span>
                  </div>
                  <div className="diff-actions">
                    <button type="button" className="button small" disabled title="Decision apply arrives with the plugin bridge (W2/W3)">
                      Approve
                    </button>
                    <button type="button" className="button small" disabled title="Decision apply arrives with the plugin bridge (W2/W3)">
                      Reject
                    </button>
                  </div>
                </div>
                {entry.warning ? <div className="warning">{entry.warning}</div> : null}
                <NoteBar notes={entry.notes} />
                <DiffView entry={entry} />
              </>
            ) : null}
          </section>
        </div>
      )}

      <div className="finish-bar">
        <span className="muted">Review decisions and Finish will be enabled with the plugin bridge (W2/W3).</span>
        <button type="button" className="button primary" disabled>
          Finish review
        </button>
      </div>
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

  const loadDevices = useCallback(async () => {
    const data = await api('/api/devices')
    setDevices(Array.isArray(data.devices) ? data.devices : [])
  }, [])

  const loadReviews = useCallback(async () => {
    const data = await api('/api/reviews')
    setReviews(Array.isArray(data.reviews) ? data.reviews : [])
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
          setError('Review result received.')
          loadReviews().catch(() => {})
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
    setView('standby')
  }

  const onNavigate = (next) => {
    setView(next)
    if (next !== 'review') setReview(null)
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

  if (booting) return <div className="boot">Loading…</div>
  if (!user) return <AuthScreen onUser={onUser} />

  return (
    <Shell user={user} view={view} onNavigate={onNavigate} socketState={socketState} devices={devices} onLogout={onLogout}>
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
        <ReviewDetail
          review={review}
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

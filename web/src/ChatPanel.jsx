import React, { useEffect, useRef, useState } from 'react'

export default function ChatPanel({ messages, busy, error, onSend }) {
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('dsh.chat.collapsed') === '1'
    } catch {
      return false
    }
  })
  const threadRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    try {
      window.localStorage.setItem('dsh.chat.collapsed', collapsed ? '1' : '0')
    } catch {}
  }, [collapsed])

  useEffect(() => {
    const node = threadRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages.length, busy, collapsed])

  const send = () => {
    const text = draft.trim()
    if (text === '' || busy) return
    setDraft('')
    onSend(text)
  }

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  const expand = () => {
    setCollapsed(false)
    window.setTimeout(() => inputRef.current?.focus(), 30)
  }

  if (collapsed) {
    return (
      <button type="button" className="chat-panel collapsed" onClick={expand} aria-label="Expand Ask AI">
        <span className="chat-orb" />
        <span className="chat-title">Ask AI</span>
        <span className="chat-chevron">⌃</span>
      </button>
    )
  }

  return (
    <section className="chat-panel">
      <header className="chat-head">
        <span className="chat-orb" />
        <span className="chat-title">Ask AI</span>
        <span className="chat-sub">project</span>
        <span className={`chat-status${busy ? ' busy' : ''}`} title={busy ? 'Thinking' : 'Ready'} />
        <button type="button" className="chat-chevron" title="Collapse" aria-label="Collapse Ask AI" onClick={() => setCollapsed(true)}>
          ⌄
        </button>
      </header>

      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && !busy ? (
          <p className="chat-empty">Ask about a review, a file, or what to fix next.</p>
        ) : null}

        {messages.map((message) => (
          <div className={`chat-msg ${message.role}`} key={message.id ?? `${message.role}-${message.createdAt}`}>
            <span className="chat-who">{message.role === 'user' ? 'Y' : 'AI'}</span>
            <span className="chat-bubble">{message.text}</span>
          </div>
        ))}

        {busy ? (
          <div className="chat-msg ai">
            <span className="chat-who">AI</span>
            <span className="chat-typing" aria-label="Thinking"><i /><i /><i /></span>
          </div>
        ) : null}

        {error ? <div className="chat-error">{error}</div> : null}
      </div>

      <div className="chat-ask">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about any review…"
          disabled={busy}
          rows={2}
        />
        <button type="button" className="chat-send" onClick={send} disabled={busy || draft.trim() === ''}>
          Send
        </button>
      </div>
    </section>
  )
}

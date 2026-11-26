import React, { useEffect, useRef, useState } from 'react'

const SUGGESTIONS = [
  'Summarize open reviews',
  'What changed in the latest review?',
  'Which files are still waiting?',
]

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
        <span className="chat-mark">✦</span>
        <span className="chat-collapsed-copy">
          <span className="chat-title">Ask AI</span>
          <span className="chat-sub">{busy ? 'thinking…' : 'project + reviews'}</span>
        </span>
        <span className="chat-expand">⌃</span>
      </button>
    )
  }

  return (
    <section className="chat-panel">
      <header className="chat-head">
        <div className="chat-brand">
          <span className="chat-mark">✦</span>
          <span className="chat-brand-copy">
            <span className="chat-title">Ask AI</span>
            <span className="chat-sub">project + reviews</span>
          </span>
        </div>
        <div className="chat-head-actions">
          <span className={`chat-live${busy ? ' busy' : ''}`}><i />{busy ? 'thinking' : 'live'}</span>
          <button type="button" className="chat-icon-button" title="Collapse" aria-label="Collapse Ask AI" onClick={() => setCollapsed(true)}>
            –
          </button>
        </div>
      </header>

      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && !busy ? (
          <div className="chat-empty">
            <span className="chat-empty-mark">✦</span>
            <strong>Ask about anything in this project.</strong>
            <span>Reviews, files, decisions, or what to fix next.</span>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chat-suggestion"
                  onClick={() => {
                    setDraft(suggestion)
                    inputRef.current?.focus()
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => (
          <div className={`chat-bubble ${message.role}`} key={message.id ?? `${message.role}-${message.createdAt}`}>
            <span className={`chat-avatar ${message.role}`}>{message.role === 'user' ? 'Y' : 'AI'}</span>
            <span className="chat-body">
              <span className="chat-role">{message.role === 'user' ? 'You' : 'AI'}</span>
              <span className="chat-text">{message.text}</span>
            </span>
          </div>
        ))}

        {busy ? (
          <div className="chat-bubble assistant">
            <span className="chat-avatar assistant">AI</span>
            <span className="chat-body">
              <span className="chat-role">AI</span>
              <span className="chat-typing" aria-label="Thinking"><i /><i /><i /></span>
            </span>
          </div>
        ) : null}

        {error ? <div className="chat-error">{error}</div> : null}
      </div>

      <div className="chat-composer">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about any review…"
          disabled={busy}
          rows={3}
        />
        <div className="chat-composer-foot">
          <span className="chat-hint">Enter to send · Shift+Enter newline</span>
          <button
            type="button"
            className="chat-send"
            onClick={send}
            disabled={busy || draft.trim() === ''}
            aria-label="Send question"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 13V3M8 3 3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </section>
  )
}

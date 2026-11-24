import React, { useEffect, useRef, useState } from 'react'

export default function ChatPanel({ messages, busy, error, onSend }) {
  const [draft, setDraft] = useState('')
  const threadRef = useRef(null)

  useEffect(() => {
    const node = threadRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages.length, busy])

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

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span>Ask AI</span>
        <span className="muted">any review</span>
      </div>
      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && !busy ? (
          <p className="chat-empty">Ask about any review. You can reference one by name, e.g. “review-auth-cleanup”.</p>
        ) : null}
        {messages.map((message) => (
          <div className={`chat-bubble ${message.role}`} key={message.id ?? `${message.role}-${message.createdAt}`}>
            <span className="chat-role">{message.role === 'user' ? 'You' : 'AI'}</span>
            <span className="chat-text">{message.text}</span>
          </div>
        ))}
        {busy ? (
          <div className="chat-bubble assistant">
            <span className="chat-role">AI</span>
            <span className="chat-typing">Thinking…</span>
          </div>
        ) : null}
        {error ? <div className="chat-error">{error}</div> : null}
      </div>
      <div className="chat-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about any review…"
          disabled={busy}
          rows={3}
        />
        <button type="button" className="button primary small" onClick={send} disabled={busy || draft.trim() === ''}>
          Send
        </button>
      </div>
    </div>
  )
}

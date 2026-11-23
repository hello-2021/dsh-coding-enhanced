import React, { useEffect, useState } from 'react'

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

function Empty({ title, hint }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>{hint}</span>
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

export default function ReviewDetail({ review, onBack, send }) {
  const entries = Array.isArray(review?.entries) ? review.entries : []
  const [activeIndex, setActiveIndex] = useState(0)
  const [decisions, setDecisions] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    setActiveIndex(0)
    setDecisions({})
    setSubmitting(false)
    setNotice(null)
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
  const finished = review.finished === true || review.canceled === true
  const busy = submitting || review.applying === true
  const allDecided = entries.length > 0 && entries.every((item) => decisions[item.id] !== undefined)

  const decide = (target, approved) => {
    if (!target || finished || busy) return
    setDecisions((current) => ({ ...current, [target.id]: { entryId: target.id, approved } }))
  }

  const finish = () => {
    if (!allDecided || finished || busy || typeof send !== 'function') return
    setSubmitting(true)
    setNotice('Decision sent. Waiting for DSH to apply…')
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now())
    send({
      type: 'decision',
      requestId,
      reviewId: review.id,
      decisionId: requestId,
      expectedVersion: review.version,
      decisions: entries.map((item) => decisions[item.id]),
    })
  }

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
            {entries.map((item, itemIndex) => {
              const decision = decisions[item.id]
              return (
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
                  {decision ? <span className={`pill ${decision.approved ? 'ok' : 'canceled'}`}>{decision.approved ? 'approve' : 'reject'}</span> : null}
                  {item.warning ? <span className="file-warning">!</span> : null}
                </button>
              )
            })}
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
                    <button
                      type="button"
                      className={decisions[entry.id]?.approved === true ? 'button small primary' : 'button small'}
                      disabled={finished || busy}
                      onClick={() => decide(entry, true)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={decisions[entry.id]?.approved === false ? 'button small primary' : 'button small'}
                      disabled={finished || busy}
                      onClick={() => decide(entry, false)}
                    >
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
        <span className="muted">
          {finished ? 'Review finished.' : allDecided ? 'All files decided. Finish applies them.' : 'Decide every file, then Finish.'}
        </span>
        <button type="button" className="button primary" disabled={finished || busy || !allDecided} onClick={finish}>
          {busy ? 'Applying…' : 'Finish review'}
        </button>
      </div>
      {notice ? <div className="toast">{notice}</div> : null}
    </div>
  )
}

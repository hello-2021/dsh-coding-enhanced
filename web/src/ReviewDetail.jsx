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

function decisionLabel(decision) {
  if (decision?.stale === true) return { className: 'pill submitted', text: 'changed' }
  if (decision?.outcome === 'edited') return { className: 'pill open', text: 'edited' }
  if (decision?.approved === true) return { className: 'pill ok', text: 'approve' }
  if (decision?.approved === false) return { className: 'pill canceled', text: 'reject' }
  return null
}

export default function ReviewDetail({ review, onBack, send }) {
  const entries = Array.isArray(review?.entries) ? review.entries : []
  const [decisions, setDecisions] = useState({})
  const [comments, setComments] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [viewerTab, setViewerTab] = useState('after')
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setDecisions({})
    setComments({})
    setSubmitting(false)
    setNotice(null)
    setViewer(null)
  }, [review?.id])

  useEffect(() => {
    if (!review) return
    setDecisions((current) => {
      let changed = false
      const next = { ...current }
      for (const item of entries) {
        const decision = current[item.id]
        if (!decision) continue
        const entryChanged = typeof decision.baseAfterText === 'string' && typeof item.afterText === 'string' && decision.baseAfterText !== item.afterText
        if (entryChanged && decision.stale !== true) {
          next[item.id] = { ...decision, stale: true }
          changed = true
        } else if (!entryChanged && decision.stale === true) {
          const copy = { ...decision }
          delete copy.stale
          next[item.id] = copy
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [review?.version])

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

  const status = statusOf(review)
  const finished = review.finished === true || review.canceled === true
  const busy = submitting || review.applying === true
  const staleFiles = entries.filter((item) => decisions[item.id]?.stale === true)
  const allDecided = entries.length > 0 && entries.every((item) => decisions[item.id] !== undefined) && staleFiles.length === 0

  const setComment = (id, value) => {
    setComments((current) => ({ ...current, [id]: value }))
  }

  const decide = (target, approved) => {
    if (!target || finished || busy) return
    setDecisions((current) => ({
      ...current,
      [target.id]: {
        entryId: target.id,
        approved,
        comment: comments[target.id] ?? '',
        baseAfterText: typeof target.afterText === 'string' ? target.afterText : undefined,
      },
    }))
  }

  const decideAll = (approved) => {
    if (finished || busy || entries.length === 0) return
    setDecisions((current) => {
      const next = { ...current }
      for (const item of entries) {
        next[item.id] = {
          entryId: item.id,
          approved,
          comment: comments[item.id] ?? '',
          baseAfterText: typeof item.afterText === 'string' ? item.afterText : undefined,
        }
      }
      return next
    })
  }

  const openViewer = (target, mode) => {
    if (!target) return
    const decision = decisions[target.id]
    setViewer({ entry: target, mode })
    setViewerTab(decision?.editedAfter !== undefined ? 'edited' : 'after')
    setDraft(decision?.editedAfter ?? (typeof target.afterText === 'string' ? target.afterText : ''))
  }

  const closeViewer = () => setViewer(null)

  const saveEdit = () => {
    const target = viewer?.entry
    if (!target) return
    if (draft === target.afterText) {
      setViewer(null)
      return
    }
    setDecisions((current) => ({
      ...current,
      [target.id]: {
        entryId: target.id,
        outcome: 'edited',
        editedAfter: draft,
        comment: comments[target.id] ?? '',
        baseAfterText: typeof target.afterText === 'string' ? target.afterText : undefined,
      },
    }))
    setViewer(null)
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
      decisions: entries.map((item) => {
        const decision = decisions[item.id]
        const common = {
          entryId: item.id,
          comment: decision?.comment ?? '',
          baseAfterText: decision?.baseAfterText,
        }
        if (decision?.outcome === 'edited') {
          return { ...common, outcome: 'edited', editedAfter: decision.editedAfter }
        }
        return { ...common, approved: decision?.approved === true }
      }),
    })
  }

  const viewerDecision = viewer ? decisions[viewer.entry.id] : undefined
  const currentViewerEntry = viewer ? entries.find((item) => (item.id ?? item.path) === (viewer.entry.id ?? viewer.entry.path)) : undefined
  const viewerStale = Boolean(
    viewer
      && currentViewerEntry
      && typeof viewer.entry.afterText === 'string'
      && typeof currentViewerEntry.afterText === 'string'
      && viewer.entry.afterText !== currentViewerEntry.afterText,
  )
  const viewerText =
    viewer?.mode === 'edit'
      ? draft
      : viewerTab === 'before'
        ? viewer?.entry?.beforeText ?? ''
        : viewerTab === 'edited'
          ? viewerDecision?.editedAfter ?? ''
          : viewer?.entry?.afterText ?? ''

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
        <div className="review-files">
          {entries.map((item, itemIndex) => {
            const decision = decisions[item.id]
            const label = decisionLabel(decision)
            const canView = typeof item.afterText === 'string'
            const canEdit = item.editable === true && canView
            return (
              <section className="review-file" key={item.id ?? item.path ?? itemIndex}>
                <header className="review-file-head">
                  <div className="review-file-path">
                    <strong>{item.display ?? item.path}</strong>
                    <span className="file-stat">
                      <span className="add">+{item.added ?? 0}</span>
                      <span className="del">−{item.removed ?? 0}</span>
                    </span>
                    {item.warning ? <span className="file-warning">!</span> : null}
                    {label ? <span className={label.className}>{label.text}</span> : null}
                  </div>
                  <div className="review-file-actions">
                    {canView ? (
                      <button type="button" className="button small" disabled={busy} onClick={() => openViewer(item, 'view')}>
                        View full file
                      </button>
                    ) : null}
                    {canEdit ? (
                      <button type="button" className="button small" disabled={finished || busy} onClick={() => openViewer(item, 'edit')}>
                        Edit
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={decision?.approved === true && !decision?.stale ? 'button small primary' : 'button small'}
                      disabled={finished || busy}
                      onClick={() => decide(item, true)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={decision?.approved === false && !decision?.stale ? 'button small primary' : 'button small'}
                      disabled={finished || busy}
                      onClick={() => decide(item, false)}
                    >
                      Reject
                    </button>
                  </div>
                </header>
                {decision?.stale ? (
                  <div className="stale-note">The AI changed this file after you decided. Review the new content and decide again.</div>
                ) : null}
                {item.warning ? <div className="warning">{item.warning}</div> : null}
                <div className="comment-row">
                  <textarea
                    className="comment-box"
                    placeholder="Message to the AI (optional; sent with this decision)"
                    value={comments[item.id] ?? ''}
                    onChange={(event) => setComment(item.id, event.target.value)}
                    disabled={finished || busy}
                  />
                </div>
                <NoteBar notes={item.notes} />
                <DiffView entry={item} />
              </section>
            )
          })}
        </div>
      )}

      <div className="finish-bar">
        <span className="muted">
          {finished ? 'Review finished.' : staleFiles.length > 0 ? `${staleFiles.length} file(s) changed while you were reviewing. Decide again.` : allDecided ? 'All files decided. Finish applies them.' : 'Decide every file, then Finish.'}
        </span>
        <div className="finish-actions">
          <button type="button" className="button small" disabled={finished || busy} onClick={() => decideAll(true)}>
            Approve all
          </button>
          <button type="button" className="button small" disabled={finished || busy} onClick={() => decideAll(false)}>
            Reject all
          </button>
          <button type="button" className="button primary" disabled={finished || busy || !allDecided} onClick={finish}>
            {busy ? 'Applying…' : 'Finish review'}
          </button>
        </div>
      </div>
      {notice ? <div className="toast">{notice}</div> : null}

      {viewer ? (
        <div className="modal-backdrop" onClick={closeViewer}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <strong>{viewer.entry.display ?? viewer.entry.path}</strong>
              <div className="modal-tabs">
                {viewer.mode === 'view' ? (
                  <>
                    <button type="button" className={viewerTab === 'after' ? 'tab active' : 'tab'} onClick={() => setViewerTab('after')}>
                      Proposed
                    </button>
                    <button type="button" className={viewerTab === 'before' ? 'tab active' : 'tab'} onClick={() => setViewerTab('before')}>
                      Original
                    </button>
                    {viewerDecision?.editedAfter !== undefined ? (
                      <button type="button" className={viewerTab === 'edited' ? 'tab active' : 'tab'} onClick={() => setViewerTab('edited')}>
                        Your edit
                      </button>
                    ) : null}
                  </>
                ) : (
                  <span className="muted">Editing whole file</span>
                )}
              </div>
              <button type="button" className="link-button" onClick={closeViewer}>
                Close
              </button>
            </div>
            {viewerStale ? (
              <div className="modal-stale">The AI updated this file while the modal was open. Close it and open the file again to edit the new content.</div>
            ) : null}
            <div className="modal-body">
              {viewer.mode === 'edit' ? (
                <textarea className="full-file-edit" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
              ) : (
                <pre className="full-file">{viewerText}</pre>
              )}
            </div>
            <div className="modal-actions">
              <span className="muted">
                {viewer.mode === 'edit'
                  ? 'Save marks this file as edited; Finish applies the edited content.'
                  : viewerTab === 'before'
                    ? 'Original content before this review.'
                    : viewerTab === 'edited'
                      ? 'The content you edited and saved. Re-open Edit to change it again.'
                      : 'Proposed content after this review.'}
              </span>
              {viewer.mode === 'edit' ? (
                <span className="modal-buttons">
                  <button type="button" className="button" onClick={closeViewer}>
                    Cancel
                  </button>
                  <button type="button" className="button primary" onClick={saveEdit} disabled={viewerStale || draft === viewer.entry.afterText}>
                    Save edit
                  </button>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

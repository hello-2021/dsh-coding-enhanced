/**
 * dsh-coding-enhanced — browser half.
 *
 * 1. Withdraw: an action in the assistant strip cancels the latest completed
 *    turn, greys it, and labels its changed-files line `已撤销`.
 * 2. Review gate: every `write`/`edit` the AI proposes opens a right-sidebar tab
 *    (like a file preview) that lists all changes with per-file diffs, Approve /
 *    Reject, an instruction box, and manual editing of the proposed content. A
 *    floating toolbox holds Approve all / Reject all / Finish.
 *
 * Transport: the authenticated Connection `/api` bridge (`POST
 * /api/coding-enhanced`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-coding-enhanced',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')

    const NS = 'coding-enhanced'
    const REVIEW_TAB_ID = 'dsh-coding-enhanced/review'
    const REVIEW_KIND = 'coding-enhanced-review'
    const inject = ['slots', 'connection', 'locale', 'sidebarRight', 'sidebarRightTabs']
    const EMPTY_TABS = []

    const en = {
      action: 'Withdraw this turn',
      confirm:
        'Withdraw turn {turn}?\n\nThe workspace will be restored to its state before this turn, and the AI will no longer see it in its context.',
      failed: 'Withdraw failed: {message}',
      badge: 'Withdrawn',
      files: 'restored {count} file(s)',
      reasonActive: 'The turn is still running',
      reasonNoSnapshot:
        'Available from the next turn: this turn started before the plugin recorded a workspace snapshot',

      reviewTitle: 'Code review',
      reviewSubtitle: '{count} file(s) · nothing is written until you finish',
      approve: 'Approve',
      reject: 'Reject',
      approved: 'Approved',
      rejected: 'Rejected',
      pending: 'Pending',
      comment: 'Instructions for the AI (sent when you reject this file)',
      finish: 'Finish',
      finishPending: '{count} file(s) still need a decision',
      approveAll: 'Approve all',
      rejectAll: 'Reject all',
      pendingPill: '{count} file(s) to review',
      submitting: 'Applying…',
      reviewFailed: 'Could not apply the review: {message}',
      newFile: 'new',
      truncated: 'Large diff — showing only the first part',
      noDiff: 'No line diff is available for this change.',
      loading: 'Loading review…',
      reviewClosed: 'No pending review.',
      edit: 'Edit',
      editDone: 'Done',
      reset: 'Reset',
      edited: 'Edited',
      editedHint: 'Edited files are applied automatically; no approve or reject needed.',
      editHint: 'Finish writes your edited content, not the AI proposal.',
      rejectAllKeepEdited: 'Reject all files that were not edited by hand? Your edited files will still be written.',
      rejectDiscard: 'This file has your edits. Rejecting discards them. Continue?',
      editedNeedsApprove: 'Some files have your edits but are marked Reject. Approve them or reset the edits before finishing.',
    }

    const zh = {
      action: '撤回本轮',
      confirm:
        '撤回第 {turn} 轮？\n\n工作区将恢复到本轮开始前，AI 的上下文中也不再包含这一轮。',
      failed: '撤回失败：{message}',
      badge: '已撤销',
      files: '恢复 {count} 个文件',
      reasonActive: '本轮仍在运行',
      reasonNoSnapshot: '从下一轮开始可用：本轮开始时插件还没有记录工作区快照',

      reviewTitle: '代码审查',
      reviewSubtitle: '{count} 个文件 · 全部确认后才会写入',
      approve: '通过',
      reject: '拒绝',
      approved: '已通过',
      rejected: '已拒绝',
      pending: '待确认',
      comment: '给 AI 的具体修改意见（拒绝该文件时发送）',
      finish: '完成',
      finishPending: '还有 {count} 个文件未确认',
      approveAll: '全部通过',
      rejectAll: '全部拒绝',
      pendingPill: '{count} 个文件待审查',
      submitting: '正在应用…',
      reviewFailed: '提交失败：{message}',
      newFile: '新增',
      truncated: '差异过大，仅显示前面部分',
      noDiff: '此改动没有可显示的行级差异。',
      loading: '正在加载审查…',
      reviewClosed: '没有待审查的改动。',
      edit: '编辑',
      editDone: '完成',
      reset: '还原',
      edited: '已修改',
      editedHint: '手动修改过的文件会直接写入，不需要再通过或拒绝。',
      editHint: '点击完成后写入你编辑后的内容，而不是 AI 的原始提案。',
      rejectAllKeepEdited: '拒绝所有未手动修改的文件？你手动修改过的文件仍会写入。',
      rejectDiscard: '这个文件有你的修改。拒绝会丢弃这些修改，继续吗？',
      editedNeedsApprove: '有文件包含你的修改但被标记为拒绝。请通过它们或还原修改后再完成。',
    }

    const STYLE_ID = 'dsh-coding-enhanced-styles'
    const CSS = `
[data-withdraw-canceled]{opacity:.45;filter:grayscale(1);transition:opacity .15s ease}
[data-withdraw-changes]::after{content:attr(data-withdraw-label);margin-left:8px;padding:0 6px;border-radius:4px;font-size:11px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}
[data-withdraw-button]{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color .12s,color .12s}
[data-withdraw-button]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
[data-withdraw-button]:disabled{opacity:.5;cursor:default}
[data-withdraw-badge]{display:inline-block;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);padding:0 6px;font-size:11px;line-height:18px;white-space:nowrap}

.wr-pane{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base)}
.wr-pane-head{display:flex;align-items:center;gap:8px;flex:none;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-base)}
.wr-pane-title{font-size:13px;font-weight:600;line-height:18px}
.wr-pane-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888)}
.wr-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 10px 76px;display:flex;flex-direction:column;gap:12px}
.wr-empty{display:flex;align-items:center;justify-content:center;height:100%;min-height:160px;color:var(--dsw-alias-label-tertiary,#888);font-size:12px}
.wr-file{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}
.wr-file.approved{border-color:var(--dsw-alias-state-success-primary,#2da44e)}
.wr-file.rejected{border-color:var(--dsw-alias-state-error-primary,#cf222e)}
.wr-file.edited{border-color:var(--dsw-alias-state-warn-primary,#9a6700)}
.wr-file-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-base,#fafafa)}
.wr-path{flex:1 1 100%;min-width:0;font-weight:600;font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wr-chip{flex:none;border-radius:4px;padding:0 6px;font-size:10px;line-height:16px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#555)}
.wr-chip.ok{color:var(--dsw-alias-state-success-primary,#2da44e)}
.wr-chip.no{color:var(--dsw-alias-state-error-primary,#cf222e)}
.wr-chip.edited{color:var(--dsw-alias-state-warn-primary,#9a6700);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a6700) 14%,transparent)}
.wr-add{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-state-success-primary,#2da44e)}
.wr-del{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-state-error-primary,#cf222e)}
.wr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:4px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:transparent;color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:11px;line-height:17px;cursor:pointer;white-space:nowrap}
.wr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.wr-btn:disabled{opacity:.45;cursor:default}
.wr-btn.sm{padding:2px 8px;font-size:11px}
.wr-btn.ok.active{border-color:var(--dsw-alias-state-success-primary,#2da44e);color:var(--dsw-alias-state-success-primary,#2da44e);background:var(--dsw-alias-file-diff-added-bg,rgba(46,160,67,.12))}
.wr-btn.no.active{border-color:var(--dsw-alias-state-error-primary,#cf222e);color:var(--dsw-alias-state-error-primary,#cf222e);background:var(--dsw-alias-file-diff-deleted-bg,rgba(248,81,73,.12))}
.wr-btn.primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-weight:600}
.wr-btn.primary:hover:not(:disabled){filter:brightness(1.05)}
.wr-note{margin:0;padding:5px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888)}
.wr-note.warn{color:var(--dsw-alias-state-warn-primary,#9a6700);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.wr-diff{max-height:340px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsw-code-font-size,11px);line-height:1.55;tab-size:4}
.wr-line{display:flex;white-space:pre}
.wr-line.add{background:var(--dsw-alias-file-diff-added-bg,rgba(46,160,67,.12))}
.wr-line.del{background:var(--dsw-alias-file-diff-deleted-bg,rgba(248,81,73,.12))}
.wr-line.add .wr-no{background:var(--dsw-alias-file-diff-added-gutter,rgba(46,160,67,.18))}
.wr-line.del .wr-no{background:var(--dsw-alias-file-diff-deleted-gutter,rgba(248,81,73,.18))}
.wr-no{flex:none;width:38px;padding-right:6px;text-align:right;color:var(--dsw-alias-label-tertiary,#999);user-select:none}
.wr-sign{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary,#999)}
.wr-text{flex:1;padding-right:10px;min-width:0}
.wr-hunk{padding:2px 6px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999);background:var(--dsw-alias-bg-base,#fafafa);border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.wr-comment{display:block;width:calc(100% - 20px);margin:8px 10px 10px;box-sizing:border-box;min-height:38px;resize:vertical;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:var(--dsw-alias-bg-base,#fafafa);color:inherit;font:inherit;font-size:11px;line-height:16px}
.wr-comment:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-1px}
.wr-editor{display:block;width:calc(100% - 20px);margin:8px 10px;box-sizing:border-box;min-height:220px;resize:vertical;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));background:var(--dsw-alias-bg-base,#fafafa);color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsw-code-font-size,11px);line-height:1.55;tab-size:4}
.wr-editor:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-1px}
.wr-toolbar{position:absolute;right:10px;bottom:10px;z-index:3;flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:max-content;max-width:calc(100% - 20px);padding:6px 8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.16)}
.wr-toolbar-info{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888);padding:0 4px}
.wr-error{color:var(--dsw-alias-state-error-primary,#cf222e);font-size:11px;line-height:16px;padding:0 4px}
.wr-pill{position:fixed;right:24px;bottom:24px;z-index:3999;display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:12px;line-height:18px;cursor:pointer;box-shadow:0 8px 28px rgba(0,0,0,.18)}
.wr-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
`

    function apply(ctx) {
      // ------------------------------------------------------------- copy ---
      try {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'coding-enhanced: dictionaries')
      } catch {}

      // ------------------------------------------------------------ styles ---
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'coding-enhanced: styles')

      // ------------------------------------------------------------- rpc ---
      const call = async (endpoint, payload) => {
        try {
          const response = await fetch('api/coding-enhanced', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload }),
          })
          if (!response.ok) {
            return { ok: false, error: { message: `HTTP ${response.status}` } }
          }
          return await response.json()
        } catch (error) {
          return { ok: false, error: { message: String(error) } }
        }
      }

      // -------------------------------------------------- withdraw store ---
      const records = new Map()
      const listeners = new Map()
      const inflight = new Map()
      const fetchedAt = new Map()

      const notify = (sessionId) => {
        const set = listeners.get(sessionId)
        if (set === undefined) return
        for (const listener of [...set]) listener()
      }

      const setRecord = (sessionId, record) => {
        records.set(sessionId, record)
        notify(sessionId)
      }

      const refresh = (sessionId, force = false) => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        if (!force && fetchedAt.has(sessionId) && Date.now() - fetchedAt.get(sessionId) < 250) {
          return inflight.get(sessionId)
        }
        const running = inflight.get(sessionId)
        if (running !== undefined) return running
        const promise = (async () => {
          const result = await call('status', { sessionId })
          if (result.ok === true) {
            records.set(sessionId, { status: 'ready', value: result.value })
          } else {
            records.set(sessionId, {
              status: 'error',
              message: result.error?.message ?? 'status failed',
            })
          }
          fetchedAt.set(sessionId, Date.now())
          notify(sessionId)
        })().finally(() => {
          inflight.delete(sessionId)
        })
        inflight.set(sessionId, promise)
        return promise
      }

      const subscribe = (sessionId, listener) => {
        let set = listeners.get(sessionId)
        if (set === undefined) {
          set = new Set()
          listeners.set(sessionId, set)
        }
        set.add(listener)
        return () => {
          set.delete(listener)
        }
      }

      const useRecord = (sessionId) => {
        const [, bump] = React.useState(0)
        React.useEffect(() => {
          const unsubscribe = subscribe(sessionId, () => bump((value) => value + 1))
          void refresh(sessionId)
          return unsubscribe
        }, [sessionId])
        return records.get(sessionId)
      }

      // -------------------------------------------------------- decorate ---
      const annotateChangedFiles = (node, label) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        let current = walker.nextNode()
        while (current !== null) {
          const text = (current.nodeValue ?? '').trim()
          if (text !== '' && /^(已编辑|Edited|編集しました)/.test(text)) {
            const button = current.parentElement?.closest('button')
            if (button !== null && button !== undefined) {
              button.setAttribute('data-withdraw-changes', '')
              button.setAttribute('data-withdraw-label', label)
              return
            }
          }
          current = walker.nextNode()
        }
      }

      const markTurn = (turn, own, label) => {
        const nodes = document.querySelectorAll(`[data-chat-turn="${turn}"]`)
        for (const node of nodes) {
          if (node !== own) node.setAttribute('data-withdraw-canceled', '')
          annotateChangedFiles(node, label)
        }
      }

      const clearTurn = (turn) => {
        const nodes = document.querySelectorAll(`[data-chat-turn="${turn}"]`)
        for (const node of nodes) {
          node.removeAttribute('data-withdraw-canceled')
          for (const decorated of node.querySelectorAll('[data-withdraw-changes]')) {
            decorated.removeAttribute('data-withdraw-changes')
            decorated.removeAttribute('data-withdraw-label')
          }
        }
      }

      // ------------------------------------------------------ components ---
      const UndoIcon = () =>
        React.createElement(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          React.createElement('path', { d: 'M3.5 6.5h6a3.5 3.5 0 0 1 0 7H6' }),
          React.createElement('path', { d: 'M6 3.5 3 6.5l3 3' }),
        )

      function WithdrawAction(props) {
        const { messageId, sessionId, t } = props
        const record = useRecord(sessionId)
        const [busy, setBusy] = React.useState(false)
        if (record === undefined || record.status !== 'ready') return null
        const value = record.value
        const turn = value?.anchors?.[messageId]
        if (turn === undefined) return null
        if (value?.turns?.[turn] !== undefined) return null
        const reason = value?.reason
        const unavailable = value?.canWithdraw === true
          ? null
          : reason === 'no-snapshot'
            ? (typeof t === 'function' ? t('reasonNoSnapshot') : 'No workspace snapshot for this turn')
            : reason === 'active'
              ? (typeof t === 'function' ? t('reasonActive') : 'The turn is still running')
              : undefined
        if (unavailable === undefined) return null

        const label = typeof t === 'function' ? t('action') : 'Withdraw this turn'
        const onClick = async () => {
          if (busy) return
          const question = typeof t === 'function'
            ? t('confirm', { turn: String(turn) })
            : `Withdraw turn ${turn}?`
          if (typeof window.confirm === 'function' && !window.confirm(question)) return
          setBusy(true)
          const result = await call('withdraw', { sessionId, turn })
          setBusy(false)
          if (result.ok !== true) {
            const message = result.error?.message ?? 'unknown error'
            if (typeof window.alert === 'function') {
              window.alert(typeof t === 'function' ? t('failed', { message }) : `Withdraw failed: ${message}`)
            }
            return
          }
          const previous = records.get(sessionId)
          const previousValue = previous?.status === 'ready' ? previous.value : {}
          setRecord(sessionId, {
            status: 'ready',
            value: {
              ...previousValue,
              canWithdraw: false,
              turns: {
                ...(previousValue.turns ?? {}),
                [turn]: { at: Date.now(), files: result.value?.files ?? 0 },
              },
            },
          })
          void refresh(sessionId, true)
        }

        return React.createElement(
          'button',
          {
            type: 'button',
            'data-withdraw-button': '',
            'aria-label': unavailable ?? label,
            title: unavailable ?? label,
            disabled: busy || unavailable !== null,
            onClick,
          },
          React.createElement(UndoIcon, null),
        )
      }

      function WithdrawMarker(props) {
        const { turn, sessionId, t } = props
        const record = useRecord(sessionId)
        const withdrawn = record?.status === 'ready' ? record.value?.turns?.[turn] : undefined
        const ref = React.useRef(null)
        const label = typeof t === 'function' ? t('badge') : 'Withdrawn'

        React.useEffect(() => {
          if (withdrawn === undefined) return undefined
          const own = ref.current?.closest('[data-chat-turn]') ?? null
          let timer
          const paint = () => markTurn(turn, own, label)
          paint()
          timer = window.setTimeout(paint, 150)
          return () => {
            window.clearTimeout(timer)
            clearTurn(turn)
          }
        }, [withdrawn, turn, label])

        if (withdrawn === undefined) return null
        const files = typeof withdrawn.files === 'number' && withdrawn.files > 0 ? withdrawn.files : 0
        const detail = files > 0 && typeof t === 'function' ? ` · ${t('files', { count: String(files) })}` : ''
        return React.createElement(
          'span',
          { ref, 'data-withdraw-badge': '' },
          `${label}${detail}`,
        )
      }

      // ---------------------------------------------------- review feed ---
      const feed = {
        version: -1,
        reviews: [],
        loaded: false,
        error: null,
        listeners: new Set(),
        timer: null,
        running: false,
      }

      const feedNotify = () => {
        for (const listener of [...feed.listeners]) listener()
      }

      const feedLoad = async (force) => {
        const since = force ? -1 : feed.version
        const result = await call('reviews', { since })
        if (result.ok !== true) {
          feed.error = result.error?.message ?? 'review load failed'
          if (!feed.loaded) {
            feed.loaded = true
            feedNotify()
          }
          return
        }
        if (result.value.unchanged === true) {
          if (!feed.loaded) {
            feed.loaded = true
            feedNotify()
          }
          return
        }
        feed.version = result.value.version
        feed.reviews = result.value.reviews ?? []
        feed.error = null
        feed.loaded = true
        feedNotify()
      }

      const feedLoop = async () => {
        if (!feed.running) return
        try {
          await feedLoad(false)
        } catch {}
        if (!feed.running) return
        feed.timer = window.setTimeout(feedLoop, 1000)
      }

      const feedSubscribe = (listener) => {
        feed.listeners.add(listener)
        if (!feed.running) {
          feed.running = true
          feed.timer = window.setTimeout(feedLoop, 0)
        }
        return () => {
          feed.listeners.delete(listener)
          if (feed.listeners.size === 0) {
            feed.running = false
            window.clearTimeout(feed.timer)
          }
        }
      }

      const feedRefresh = () => {
        void feedLoad(true)
      }

      const useReviews = () => {
        const [, bump] = React.useState(0)
        React.useEffect(() => {
          const unsubscribe = feedSubscribe(() => bump((value) => value + 1))
          return unsubscribe
        }, [])
        return feed
      }

      const useOpenTabs = () => {
        const service = ctx.get('sidebarRight')
        const subscribeTabs = React.useCallback((callback) => {
          if (service?.openTabs?.subscribe === undefined) return () => {}
          return service.openTabs.subscribe(callback)
        }, [service])
        const getTabs = React.useCallback(() => {
          try {
            return service?.openTabs?.getSnapshot?.() ?? EMPTY_TABS
          } catch {
            return EMPTY_TABS
          }
        }, [service])
        return React.useSyncExternalStore(subscribeTabs, getTabs)
      }

      const pendingReview = (reviews) =>
        reviews.find((review) => review.finished !== true && review.entries.length > 0)

      const openReviewTab = (reviewId) => {
        try {
          ctx.sidebarRight.openTab(REVIEW_KIND, { params: { reviewId } })
        } catch (error) {
          console.error('coding-enhanced: cannot open the review tab', error)
        }
      }

      // ------------------------------------------------------ watcher ---
      function ReviewWatcher(props) {
        const { sessionId, t } = props
        const state = useReviews()
        const tabs = useOpenTabs()
        const review = pendingReview(state.reviews)
        const opened = React.useRef(null)
        const tabOpen = tabs.some((tab) => tab.kind === REVIEW_KIND && tab.sessionId === sessionId)

        React.useEffect(() => {
          if (!state.loaded || review === undefined) return
          if (opened.current === review.id) return
          opened.current = review.id
          openReviewTab(review.id)
        }, [state.loaded, review?.id])

        React.useEffect(() => {
          if (review === undefined) opened.current = null
        }, [review?.id])

        if (!state.loaded || review === undefined || tabOpen) return null
        return ReactDOM.createPortal(
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'wr-pill',
              onClick: () => {
                opened.current = review.id
                openReviewTab(review.id)
              },
            },
            typeof t === 'function'
              ? t('pendingPill', { count: String(review.entries.length) })
              : `${review.entries.length} files to review`,
          ),
          document.body,
        )
      }

      // ------------------------------------------------------ review tab ---
      function ReviewTab(props) {
        const { sessionId, useTabInfo, t } = props
        const { tab } = useTabInfo()
        const state = useReviews()
        const review = pendingReview(state.reviews)
        const [local, setLocal] = React.useState({})
        const [submitting, setSubmitting] = React.useState(false)
        const [error, setError] = React.useState(null)
        const finishedRef = React.useRef(false)
        const currentReviewRef = React.useRef(review)
        currentReviewRef.current = review

        React.useEffect(() => {
          setLocal({})
          setError(null)
          finishedRef.current = false
        }, [review?.id])

        React.useEffect(() => {
          const signal = tab?.signal
          if (signal === undefined) return undefined
          const onAbort = () => {
            if (finishedRef.current) return
            const current = currentReviewRef.current
            if (current === undefined) return
            void call('cancel', { reviewId: current.id })
          }
          signal.addEventListener('abort', onAbort, { once: true })
          return () => signal.removeEventListener('abort', onAbort)
        }, [tab])

        React.useEffect(() => {
          if (!state.loaded || review !== undefined) return undefined
          const timer = window.setTimeout(() => {
            try {
              tab.actions.close()
            } catch {}
          }, 500)
          return () => window.clearTimeout(timer)
        }, [state.loaded, review?.id, tab])

        if (!state.loaded) {
          return React.createElement('div', { className: 'wr-empty' }, typeof t === 'function' ? t('loading') : 'Loading review…')
        }
        if (review === undefined) {
          return React.createElement('div', { className: 'wr-empty' }, typeof t === 'function' ? t('reviewClosed') : 'No pending review.')
        }

        const decisionOf = (entryId) => local[entryId] ?? {}
        const patchEntry = (entryId, patch) => {
          setLocal((previous) => ({
            ...previous,
            [entryId]: { ...(previous[entryId] ?? {}), ...patch },
          }))
        }
        const decide = (entryId, approved) => patchEntry(entryId, { approved })
        const setAll = (approved) => {
          const edited = review.entries.filter((entry) => isDirty(entry))
          if (
            approved === false
            && edited.length > 0
            && typeof window.confirm === 'function'
            && !window.confirm(t('rejectAllKeepEdited'))
          ) {
            return
          }
          setLocal((previous) => {
            const next = { ...previous }
            for (const entry of review.entries) {
              if (approved === false && isDirty(entry)) continue
              next[entry.id] = { ...(next[entry.id] ?? {}), approved }
            }
            return next
          })
        }
        const isDirty = (entry) => {
          const localEntry = decisionOf(entry.id)
          return entry.editable === true
            && typeof localEntry.editedAfter === 'string'
            && entry.afterText !== null
            && localEntry.editedAfter !== entry.afterText
        }
        const rejectEntry = (entry) => decide(entry.id, false)
        const undecided = review.entries.filter((entry) => !isDirty(entry) && typeof decisionOf(entry.id).approved !== 'boolean').length

        const finish = async () => {
          if (undecided > 0 || submitting) return
          setSubmitting(true)
          setError(null)
          const decisions = review.entries.map((entry) => {
            const localEntry = decisionOf(entry.id)
            const edited = localEntry.editedAfter
            const included = entry.editable === true
              && typeof edited === 'string'
              && edited !== entry.afterText
            return included
              ? { entryId: entry.id, outcome: 'edited', editedAfter: edited }
              : {
                  entryId: entry.id,
                  approved: localEntry.approved === true,
                  comment: localEntry.comment ?? '',
                }
          })
          const result = await call('decide', { reviewId: review.id, decisions })
          setSubmitting(false)
          if (result.ok !== true) {
            const message = result.error?.message ?? 'unknown error'
            setError(typeof t === 'function' ? t('reviewFailed', { message }) : `Review failed: ${message}`)
            feedRefresh()
            return
          }
          finishedRef.current = true
          feedRefresh()
          try {
            tab.actions.close()
          } catch {}
        }

        const renderFile = (entry) => {
          const localEntry = decisionOf(entry.id)
          const dirty = isDirty(entry)
          const status = dirty ? 'edited' : localEntry.approved === true ? 'approved' : localEntry.approved === false ? 'rejected' : 'pending'
          const statusLabel = dirty
            ? (typeof t === 'function' ? t('edited') : 'Edited')
            : status === 'approved'
              ? (typeof t === 'function' ? t('approved') : 'Approved')
              : status === 'rejected'
                ? (typeof t === 'function' ? t('rejected') : 'Rejected')
                : (typeof t === 'function' ? t('pending') : 'Pending')
          const editing = localEntry.editing === true
          const editedText = localEntry.editedAfter ?? entry.afterText ?? ''

          const diff = entry.hunks.length === 0
            ? React.createElement('div', { className: 'wr-note' }, typeof t === 'function' ? t('noDiff') : 'No diff')
            : entry.hunks.map((hunk, hunkIndex) =>
                React.createElement(
                  'div',
                  { key: `h${hunkIndex}` },
                  React.createElement('div', { className: 'wr-hunk' }, hunk.header),
                  hunk.lines.map((line, lineIndex) =>
                    React.createElement(
                      'div',
                      { key: lineIndex, className: `wr-line ${line.type}` },
                      React.createElement('span', { className: 'wr-no' }, line.oldNo === null ? '' : line.oldNo),
                      React.createElement('span', { className: 'wr-no' }, line.newNo === null ? '' : line.newNo),
                      React.createElement('span', { className: 'wr-sign' }, line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '),
                      React.createElement('span', { className: 'wr-text' }, line.text === '' ? ' ' : line.text),
                    ),
                  ),
                ),
              )

          return React.createElement(
            'div',
            { key: entry.id, className: `wr-file ${status}` },
            React.createElement(
              'div',
              { className: 'wr-file-head' },
              React.createElement('span', { className: 'wr-path', title: entry.path }, entry.display),
              entry.isNew === true ? React.createElement('span', { className: 'wr-chip' }, typeof t === 'function' ? t('newFile') : 'new') : null,
              React.createElement('span', { className: 'wr-add' }, `+${entry.added}`),
              React.createElement('span', { className: 'wr-del' }, `-${entry.removed}`),
              React.createElement('span', { className: `wr-chip ${status === 'approved' ? 'ok' : status === 'rejected' ? 'no' : status === 'edited' ? 'edited' : ''}` }, statusLabel),
              dirty
                ? React.createElement(
                    'button',
                    { type: 'button', className: 'wr-btn sm', onClick: () => patchEntry(entry.id, { editedAfter: entry.afterText, approved: undefined }) },
                    typeof t === 'function' ? t('reset') : 'Reset',
                  )
                : React.createElement(
                    'button',
                    { type: 'button', className: `wr-btn sm ok${status === 'approved' ? ' active' : ''}`, onClick: () => decide(entry.id, true) },
                    typeof t === 'function' ? t('approve') : 'Approve',
                  ),
              dirty
                ? null
                : React.createElement(
                    'button',
                    { type: 'button', className: `wr-btn sm no${status === 'rejected' ? ' active' : ''}`, onClick: () => rejectEntry(entry) },
                    typeof t === 'function' ? t('reject') : 'Reject',
                  ),
              entry.editable === true
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'wr-btn sm',
                      onClick: () => patchEntry(entry.id, {
                        editing: !editing,
                        ...(!editing && typeof localEntry.editedAfter !== 'string' ? { editedAfter: entry.afterText } : {}),
                      }),
                    },
                    editing
                      ? (typeof t === 'function' ? t('editDone') : 'Done')
                      : (typeof t === 'function' ? t('edit') : 'Edit'),
                  )
                : null,
            ),
            entry.warning !== null && entry.warning !== undefined
              ? React.createElement('div', { className: 'wr-note warn' }, entry.warning)
              : null,
            entry.truncated === true
              ? React.createElement('div', { className: 'wr-note' }, typeof t === 'function' ? t('truncated') : 'Large diff')
              : null,
            React.createElement('div', { className: 'wr-diff' }, diff),
            editing
              ? React.createElement(
                  'div',
                  null,
                  React.createElement('div', { className: 'wr-note' }, typeof t === 'function' ? t('editHint') : 'Finish writes your edited content.'),
                  React.createElement('textarea', {
                    className: 'wr-editor',
                    value: editedText,
                    spellCheck: false,
                    onChange: (event) => patchEntry(entry.id, { editedAfter: event.target.value, approved: true }),
                  }),
                  React.createElement(
                    'div',
                    { style: { padding: '0 10px 8px' } },
                    React.createElement(
                      'button',
                      { type: 'button', className: 'wr-btn sm', onClick: () => patchEntry(entry.id, { editedAfter: entry.afterText }) },
                      typeof t === 'function' ? t('reset') : 'Reset',
                    ),
                  ),
                )
              : null,
            dirty
              ? React.createElement('div', { className: 'wr-note' }, typeof t === 'function' ? t('editedHint') : 'Edited files are applied automatically.')
              : React.createElement('textarea', {
                  className: 'wr-comment',
                  value: localEntry.comment ?? '',
                  placeholder: typeof t === 'function' ? t('comment') : 'Instructions for the AI',
                  onChange: (event) => patchEntry(entry.id, { comment: event.target.value }),
                  rows: 2,
                }),
          )
        }

        return React.createElement(
          'div',
          { className: 'wr-pane' },
          React.createElement(
            'div',
            { className: 'wr-pane-head' },
            React.createElement('span', { className: 'wr-pane-title' }, typeof t === 'function' ? t('reviewTitle') : 'Code review'),
            React.createElement(
              'span',
              { className: 'wr-pane-sub' },
              typeof t === 'function'
                ? t('reviewSubtitle', { count: String(review.entries.length) })
                : `${review.entries.length} files`,
            ),
          ),
          React.createElement(
            'div',
            { className: 'wr-scroll' },
            review.entries.map(renderFile),
            React.createElement(
              'div',
              { className: 'wr-toolbar' },
              React.createElement('button', { type: 'button', className: 'wr-btn', onClick: () => setAll(true) }, typeof t === 'function' ? t('approveAll') : 'Approve all'),
              React.createElement('button', { type: 'button', className: 'wr-btn', onClick: () => setAll(false) }, typeof t === 'function' ? t('rejectAll') : 'Reject all'),
              undecided > 0
                ? React.createElement('span', { className: 'wr-toolbar-info' }, typeof t === 'function' ? t('finishPending', { count: String(undecided) }) : `${undecided} pending`)
                : null,
              error !== null ? React.createElement('span', { className: 'wr-error' }, error) : null,
              React.createElement(
                'button',
                { type: 'button', className: 'wr-btn primary', disabled: undecided > 0 || submitting, onClick: finish },
                submitting
                  ? (typeof t === 'function' ? t('submitting') : 'Applying…')
                  : (typeof t === 'function' ? t('finish') : 'Finish'),
              ),
            ),
          ),
        )
      }

      // ------------------------------------------------ tab registration ---
      const bindT = ctx.locale.bind(NS)
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: REVIEW_TAB_ID,
          kind: REVIEW_KIND,
          title: () => (typeof bindT === 'function' ? bindT('reviewTitle') : 'Code review'),
        }), 'coding-enhanced: review tab type')
      } catch (error) {
        ctx.logger?.warn?.(`coding-enhanced: cannot register the review tab type: ${String(error)}`)
      }

      // ------------------------------------------------------------ slots ---
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'coding-enhanced',
            order: 40,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          },
          WithdrawAction,
        ),
      )

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'coding-enhanced-marker',
            order: 200,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          },
          WithdrawMarker,
        ),
      )

      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'coding-enhanced-review-watcher',
            order: 60,
            locale: NS,
            inject: (sessionId) => ({ sessionId }),
          },
          ReviewWatcher,
        ),
      )

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: REVIEW_TAB_ID,
            locale: NS,
          },
          ReviewTab,
        ),
      )

      ctx.on('connection/reset', () => {
        for (const sessionId of records.keys()) {
          fetchedAt.delete(sessionId)
          void refresh(sessionId, true)
        }
        feedRefresh()
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

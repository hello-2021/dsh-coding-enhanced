# Review contract: prompts & chain

> Version: **0.8.5** · Date: 2026-11-22 · Source: `dsh-coding-enhanced`
>
> This document records the exact prompts, tool contracts and execution chain
> of the AI change-review workflow. It is intended as a reference for
> documentation and blog posts; the code is authoritative if the two differ.

---

## 1. Positioning

`dsh-coding-enhanced` is **not another AI PR reviewer**. It is a workflow layer
for DSH agents:

- **Pre-write change gate** — native file tools are refused while Pre-review is on;
  the agent queues `review_write` / `review_patch`; nothing lands until the user
  finishes.
- **Workspace time machine** — per-turn shadow-git snapshots and multi-turn withdraw.
- **Non-blocking review handoff** — the plugin starts a persistent waiter child;
  the main agent continues or ends its turn and is woken when the review finishes.
- **Remote + cross-AI** — planned: passkey web review and an external cross-review API.

The direct prior art is [`9087/dsh-diff-approval`](https://github.com/9087/dsh-diff-approval)
(a post-edit review panel). The differentiator is the **gate + withdraw + handoff**,
not the diff pixels. See [`prior-art.md`](prior-art.md).

---

## 2. Architecture

```text
┌──────────────────────────── DSH host ────────────────────────────┐
│ main agent (session)                                             │
│  ├─ system prompt (the velvet rope)                              │
│  ├─ native tools: read / write / edit / ...                      │
│  └─ review tools: review_write / review_patch / review_wait      │
│                                                                  │
│ plugin: coding-enhanced (host, lib/index.js)                      │
│  ├─ native gate: tools/pre-execute                               │
│  ├─ review state: entries / notes / decisions / waitKey          │
│  ├─ per-file notes validation                                    │
│  ├─ auto waiter: ensureReviewWaiter → ctx.subagents              │
│  ├─ shadow-git snapshots / withdraw                              │
│  ├─ settings / updates / RPC /api/coding-enhanced                │
│  └─ client bundle (lib/client.js)                                │
│                                                                  │
│ ctx.subagents (manager)                                          │
│  ├─ spawn provider: a fresh child agent                          │
│  └─ fork provider: a child seeded with the parent conversation   │
│                                                                  │
│ review waiter child (spawn) ── review_wait ──► review state      │
│        │                                                         │
│        └── completion message ──► main agent wakes               │
│                                                                  │
│ client                                                           │
│  ├─ input Review tools: Pre-review / AI explanations             │
│  ├─ Code review tab: diff / AI rows / decisions / Finish          │
│  └─ Settings / plugin page: Updates / About                       │
└──────────────────────────────────────────────────────────────────┘
```

### Components

| Layer | File | Responsibility |
|---|---|---|
| Host | `lib/index.js` | system prompt, tools, gate, review state, validation, waiter, settings, snapshots, RPC |
| Client | `lib/client.js` | Review tools popover, review tab, settings, plugin page, diff and AI rows |
| DSH | `ctx.tools`, `ctx.subagents`, `ctx.sessions` | tool registry, subagent manager, sessions |
| Bridge | `/api/coding-enhanced` | authenticated RPC between client and host |

---

## 3. The prompts

### 3.1 System prompt (injected every turn while the gate is on)

```text
🎟️ FILE-EDIT VELVET ROPE: The human personally reviews every file change.
Queue every change with review_write (new file / full file) or review_patch
(unified diff) and include at least one note per changed file while AI
explanations are on; add line-level notes for user-requested, key or
hard-to-understand changes (no upper limit). Do not use write/edit/apply_patch/
str_replace_editor. The plugin starts or reuses the review waiter automatically:
after queueing, just continue or end the turn; never call review_wait and do
not manage a subagent. If a file is rejected, read the comment and revise.
This is house rules. 💅
```

### 3.2 `review_write`

```text
Queue a new file or a full-file rewrite for the user's review. This does not
write the file: the change is held in the Code review tab until the user
finishes. Use review_patch for edits to existing files. At least one notes
entry per changed file is required while AI explanations are on; prefer
line-level notes (line/hunk) for user-requested, key or hard-to-understand
changes. Each note is 1-2 sentences explaining why. The plugin starts or
reuses the review waiter automatically; just queue and continue, and never
call review_wait from the main agent.
```

### 3.3 `review_patch`

```text
Queue a unified diff for the user's review. The patch must use ---/+++ headers
and @@ hunks with paths relative to the working directory; a/ and b/ prefixes
and diff --git headers are accepted. Use one patch per file when possible;
multiple files are allowed. This does not modify the workspace: the change is
held in the Code review tab until the user finishes. At least one notes entry
per changed file is required while AI explanations are on; prefer line-level
notes (line/hunk) for user-requested, key or hard-to-understand changes. Each
note is 1-2 sentences explaining why. The plugin starts or reuses the review
waiter automatically; just queue and continue, and never call review_wait
from the main agent.

Example:
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,9 @@
   const app = createApp()
-  app.use(oldRouter)
+  app.use(newRouter)
+  app.use(logger)
   app.listen(3000)
```

### 3.4 `review_wait`

```text
Wait for a review. Only a review waiter subagent should call this: pass the
reviewId and waitKey from review_write/review_patch. The main agent must not
call it; if it does, the call is refused so the turn never blocks. Returns one
structured result per file: applied, rejected (with the user's comment),
edited, or failed.
```

### 3.5 Native gate denial

```text
File changes must go through the review gate while Pre-review is on. Use
review_write (new file / full file) or review_patch (unified diff) with at
least one note per changed file; the plugin starts or reuses the review waiter
automatically; just continue. Never call review_wait from the main agent.
Shell commands are outside the review.
```

### 3.6 Per-file validation errors

Multi-file patch:

```text
AI explanations are on: add at least one note for each changed file.
Missing: <file1>, <file2>.
Turn off AI explanations in the input bar to queue without notes.
```

Single-file write:

```text
AI explanations are on: add at least one note for this file. Use line-level
notes for user-requested, key or hard-to-understand changes. Turn off AI
explanations in the input bar to queue without notes.
```

### 3.7 UI strings (0.8.4)

```text
AI explanations
Require at least one note per changed file. Off: queue changes without notes.
```

```text
AI 解释
每个改动文件至少一条说明。关闭后排队不再要求解释。
```

---

## 4. The chain

```text
[input Review tools]
  AI explanations toggle
        │ setSettings({ aiExplain })
        ▼
[plugin host featureFlags]
        │ system prompt + tool descriptions
        ▼
[main AI]
  review_write / review_patch (notes)
        │
        ▼
[host validation]
  aiExplain on?
  every changed file covered?
        │
        ▼
[review state]
  entries / notes / decisions / waitKey
        │
        ├──────────────► [Code review tab]
        │                  diff + AI rows
        │                  Approve / Reject / Edit / Finish
        │                        │
        │                        ▼
        │                  host applies files
        │
        └──────────────► [ensureReviewWaiter]
                           scoped subagent tool → spawn child
                           child: review_wait(reviewId, waitKey)
                                 │
                                 ▼
                           review finishes
                                 │
                                 ▼
                           child returns per-file results
                                 │
                                 ▼
                           parent completion → main agent wakes
```

### Steps

1. The user toggles **AI explanations** in the input bar; the client calls
   `setSettings({ aiExplain })`; the host stores `featureFlags.aiExplain`.
2. The host injects the system prompt and the tool descriptions on the next turn.
3. The main agent calls `review_write` / `review_patch` with notes.
4. The host validates: when `aiExplain` is on, every changed file needs at least
   one non-empty note; a multi-file patch names the missing files and refuses.
5. The change is staged in the review state; nothing is written to disk.
6. `ensureReviewWaiter` starts a waiter child through the agent-scoped
   `subagent` tool (spawn), or reuses the persistent child with `sendMessage`.
7. The child calls `review_wait` with the reviewId and waitKey.
8. The user reviews in the Code review tab; **Finish** applies the files.
9. The child's `review_wait` returns the per-file outcomes; the child reports to
   its parent; the main agent's next turn receives the result.
10. The next review reuses the same child; one persistent waiter per conversation.

### Endpoints and slots

- RPC: `POST /api/coding-enhanced` with `{ endpoint, payload }`
- Client slots: `conversation.input.right` (Review tools),
  `conversation.chat.assistant-actions` (withdraw), review tab type,
  `settings.section`, `plugins.bundle.config`.
- Host services: `tools`, `subagents`, `sessions`, `connection`, `systemPrompt`.

---

## 5. Subagent design

### 5.1 spawn vs fork

| | spawn | fork |
|---|---|---|
| Tool | `subagent` | `subagent_fork` |
| Provider | `spawn` | `fork` |
| Child context | fresh; only the prompt | inherited completed conversation |
| Project understanding | needs a brief / reads files | has the conversation |
| Token cost | prompt + brief + output | inherited prefix (provider cache) + output |
| Isolation | high | lower |
| Use | review waiter; independent tasks | project-aware explanation; follow-ups |

### 5.2 What the waiter uses

**spawn.** The waiter only needs `reviewId` / `waitKey` and `review_wait`;
it does not need project detail. The child is persistent: the host stores
`reviewWaiters[sessionId]` and reuses it with `sendMessage`.

### 5.3 Why the parent explains, not a comment subagent

An earlier option (“Line AI B”) used a dedicated comment subagent. It was
dropped:

- the parent already has the full project and user intent;
- a fresh comment child needs a brief and still risks missing context;
- the parent's notes cost less than a second child context;
- the waiter child stays a pure `review_wait` observer.

---

## 6. Design decisions

- **The model writes; the host enforces.** Notes are required at the tool
  boundary, not only in a prompt.
- **One explanation per changed file is the floor**, not the ceiling. Line-level
  notes are recommended for user-requested, key or hard-to-understand changes.
- **No upper limit** on notes; the reviewer can ask for more.
- **The main agent cannot block.** `review_wait` is refused for the owner
  session; only a child may wait.
- **One persistent waiter per conversation**, reused with `sendMessage`.
- **The gate covers native file tools**; shell writes are documented as outside
  the review.

---

## 7. Caveats

- Shell commands can still write files outside the gate; a post-turn warning is
  planned.
- The auto waiter uses the agent-scoped `subagent` tool; if the provider is
  unavailable it falls back to a direct `spawn` activation, then to a manual
  `review_wait` fallback.
- npm publishing uses Trusted Publishing (OIDC); the registry CDN may lag a few
  minutes after the workflow succeeds.
- The review contract is versioned with the plugin; this document describes
  0.8.5.

---

## 7.1 Shell gate (0.8.5)

Native `bash` is denied while Pre-review is on. All commands go through the
plugin tool `review_bash`:

```text
review_bash({ command, confirmed?, cwd? })
```

- First call: write detection only, no execution. Returns the reasons and a
  self-check prompt.
- The agent self-checks whether the command creates/modifies/deletes files.
- If it writes source: use `review_write` / `review_patch`.
- If it writes nothing: call again with `confirmed: true`.
- Second call: re-detect, then run `/bin/sh -c` with the session cwd.

Write detection covers shell redirection, `tee`, `sed -i`, `perl -i`,
`cp/mv/rm/rmdir/mkdir/touch/ln/chmod`, `git apply`, `patch`, dependency
installs, and inline Python/Node writes. Writes under `dist`, `build`, `out`,
`target`, `node_modules`, `.next`, `.cache`, `coverage`, `.vitest`,
`__pycache__`, `.pytest_cache`, `.turbo` are build/test artifacts and pass.

### Post-turn audit

At `turn/end` the host diffs the turn-start snapshot against the current
workspace, subtracts reviewed paths and artifact paths, and stores the
remaining files as `audits[sessionId].outside`. The review tab shows a warning
listing them; the user can withdraw the turn or accept. The audit is a
backstop for writes the shell detection missed; it does not auto-revert.

## 8. Version history (review workflow)

| Version | Change |
|---|---|
| 0.6.0 | Non-blocking review waiter; per-file decisions |
| 0.7.0 | Gate coverage for `str_replace_editor` / `multi_edit` / `notebook_edit`; main `review_wait` refused; notes required; AI explanations toggle; wrap all rows |
| 0.8.0–0.8.2 | Plugin-owned persistent waiter via `ctx.subagents` (agent-scoped tool, `spawn`) |
| 0.8.3 | Parent-written explanations; per-file notes validation; comment subagent dropped |
| 0.8.4 | Copy fixes; this document |
| 0.8.5 | Native bash denied; `review_bash` with two-step confirmation and write detection; post-turn audit; read/edit/run prompt |

# Turn withdraw: how it works

> Withdraw does not delete the turn. It restores the workspace from a shadow-git
> tree and appends one model-only surface replacement; the append-only session
> log keeps the original turn.

This document explains the mechanism twice, from two angles:

- **Project view** — what the plugin does, in what order, and where the code lives.
- **Git repository view** — what is stored in the shadow repositories and which
  git commands capture and restore it.
- Then the **session-format view** — how one appended event removes the turn from
  the model's context without removing it from the transcript.
- Finally the failure modes and the exact bug that corrupted a session log in
  version 0.5.6.

---

## 1. The three effects

Withdraw is not a single operation. One click has three independent effects:

| Effect | Mechanism | What the user sees |
|---|---|---|
| **Workspace rollback** | restore files from the shadow-git tree captured before the turn | files return to their pre-turn contents |
| **Model-context cancellation** | append one `surfaceOp: replace` event that shadows the turn's surface nodes | the AI no longer sees the turn; the next prompt behaves as if it never happened |
| **Transcript marking** | persist `sessions[sessionId].withdrawn[turn]` in `state.json` | the turn stays on screen, greyed, with a `Withdrawn` badge |

The original turn events stay in the append-only log. That is deliberate: the
human transcript and the model transcript are different projections of the same
log.

---

## 2. Project view: the plugin's function flow

### 2.1 Turn start — capture before any mutation

`ctx.on('session/event')` watches for `turn/start`
([`lib/index.js:1227`](../lib/index.js#L1227-L1262)). For a top-level session it:

1. remembers the turn in `activeTurns`;
2. starts `captureSnapshot(sessionId, cwd, turn)`;
3. stores the in-flight promise in `pendingSnapshots`.

The very first tool call of the turn waits for that promise in a
`tools/pre-execute` hook ([`lib/index.js:1264`](../lib/index.js#L1264-L1276)).
This is the ordering guarantee: no tool can mutate a file before the pre-turn
tree exists.

Subagent sessions are skipped (`header.origin === 'subagent'` or
`delegationDepth > 0`), so only the top-level conversation owns snapshots.

### 2.2 Turn end — seal the snapshot

On `turn/end` the plugin ([`lib/index.js:1243`](../lib/index.js#L1243-L1260)):

- removes the session from `activeTurns`;
- writes the `turn/end` event sequence into `snapshot.endSeq`;
- persists the snapshot map.

`endSeq` is what makes a snapshot “complete” for withdraw. If the plugin was
reloaded while a turn was running, `status` repairs a missing `endSeq` by
scanning for the matching `turn/end`
([`handleStatus`](../lib/index.js#L1476-L1492)).

### 2.3 Status — can this turn be withdrawn?

The browser calls `POST /api/coding-enhanced` with
`{ endpoint: 'status', payload: { sessionId } }`. The host replies with:

| Field | Meaning |
|---|---|
| `latestTurn` | last completed turn in the session |
| `active` | a turn is currently running |
| `canWithdraw` | only the latest completed turn with a complete snapshot |
| `withdrawable` | every retained completed turn whose surface range still exists |
| `turns` | turns already marked withdrawn |
| `anchors` | message id → turn, so the UI can put the button beside the right message |
| `reason` | why the action is unavailable: `active`, `no-snapshot`, `already`, `incomplete`, `disabled`, `no-turn` |

Two details matter:

- **Only completed turns are withdrawable.** An active turn's snapshot is still
  being written and files are changing; racing a restore against it is unsafe.
- **Older retained turns are reversible too.** They show **Withdraw from here**
  and cancel every turn from there through the latest one.

### 2.4 The withdraw transaction

`handleWithdraw` ([`lib/index.js:1533`](../lib/index.js#L1533-L1645)) runs these
steps in order:

1. **Validate the request** — live session, withdraw enabled, no active turn,
   not already withdrawn, snapshot exists and has `endSeq`.
2. **Find the surface range** — `surfaceRange(session, turn)` walks from the
   target `turn/start`, skips events already shadowed by earlier replacements,
   and records the first and last model-visible (`surfaceOp: 'append'`) events
   of that turn ([`lib/index.js:1311`](../lib/index.js#L1311-L1341)).
3. **Collect the full cancellation range** — starting at that first surface
   event, collect every non-shadowed surface event through the end of the log.
   This is why withdrawing an older turn also cancels later turns.
4. **Compute the affected turns** — every `turn/start` at or after the target
   range start.
5. **Restore the workspace** — `restoreTree(snapshot)` (section 3.3).
6. **Append the tombstone** — one surface replacement covering the range
   (section 4).
7. **Persist the withdrawal** — mark every affected turn in
   `state.sessions[sessionId].withdrawn`, drop their snapshots and keepalive
   refs, and optionally run `git gc`.

The restore happens **before** the context append. If the restore fails, nothing
is appended. If the restore succeeds but the append fails, the files are already
back and the RPC returns `cancel-failed` with that exact warning — the two
effects cannot be made atomic across the filesystem and the session log.

### 2.5 Multi-turn rewind

The replacement range is not limited to the selected turn. If turn 12 is
withdrawn while 13 and 14 exist, the surface range runs from 12's first message
to 14's last message. All three turns are marked withdrawn, and the workspace is
restored to the snapshot of turn 12 — i.e. before 12, 13 and 14.

Snapshots have a retention limit (`keepTurns`, default 10, range 1–50). Older
snapshots lose their keepalive refs and are pruned, so they are no longer
withdrawable.

### 2.6 Browser side

`lib/client.js` has a small per-session store
([`lib/client.js:309`](../lib/client.js#L309-L405)):

- `refresh(sessionId)` calls `status`;
- `useRecord` subscribes and polls every 1.5 s while the action is mounted;
- `WithdrawAction` ([`lib/client.js:458`](../lib/client.js#L458-L540)) derives
  the button from `anchors[messageId]`, renders a `Withdrawn` chip when
  `turns[turn]` exists, and calls `withdraw` after `window.confirm`;
- after a successful call it updates the local record immediately and then
  re-fetches status.

`WithdrawMarker` ([`lib/client.js:555`](../lib/client.js#L555)) renders the
turn-tail banner. Transcript turns are found by the DOM attribute
`[data-chat-turn]`; cancelled turns get `data-withdraw-canceled`, which applies
the grey dashed style declared at [`lib/client.js:179`](../lib/client.js#L179).

### 2.7 State and settings

Everything lives under `$DSH_HOME/coding-enhanced`:

```text
coding-enhanced/
├─ settings.json                  feature flags
├─ state.json                     withdrawn turns + snapshot map
└─ repos/
   └─ <sha1(workspace cwd)[:20]>.git/
```

`state.json` has two top-level maps:

```json
{
  "sessions": {
    "session-…": {
      "withdrawn": {
        "44": { "at": 1794376877122, "files": 1 }
      },
      "updatedAt": 1794376877122
    }
  },
  "snapshots": {
    "session-…": {
      "44": {
        "tree": "…",
        "cwd": "/Users/xthw/work_dir",
        "gitDir": "/Users/xthw/.dsh/coding-enhanced/repos/….git",
        "endSeq": 5993,
        "createdAt": 1794376870000,
        "nested": []
      }
    }
  }
}
```

`settings.json` holds `review`, `withdraw`, `keepTurns`, `nestedSnapshots`, and
`autoGc`. A legacy `$DSH_HOME/withdraw-round` directory is renamed to
`coding-enhanced` on load.

The state file is capped at 200 sessions; the least recently updated sessions are
dropped first.

### 2.8 Code map

| Concern | Location |
|---|---|
| Settings / state load and save | [`lib/index.js:276`](../lib/index.js#L276-L338) |
| Snapshot refs and nested refs | [`lib/index.js:341`](../lib/index.js#L341-L374) |
| Shadow repo setup | [`lib/index.js:554`](../lib/index.js#L554-L566) |
| Snapshot capture | [`lib/index.js:619`](../lib/index.js#L619-L675) |
| Retention / GC | [`lib/index.js:446`](../lib/index.js#L446-L539) |
| Workspace restore | [`lib/index.js:1369`](../lib/index.js#L1369-L1474) |
| Status RPC | [`lib/index.js:1476`](../lib/index.js#L1476-L1531) |
| Withdraw RPC | [`lib/index.js:1533`](../lib/index.js#L1533-L1645) |
| Browser store and action | [`lib/client.js:309`](../lib/client.js#L309-L540) |
| Withdrawn banner | [`lib/client.js:555`](../lib/client.js#L555) |

---

## 3. Git repository view: the shadow repository

The snapshot is **not** a copy of the project and **not** a commit in the
project's repository. It is a separate repository whose worktree is the project
directory.

### 3.1 Repository layout

`shadowRepoPath(root, cwd)` hashes the workspace path:

```js
sha1(cwd).slice(0, 20) + '.git'
```

So one workspace always maps to the same shadow repository, outside the
workspace:

```text
$DSH_HOME/coding-enhanced/repos/<hash>.git/
├─ HEAD
├─ config          core.bare=false, core.worktree=<project cwd>
├─ index           the shadow index
├─ objects/        blobs and trees
├─ info/exclude    plugin excludes
└─ refs/coding-enhanced/<sessionHash>/<turn>   keepalive ref → tree
```

Initialization is equivalent to:

```sh
git init --quiet --bare <gitDir>
git --git-dir <gitDir> config core.bare false
git --git-dir <gitDir> config core.worktree <cwd>
git --git-dir <gitDir> config core.autocrlf false
git --git-dir <gitDir> config core.quotepath false
```

A ref points **directly at a tree**, not at a commit. Git keeps tree and blob
objects reachable from that ref, so `git gc` cannot delete a retained snapshot.
The session part of the ref is `sha256(sessionId).slice(0, 16)`, so two sessions
on the same workspace do not collide.

### 3.2 Capture — exactly what runs

At turn start, with `--git-dir <gitDir> --work-tree <cwd>`:

```sh
git add -A --ignore-errors
git write-tree
git update-ref refs/coding-enhanced/<sessionHash>/<turn> <tree>
```

Properties of that capture:

- **Tracked and untracked files are included.** `add -A` stages everything not
  ignored, so a file created outside git is still restorable.
- **Deleted files are represented implicitly** — the tree simply lacks them;
  restoring the tree brings them back.
- **No commit is created.** `write-tree` writes only tree/blob objects.
- **The project index is not used.** `GIT_INDEX_FILE` points inside the shadow
  repository.
- **Unreadable paths do not fail the turn.** `add -A --ignore-errors` is used; a
  path git refuses is added to `info/exclude` and reported, then the add is
  retried.
- **Normal git ignore rules apply.** The shadow repo has its own
  `info/exclude` (`.git/`, `node_modules/`, `.DS_Store`,
  `.dsh-coding-enhanced/`), and because its worktree is the project directory,
  the project's `.gitignore` files also affect what `add -A` stages.

The tree hash is stored in `state.json`, and the ref keeps it alive.

### 3.3 Restore — exactly what runs

`restoreWorktree(gitDir, cwd, tree)` ([`lib/index.js:1369`](../lib/index.js#L1369-L1437))
is a three-way operation between the snapshot tree and the current worktree:

```sh
# 1. What is the workspace now?
git add -A --ignore-errors
git write-tree                       # currentTree

# 2. Which paths differ?
git diff-tree -r --name-status -z <tree> <currentTree>

# 3. Which mode does each snapshot path have?
git ls-tree -r -z <tree>

# 4. For each difference:
#    A (added since snapshot)  -> delete the path
#    M / D                     -> git cat-file blob <tree>:<path> and rewrite it
#    120000                    -> recreate as a symlink
#    100755                    -> recreate with executable bit

# 5. Reset the shadow index to the restored tree
git read-tree <tree>
```

Important details:

- **Added files are deleted**, including untracked files created during the turn.
- **Deleted files come back** because the blob exists in the snapshot tree.
- **Modified files are rewritten from blobs**, not from a diff patch.
- **Symlinks and executable bits are preserved.**
- **Nested git repositories are skipped** when the path is a gitlink (`160000`)
  or contains `.git`; their contents are not in the outer snapshot. They are
  restored separately from their own shadow repos.
- `read-tree` leaves the shadow index matching the restored state, so the next
  turn's `add -A` produces a clean diff.

`restoreTree` ([`lib/index.js:1439`](../lib/index.js#L1439-L1474)) then repeats
the restore for each nested snapshot, merges the restored file lists, and
returns `{ count, files, skipped }`. `skipped` is shown to the user.

### 3.4 Nested repositories

`findNestedRepos(cwd)` walks the workspace up to depth 12, skipping
`node_modules`, `.git`, and `.dsh-coding-enhanced`
([`lib/index.js:594`](../lib/index.js#L594-L617)). Every directory containing a
`.git` is snapshotted into its own shadow repository with its own worktree.
Only working files are captured — the nested `.git` directory is excluded — so
withdraw restores the nested working tree without rewriting its history.

A nested repository created **during** the turn has no snapshot. It is left in
place and reported as skipped rather than deleted.

### 3.5 Cleanup and GC

Withdraw and retention pruning remove the snapshot's refs. The affected shadow
repositories are marked dirty. When `autoGc` is on, or when the user clicks
**Clean up now**, the plugin runs:

```sh
git gc --prune=now --quiet
```

Trees that are still referenced by retained snapshots survive; unreferenced
objects are collected. GC is serialized per workspace so concurrent sessions
cannot race the same repository.

---

## 4. Session-format view: hiding the turn from the model

DSH's session log is append-only. Each event has a sequence number. Message
events additionally carry a `surfaceOp`:

```ts
type SurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

The **surface** is the ordered list of events that derive the provider message
history. An `append` event joins at its own position. A `replace` event shadows
an existing surface range and takes its place. The original events remain
readable; they are simply no longer on the current surface.

### 4.1 The tombstone event

Withdraw appends one event at the end of the log:

```json
{
  "type": "user/message",
  "seq": 5994,
  "time": 1794376877121,
  "data": {
    "id": "coding-enhanced-withdraw-44-…",
    "role": "user",
    "source": { "kind": "coding-enhanced-withdraw" },
    "content": []
  },
  "sourceEventSeqs": [5971, 5973, 5975, 5979, 5981, 5985, 5987, 5991],
  "surfaceOp": {
    "op": "replace",
    "startSeq": 5971,
    "endSeq": 5991
  }
}
```

- `startSeq` / `endSeq` must name events already on the surface; the range is
  inclusive and spans the withdrawn turns.
- `sourceEventSeqs` must cite **every** shadowed surface node. DSH rejects a
  replacement that omits one.
- The replacement event itself becomes the new surface node at that position.
- The tombstone is an **empty user message**. DSH's derived history keeps the
  node, but provider adapters drop empty user/assistant content before building
  the wire request (the DeepSeek adapter does this explicitly), so nothing is
  sent to the model.
- The custom `source.kind` marks it as plugin-owned, so normal user-message
  consumers (for example session-title selection, which looks for
  `source.kind === "user"`) do not mistake it for a real prompt.

### 4.2 Why a `user/message` and not a `developer/message`

Only `user/message` is both surface-eligible and legal outside an open
turn/step. `developer/message`, `system/message`, and `assistant/message` are
step-scoped; `tool/result` needs an open turn or step as well. Withdraw appends
after `turn/end`, so those types cannot be used. Section 7 explains the exact
validator that rejected the old implementation.

---

## 5. End-to-end example

Assume turn 44 in session `session-d2d9…`:

```text
seq 5970  turn/start 44
seq 5971  user/message       ← first surface node of turn 44
seq 5972  session-log-deepseek/delivery-accepted
seq 5973  assistant/message
seq 5974  tool/call
seq 5975  tool/result
…
seq 5991  assistant/message   ← last surface node
seq 5992  step/end
seq 5993  turn/end 44
seq 5994  user/message (replace 5971..5991)  ← the withdrawn tombstone
```

After the append:

- the surface is `[… earlier nodes …, 5994]`;
- the model deriving history from the surface skips every node in
  `5971..5991`;
- `state.json` records `withdrawn["44"] = { at, files }`;
- the transcript still contains 5971..5991 because those are append-origin
  events, and the client greys the turn.

The live surface is updated immediately by `session.append`; the persisted log
contains the same replacement, so a restart replays to the same surface.

---

## 6. Failure modes and limits

| Situation | What happens |
|---|---|
| Turn is still running | `reason: active`; action disabled |
| Plugin loaded after the turn started, so no snapshot | `reason: no-snapshot` |
| Snapshot was pruned by retention | `reason: no-snapshot`; only `keepTurns` recent turns remain |
| Turn has no model-visible messages | `no-surface`; nothing to cancel |
| File restore fails | `restore-failed`; no context change is made |
| Restore succeeds but append fails | files are already restored, RPC returns `cancel-failed` |
| Nested repo created during the turn | left in place, reported as `skipped` |
| Path is ignored by `.gitignore` or plugin excludes | not snapshotted, so not restored |
| Nested repo too broken to snapshot | outer snapshot skips it, reported |

Withdraw is intentionally not a full version-control system: it restores the
captured working tree, not reflog history, stashes, submodule commits, or files
outside the workspace.

---

## 7. Why the old implementation corrupted the session

### 7.1 The old tombstone

Version 0.5.6 appended this after `turn/end`:

```json
{
  "type": "developer/message",
  "data": {
    "turn": 44,
    "step": 4,
    "message": {
      "id": "coding-enhanced-44-…",
      "role": "developer",
      "source": { "kind": "user" },
      "content": []
    }
  },
  "surfaceOp": { "op": "replace", "startSeq": 5971, "endSeq": 5991 }
}
```

It looked plausible: the turn number and step number were copied from the turn.
But the type was wrong for the position in the log.

### 7.2 Live append vs. reload replay

DSH validates an append **locally**:

- data shape (`validateSessionEventData`);
- surface metadata (range, source-event coverage, eligibility);
- JSON serializability.

It does **not** replay turn/step relationships on every append. The log is
written successfully, so the UI reports success and the turn is withdrawn.

On the next load, DSH reconstructs global lifecycle state from the whole log
(`restoreReleasedV4Artifact` → `assertReleasedV4Relationships`). That replay
walks the events in order and maintains:

- `this.turn` — `turn/start` opens it, `turn/end` closes it;
- `this.step` — `step/start` opens it, `step/end` closes it.

`developer/message` is a **step-scoped** event. The replay calls:

```js
requireStep(event, data) {
  if (this.turn === null || this.step === null ||
      data.turn !== this.turn || data.step !== this.step) {
    throw new SessionFormatError(
      `${event.type} does not match an open turn and step`
    )
  }
}
```

Timeline for the old tombstone:

```text
turn/start 44        this.turn = 44
step/start 4         this.step = 4
step/end             this.step = null
turn/end 44          this.turn = null
developer/message    this.turn = null, this.step = null
                     data.turn = 44, data.step = 4
                     → requireStep throws
```

The numbers were correct, but there was no open turn or step to attach them to.
The log was structurally plausible and permanently invalid.

### 7.3 Why `user/message` fixes it

`user/message` is surface-eligible but **not** step-scoped. Replay validates its
surface replacement (range and source coverage) and its message fields, but it
does not require an open turn or step. That makes it the only message type that
can be appended as a standalone tombstone after `turn/end`. It is also the type
DSH itself uses for compaction checkpoints that replace a surface range.

### 7.4 Repairing an already-corrupted log

The broken event is the last event in the affected log, so it can be rewritten
without renumbering:

1. decompress every zstd frame of `session.v4.jsonl.zstd`;
2. parse the final JSONL event;
3. replace its `developer/message` payload with the `user/message` tombstone
   shape, keeping `seq`, `time`, `surfaceOp`, and `sourceEventSeqs`;
4. recompress that frame with a checksum and replace the file atomically;
5. replay the whole artifact through DSH's own
   `restoreReleasedV4Artifact` validator.

The original file is kept as a timestamped `.bak-…` next to the log. Future
withdrawals are correct because the plugin now emits the `user/message` shape
directly.

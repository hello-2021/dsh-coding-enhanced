# Changelog

## 0.8.5

- Native `bash` is denied while Pre-review is on; shell commands go through
  `review_bash`, which detects writes and asks for a second confirmation.
- Build/test artifacts (`dist`, `build`, `node_modules`, ...) are allowed;
  writes to source are blocked.
- Audit changes at `turn/end` against the turn-start snapshot and warn about
  files changed outside review.
- Update the review prompt to read / review tools / review_bash.

## 0.5.15

- Restore the native tool gate: while AI Change Review and the input-bar Auto
  review switch are on, `write` / `edit` / `apply_patch` are denied by
  `tools/pre-execute`, so the agent must use `review_write` / `review_patch`.
  Shell commands are not intercepted; turning Auto review off restores native
  editing.

## 0.5.14

- While the agent is still proposing, per-file Approve/Reject/Edit and the
  instruction box are enabled; only Finish stays locked until review_wait.
- Decisions are reset when a new edit changes that file.
- The diff area has a drag handle to resize its height (double-click resets),
  remembered across sessions.
- New input-bar **Review tools** switch with an Auto review master switch:
  on injects the review workflow into the agent prompt and exposes the review
  tools; off hides them and returns the agent to native write/edit. The switch
  is separate from the Settings AI Change Review function switch.
- README: GitHub/tarball install, direct git install, and the review switch.
- Package metadata for GitHub/npm distribution.

## 0.5.13

- While the agent is still proposing, per-file Approve/Reject/Edit and the
  instruction box are enabled; only Finish stays locked until review_wait.
- A decision is reset when a new edit changes that file, so stale approvals do
  not apply to changed content.
- The diff area has a drag handle to resize its height (double-click resets);
  the height is remembered.

## 0.5.12

- Put the Fold/Unfold control next to the always-visible `Withdrawn` chip in the
  assistant action slot, so it exists even when the turn-tail banner is not
  mounted. Both controls share the same per-session/turn fold state.

## 0.5.11

- Keep the `Withdrawn` chip visible without hovering the turn tail.
- Add a Fold/Unfold control to the withdrawn banner; the turn starts expanded,
  the state is remembered per session/turn in localStorage, and folded turns
  keep only the tail banner while hiding the round's rows.

## 0.5.10

- Add a session-scoped global painter for withdrawn turns. It runs while any
  withdraw UI is mounted for the session and marks the outermost
  `data-chat-turn` nodes every second, so grey/frame no longer depend on the
  turn-tail marker being mounted (virtualized or collapsed turns).

## 0.5.9

- Fix withdrawn turns not being greyed or framed: the marker skipped its own
  `data-chat-turn` node, so turns with a single container were never marked.
- Mark only the outermost turn containers so nested rows do not multiply
  opacity; nested rows inherit the dim.
- Repaint the withdrawn attributes every 500ms so virtualized chat rows keep
  them after re-renders.
- Give the turn's process group a dashed frame and rows a dashed left edge.

## 0.5.8

- Add `docs/withdraw.md`: the withdraw mechanism explained separately as the
  plugin's function flow and as the shadow-git repository operations, plus
  state layout, failure modes, and the full analysis of the
  `developer/message` replay corruption.
- README now quotes and links the deep dive, and describes the tombstone as a
  `user/message` surface replacement.

## 0.5.7

- Fix withdraw corrupting the session on the next DSH start with
  `developer/message does not match an open turn and step`. The synthetic
  tombstone is now a `user/message` surface replacement, which the session
  format accepts after `turn/end`; the previous `developer/message` was only
  accepted by the live append and failed relationship validation on replay.
- The empty user message projects to no provider message, so the withdrawn
  turn stays out of the model context without adding a synthetic turn.

## 0.5.6.1

- Backport the `user/message` withdraw tombstone to the 0.5.6 line: a
  `developer/message` appended after `turn/end` is rejected when the session log
  is replayed on the next DSH start. The empty user message projects to no wire
  message, so the withdrawn turn stays hidden without a synthetic turn.
- The review UI stays at 0.5.6 (withdrawn chip and banner). The grey/frame work
  remains on the `wip-grey` branch.

## 0.5.6

- A withdrawn turn keeps a visible indicator in the assistant action slot: the
  withdraw button becomes a dashed `Withdrawn` chip with the undo icon. This is
  independent of the turn-tail banner and works even if that banner is not
  rendered.
- Status now provides anchors for withdrawn turns so the action slot can find
  the turn and render the chip.

## 0.5.5

- Repair snapshot `endSeq` from the session's `turn/end` event when the plugin
  was reloaded while a turn was running, so the withdraw action returns after a
  restart.
- An incomplete turn now reports reason `incomplete` and shows a disabled
  withdraw action instead of no action at all.
- Poll the withdraw status every 1.5s while a session has withdraw UI mounted,
  so the action enables as soon as the turn ends.

## 0.5.4

- Withdrawn rounds now show a prominent banner at the turn tail: undo icon,
  "This round was withdrawn", restored-file count, and a `Withdrawn` chip.
- Withdrawn turn rows use a softer grey, a dashed warning border, and the
  changed-files label instead of a harsh grayscale filter.

## 0.5.3

- Fix withdraw failing with `developer/message step must be positive`: the
  synthetic developer message now uses the withdrawn turn's last step (at least
  1) instead of 0.

## 0.5.2

- Fix withdraw failing with `developer/message turn must be a non-negative safe
  integer`: the synthetic developer message now carries the withdrawn `turn`
  and `step`.
- Keep the 0.5.1 fix (surface replacement must end on a model-visible event).

## 0.5.1

- Fix withdraw failing with `surface replace: end seq ... not found in surface`
  when the turn's last event was a tool result or `turn/end`. The replacement
  range now ends on the last **model-visible** surface message; the workspace
  restore and the context cancellation stay consistent.

## 0.5.0

- **Persistent snapshots.** Snapshot mappings (tree, cwd, gitDir, endSeq) are
  stored per turn in `state.json`; each tree has a keepalive ref under
  `refs/coding-enhanced/...`, so restarts/reinstalls and `git gc` no longer lose
  withdraw.
- **Multi-turn rewind.** The last `keepTurns` turns (default 10, configurable
  1–50) stay withdrawable. Withdrawing turn N restores the workspace to before
  N and cancels turns N..latest in the model context, greying all of them.
- **Nested git repository snapshots.** `nestedSnapshots` (default on) gives
  each nested repository its own shadow repository and restores its working
  files (excluding `.git`); off/new nested repos are left untouched and
  reported as skipped.
- **Cleanup.** `autoGc` runs `git gc` on dirty shadow repositories; a manual
  cleanup endpoint/button prunes extra snapshots and compacts every shadow
  repository. Keepalive refs make GC safe.
- **Settings UI.** Grouped Review / Turn withdraw cards, retention input,
  nested/autoGc switches, cleanup action, relative typography; shown in
  Settings → Coding Enhanced and on the plugin page.
- **Review view.** Typography and spacing are `em`-based and follow the app's
  base font size, with a larger diff, buttons, chips and editor.

## 0.4.1

- **Withdraw no longer fails on nested git repositories.** A directory with its
  own `.git` is recorded as a gitlink (mode `160000`), not as blobs; the restore
  now skips those paths instead of running `git cat-file blob` on them.
- Newly added nested repositories are left in place instead of being deleted by
  withdraw, and the UI reports the skipped paths.
- `git add -A` now excludes nested repositories it cannot add (for example, a
  freshly `git init`ed repository with no commit) and retries, so snapshots and
  withdraw still work in such workspaces.

## 0.4.0

- **`review_patch` replaces `review_edit`.** Edits are queued as unified diffs
  (`---`/`+++`/`@@` hunks) and applied to a temporary git worktree with
  `git apply --recount`. Multiple hunks and multiple files are supported; a
  patch that does not apply is refused at queue time.
- `review_write` remains for new files and full-file rewrites.
- `review_wait` now returns a structured per-file result:
  `{ status, files: [{ path, outcome, comment? }] }` with `applied`,
  `rejected`, `edited` or `failed`.
- One review card per file; later patches to the same file are applied on top
  of its queued content.
- Deletes, renames, copies, binary patches and paths outside the working
  directory are refused by `review_patch`.

## 0.3.1

- **One review card per file.** Multiple edits to the same file are merged into
  one entry with a single net diff and one Approve/Reject/Edit decision, so
  rejecting part of a file can no longer leave a later edit with a stale
  `old_string`.
- `review_edit` is validated against the current queued content when queued; a
  missing or ambiguous `old_string` is refused immediately with a request to
  re-read and retry.
- Per-file decisions are locked while the agent is still proposing, alongside
  `Finish`; they unlock when `review_wait` is called.

## 0.3.0

- **Queued review gate.** The agent now proposes changes with `review_write`
  and `review_edit`; the tools only queue, so every change in a turn
  accumulates in one review page instead of blocking on the first edit.
- **`review_wait`.** The agent calls it once after proposing everything; it
  blocks until the user finishes and returns applied/rejected/failed files plus
  the user's instructions.
- Native `write` / `edit` / `apply_patch` are refused while the gate is on.
- Reviewed changes are applied by the host from the queued content; multiple
  changes to one file are applied in order, and rejecting an earlier change can
  invalidate a later one (reported as a failed apply).
- Finish stays locked until the agent submits the review (or the turn ends).

## 0.2.1

- The two feature switches also appear on the plugin's own page in the
  **Plugins** tab, above its README.
- The plugin page's README is shown in a bounded, scrollable box instead of
  expanding the page.

## 0.2.0

- Settings page (**Settings → Coding Enhanced**) with one switch per
  sub-feature: **AI Change Review** and **Turn Withdraw**.
- Switches apply immediately; turning the review gate off cancels any pending
  review with an explicit message, and turning withdraw off stops snapshots and
  hides the withdraw action. Values persist in
  `$DSH_HOME/coding-enhanced/settings.json`.

## 0.1.0

Initial release of **dsh-coding-enhanced**, a growing bundle of coding-workflow
sub-features for DeepSeek Harness.

- Review gate: intercepts every `write`/`edit`, stages the whole assistant
  message into one right-sidebar review tab, and applies only what the user
  approves.
- Per-file unified diff with line numbers and coloured added/removed lines,
  Approve / Reject, and an instruction box whose text reaches the model on
  rejection.
- Manual editing: an edited file is a third, yellow **Edited** outcome applied
  without Approve/Reject; the model receives `Outcome: edited by the user`.
- Floating toolbox (Approve all / Reject all / Finish) and a reopen pill.
- Closing the tab cancels the review, writes nothing, and tells the model to
  wait for the user.
- Withdraw: snapshot the workspace at turn start, restore it, cancel the round
  in the model context, and grey the transcript with a `已撤销` marker.
- Packaged as a DSH bundle (`dsh.bundle.patch`) installable from the Plugins
  panel.

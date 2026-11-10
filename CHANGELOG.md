# Changelog

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

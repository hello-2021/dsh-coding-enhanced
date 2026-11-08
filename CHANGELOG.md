# Changelog

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

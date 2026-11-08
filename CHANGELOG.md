# Changelog

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

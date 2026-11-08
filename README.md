<div align="center">

# dsh-coding-enhanced

**Improve your coding experience with a stronger sense of control in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Review every AI file change before it lands · Undo the last turn when it goes wrong

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.x-4d6bfe)
![Platform](https://img.shields.io/badge/platform-Desktop%20%7C%20Web-2da44e)
![Status](https://img.shields.io/badge/status-beta-orange)

</div>

---

**`dsh-coding-enhanced` is a growing bundle of coding-workflow enhancements for DSH**, shipped as one installable plugin. It contains **two independent sub-features today**, and new sub-features are added over time.

| | Sub-feature | What it gives you |
|---|---|---|
| 🛡️ | **AI Change Review** | Every `write` / `edit` is held in a right-sidebar review tab until you approve, reject with instructions, or edit it yourself. |
| ↩️ | **Turn Withdraw** | Restore the workspace to before the latest turn and cancel that round in the model's context. |

Both live in one bundle and work independently — install once, use either.

---

<a id="sub-features"></a>

## 🧩 Sub-features

### 🛡️ 1. AI Change Review

DSH agents normally write files as they go. With this sub-feature, every file
change **stops before disk** and opens a review tab beside the conversation.

```text
┌─ Code review · 3 files ───────────────────────────────────┐
│ src/app.ts                          +12 −3   [Approve]    │
│   @@ -10,7 +10,9 @@                                       │
│    10  10  const app = createApp()                        │
│   - 11     app.use(oldRouter)                             │
│   + 11     app.use(newRouter)                             │
│   + 12     app.use(logger)                                │
│                                           [Reject] [Edit] │
├───────────────────────────────────────────────────────────┤
│ src/config.ts                       +2 −0    [Approve]    │
│ ...                                                       │
├───────────────────────────────────────────────────────────┤
│  [Approve all] [Reject all]   2 pending      [ Finish ]   │
└───────────────────────────────────────────────────────────┘
```

- Opens as a **right-sidebar tab**, like a file preview — not a pop-up.
- **Unified diff** per file: line numbers, hunk headers, coloured added/removed
  lines, and a `new` chip for created files.
- Per-file **Approve** / **Reject**, plus an instruction box. A rejection sends
  your text back to the model as the tool error so it can revise.
- **Edit** the proposed content in place. An edited file becomes a third, yellow
  **Edited** outcome and is applied automatically — no Approve/Reject needed.
- **Floating toolbox** at the bottom-right: `Approve all`, `Reject all`, the
  undecided count, and `Finish`.
- **Close the tab** to cancel the review: nothing is written, and the model is
  told to wait for your instruction.
- A `N files to review` pill brings the tab back if you close it while it is
  still pending.

**What the model sees**

| Your action | File on disk | Tool result |
|---|---|---|
| **Approve** | the tool's proposal | normal success |
| **Reject** (+ instruction) | nothing | error + your instruction |
| **Edit** + **Finish** | **your text** (written after the tool) | `Outcome: edited by the user…` |
| **Close the tab** | nothing | error: review closed; wait for the user |

The turn stays paused while the review is open. `Finish` is blocked until every
non-edited file has a decision.

---

### ↩️ 2. Turn Withdraw

The last turn wrote something you did not want? Undo it in one click.

- **Snapshot at turn start** — a shadow git repository under
  `$DSH_HOME/coding-enhanced` records the whole working directory before the
  turn's first tool runs. It never writes into your repository.
- **Restore on withdraw** — modified, created and deleted files, symlinks and
  executable bits all return to their pre-turn state.
- **Cancel the round** — the turn is removed from the model's context via a
  model-only surface replacement, while the append-only transcript keeps it.
- **Visible in the transcript** — the canceled round is greyed out and its
  changed-files line gains a `已撤销` marker.
- Available on the **latest completed turn** only.

---

<a id="quick-start"></a>

## 🚀 Quick start

### 1. Install

**DSH Desktop — Plugins panel (recommended)**

1. Download `dsh-coding-enhanced-<version>.tgz` from the repository's
   **Releases** page (or build it with `npm run pack`).
2. Open **Plugins → Add plugin**.
3. Paste the tarball's absolute path (or its URL).
4. **Install** → **Enable now**.

**CLI**

```sh
dsh plugin --profile web add /path/to/dsh-coding-enhanced-0.1.0.tgz
```

**Development link** — in the same Add plugin dialog, use the absolute path of
this directory. DSH installs a link, so source edits apply on the next
recomposition or restart.

### 2. Use the review gate

Ask the agent to change files → the **Code review** tab opens → decide per file
→ **Finish**.

### 3. Use withdraw

Click the undo icon in the assistant action row on the latest completed turn →
confirm.

> Uninstall at any time from **Plugins → dsh-coding-enhanced → Remove**. Your
> `$DSH_HOME/coding-enhanced` state is left in place.

---

<a id="how-it-works"></a>

## 🧠 How it works

<details>
<summary><b>Review gate pipeline</b></summary>

```text
assistant message
   │  host stages one entry per write/edit
   ▼
tools/pre-execute ── waits for your decision
   │
   ├── Approve ──► tool runs normally
   ├── Edit    ──► tool runs, then post-execute writes your text
   ├── Reject  ──► deny + your instruction
   └── Close   ──► deny + "wait for the user"
```

- **Host** (`lib/index.js`) listens to `assistant/message` to stage entries,
  gates `write` / `edit` in `tools/pre-execute`, and applies edited content in
  `tools/post-execute`. It serves `/api/coding-enhanced` over the authenticated
  DSH `/api` bridge.
- **Browser** (`lib/client.js`) registers a page type with
  `ctx.sidebarRightTabs` and its body with `sidebar.right.pane.tab`, plus a
  watcher that opens the tab and the reopen pill.
- **Transport** inherits the bridge's loopback/Origin fence, cookie auth and
  owner-Peer guard.

</details>

<details>
<summary><b>Withdraw pipeline</b></summary>

- A shadow git repository per workspace lives under
  `$DSH_HOME/coding-enhanced/repos`. It is initialized on the first turn and
  refreshed with `git add -A` at every turn start; the first tool call waits for
  the snapshot.
- Withdraw diffs the current tree against the snapshot and restores every
  changed path.
- The round is canceled with a model-only `developer/message` surface
  replacement covering its surface nodes.
- State lives in `$DSH_HOME/coding-enhanced/state.json`; old `withdraw-round`
  directories are migrated automatically.

</details>

---

<a id="limits"></a>

## ⚠️ Limits

- **Only `write` / `edit` are gated.** `apply_patch` is not registered in the
  desktop profile, and shell edits (`bash`, `sed`, `rm`, …) are outside the
  gate.
- **Editable text is capped at 200 KiB** per file. Binary and larger files are
  review-only.
- **A pending review lives on the Host.** A page reload reopens it; a Host
  restart drops it together with the blocked turn.
- **Withdraw covers the latest completed turn.** Files ignored by `.gitignore`
  (or the defaults `.git/`, `node_modules/`, `.DS_Store`) are not snapshotted;
  nested repositories are recorded as gitlinks.
- **Web UI required.** The review tab needs the Desktop or `dsh web` profile;
  headless and tui profiles have no review surface.
- Two edits to the same file in one message are previewed cumulatively, in call
  order.

---

<a id="roadmap"></a>

## 🗺️ Roadmap

The bundle is intentionally a home for **more coding-workflow sub-features**.
Planned directions (not commitments):

- review coverage for `apply_patch` and shell edits;
- side-by-side diff mode and per-file folding;
- review history per session (reopen a finished review);
- per-project review policy (auto-approve patterns);
- multi-turn withdraw / redo.

Have an idea? Open an issue.

---

<a id="development"></a>

## 🛠️ Development

No build step:

```text
lib/index.js        Host plugin (ESM)
lib/client.js       Browser bundle (prebuilt lazy-CJS, served by dsh-client-modules)
cordis.patch.yml    Bundle layer (inserts the coding-enhanced row)
```

```sh
npm run pack          # dist/dsh-coding-enhanced-<version>.tgz
```

For fast iteration, install this directory as a **link** through
**Plugins → Add plugin** and edit the source directly. When using the tarball
workflow, rebuild and reinstall after each change.

---

<a id="release"></a>

## 📦 Release

```sh
npm run pack
git tag v0.1.0
git push origin main --tags
```

The `release` workflow packs the tarball and attaches it to the GitHub release
for any `v*` tag.

---

## 🔒 Privacy

Everything runs locally. No network calls, no telemetry, no external services.
State stays in `$DSH_HOME/coding-enhanced`; review content is served only over
the authenticated local `/api` bridge.

## 📄 License

[MIT](LICENSE) © dsh-coding-enhanced contributors

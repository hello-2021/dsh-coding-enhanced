<div align="center">

# dsh-coding-enhanced

**The DSH change gate: review before it lands, rewind when it goes wrong, and keep working while review waits.**

Queue every AI edit · rewind whole turns · hand review to a non-blocking waiter

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DSH-0.2.x-4d6bfe)
![Platform](https://img.shields.io/badge/platform-Desktop%20%7C%20Web-2da44e)
![Status](https://img.shields.io/badge/status-beta-orange)

</div>

---

`dsh-coding-enhanced` is **not another AI PR reviewer**. It is a **workflow layer for DSH agents**, shipped as one installable plugin:

- **Pre-write change gate** — native `write` / `edit` / `apply_patch` are refused while Pre-review is on; the agent queues `review_write` / `review_patch`; nothing lands until you Finish.
- **Workspace time machine** — per-turn shadow-git snapshots, multi-turn withdraw, a pre-withdraw backup, and a gap warning when a rewind crosses turns without snapshots.
- **Non-blocking review handoff** — one persistent review waiter subagent holds the wait; the main agent can keep chatting or end the turn; the waiter wakes it with the per-file results.
- **Remote + cross-AI (next)** — passkey-paired always-on web review, line-level AI comments (B), and an adversarial AI cross-review API.

> **What this is not.** Not an AI PR reviewer (CodeRabbit / Qodo / Copilot), not a hosted SaaS, and not a claim to be first. The diff UI is table stakes; the gate, the time machine, and the handoff are the product. See the [prior-art survey](docs/prior-art.md) for the direct comparison with [`dsh-diff-approval`](https://github.com/9087/dsh-diff-approval).

| | Pillar | What it gives you |
|---|---|---|
| 🛡️ | **Change gate** (the `AI Change Review` switch) | The agent queues every edit with `review_write` / `review_patch`; they accumulate in one review tab; nothing lands until you approve, reject, edit or Finish. |
| ↩️ | **Workspace time machine** (the `Turn Withdraw` switch) | Restore the workspace to before a turn and cancel that round in the model's context; multi-turn rewind, backup and gap warnings. |
| ⏳ | **Review handoff** | One persistent review waiter subagent holds the wait; the main agent keeps working and is woken when you Finish. |
| 🌐 | **Remote + cross-AI** | Planned: passkey-paired web review, line-level AI comments, adversarial external-AI cross-review. |

All in one bundle — install once, use the gate and the time machine independently.

---

<a id="sub-features"></a>

## 🧩 Sub-features

### 🛡️ 1. Change gate (`AI Change Review`)

DSH agents normally write files as they go. With this sub-feature, changes are
**queued** instead: the agent proposes every edit, they accumulate in one review
tab, and nothing touches disk until you finish.

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

**How it flows**

1. The agent calls **`review_write`** (new file / full rewrite) or
   **`review_patch`** (a unified diff for edits) for every change. These tools
   only queue the proposal — they never write.
2. All queued changes appear in the **same** right-sidebar review tab, even
   when the agent proposes them across several steps.
3. When it has finished proposing, the agent uses **one persistent review
   waiter subagent per conversation**. It starts the waiter once, then sends
   each new `reviewId` and `waitKey` to the same child with `send_message` (no
   new subagent task per review). The waiter calls `review_wait` with both and
   waits; the main agent can keep chatting or end the turn. When the review
   finishes, the waiter returns and wakes it. If delegation is unavailable,
   **`review_wait`** blocks the main agent as before.
4. You **Approve**, **Reject** (with instructions), or **Edit** each file, then
   **Finish**. Approved and hand-edited files are written; rejected files are
   not. `review_wait` returns one structured result per file
   (`applied` / `rejected` + your instruction / `edited` / `failed`), so the
   agent can revise in the same turn.
5. While the input-bar **Review tools** switch is on, the agent is instructed
   to use these tools, and native `write` / `edit` / `apply_patch` are refused
   by the plugin's tool gate. Turning the switch off returns it to native
   editing. Shell commands (`bash`, `sed`, …) are outside the review.

Both tools return `reviewId` and `waitKey`; use them to start a review waiter
subagent instead of blocking the current turn.

Both tools accept an optional `notes` array. Each note is anchored to a
new-file `line` (recommended) or a 1-based `hunk`; the review diff renders it as
a compact gradient-tinted **AI explanation row** immediately after that added
line: same grid and height as a diff row, `AI` in the sign column, one line with
ellipsis (hover for the full text); a hunk-only note goes after the group. The agent is prompted to add one short note per added group.

**Review tab**

- Opens as a **right-sidebar tab**, like a file preview — not a pop-up.
- **Unified diff** per file: line numbers, hunk headers, coloured added/removed
  lines, and a `new` chip for created files.
- Per-file **Approve** / **Reject**, plus an instruction box.
- **Edit** the proposed content in place. An edited file becomes a third, yellow
  **Edited** outcome and is applied automatically.
- **Floating toolbox** at the bottom-right: `Approve all`, `Reject all`, the
  undecided count, and `Finish`.
- While the agent is still proposing, a banner says so and the per-file
  decisions and `Finish` stay locked; they unlock when the agent calls
  `review_wait`.
- **Close the tab** to cancel: nothing is written, and a waiting `review_wait`
  returns "review closed".
- A `N files to review` pill brings the tab back if you close it while pending.

**What the model sees**

| Your action | File on disk | `review_wait` result |
|---|---|---|
| **Approve** | the proposed content | applied |
| **Reject** + instruction | nothing | rejected + your instruction |
| **Edit** + **Finish** | **your text** | applied (edited by user) |
| **Close the tab** | nothing | `status: "canceled"` |
| **Turn ends without `review_wait`** | — | the review is submitted automatically so you can still finish it |

The queue/tool pair is what makes multiple changes reviewable in one page: the
agent never blocks on the first edit, so it can propose the whole turn before
asking for your decision.

**One card per file.** Multiple `review_patch` / `review_write` calls that touch
the same file are merged into a single card: one net diff from the original file
to the latest queued content, and one Approve/Reject/Edit decision. When a file
already has queued content, the next patch is applied on top of it, so the card
always shows the cumulative change.

**Patches, not `old_string`.** `review_patch` takes a standard unified diff:

```diff
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,9 @@
   const app = createApp()
-  app.use(oldRouter)
+  app.use(newRouter)
+  app.use(logger)
   app.listen(3000)
```

- The `@@ -10,7 +10,9 @@` header is the line range — no separate line counting.
- The host seeds a temporary git worktree with the **current queued content**
  and applies each file section with `git apply --recount`, so context matching,
  offsets, multi-hunk and multi-file patches all behave like git.
- A patch that does not apply is refused **at queue time**; nothing is staged.
- Paths are relative to the working directory (`a/` / `b/` prefixes optional).
  Deletes, renames, copies, binary patches and paths outside the working
  directory are refused — use `review_write` for those cases.

### ↩️ 2. Workspace time machine (`Turn Withdraw`)

The last turn wrote something you did not want? Undo it in one click.

> **Deep dive:** [docs/withdraw.md](docs/withdraw.md) explains the function-level
> flow and the shadow-git repository separately. In one sentence: withdraw does
> not delete the turn — it restores the workspace from a shadow-git tree and
> appends one model-only surface replacement, while the append-only log keeps
> the original turn.

- **Snapshot at turn start** — a shadow git repository under
  `$DSH_HOME/coding-enhanced` records the working directory before the turn's
  first tool runs. It never writes into your repository.
- **Persisted across restarts** — snapshots are stored per turn in
  `state.json` together with a git ref that keeps every retained tree alive.
  Reinstalling or restarting the plugin no longer loses the withdraw mapping.
- **Multi-turn rewind** — the last **10** turns (configurable, 1–50) stay
  withdrawable. Withdrawing turn *N* restores the workspace to before *N* and
  cancels turns *N* through the latest in the model's context; the transcript
  greys all of them. The action on older turns says **Withdraw from here** and
  warns that later turns are canceled too.
- **Restore on withdraw** — modified, created and deleted files, symlinks and
  executable bits all return to their pre-turn state.
- **Nested git repositories are included** — each one gets its own shadow
  repository; its working files (excluding `.git`) are snapshotted and restored
  too. Turn the *Snapshot nested git repositories* setting off to leave them
  untouched; either way the response tells you which paths were skipped.
- **Cleanup** — snapshots beyond the retention count are dropped; `autoGc`
  compacts the shadow repositories after pruning/withdrawing, and **Clean up
  now** forces a compaction of every shadow repository.
- **Cancel the round** — the hidden turns are removed from the model's context
  via a model-only surface replacement, while the append-only transcript keeps
  them; their markers show `已撤销` and the restored file count.
- Only **completed** turns are withdrawable; an active turn shows a disabled
  action.


---

<a id="quick-start"></a>

### ⏳ 3. Non-blocking review handoff

The main agent does not call `review_wait` itself. After queueing, it starts **one
persistent review waiter subagent** per conversation and sends it the
`reviewId` + `waitKey`; later reviews reuse the same child with
`send_message` instead of spawning a new subagent.

- the waiter calls `review_wait` with both and blocks only itself;
- the main agent can keep chatting, do other work, or end the turn;
- when you Finish, the waiter returns the per-file results and wakes the main agent;
- if the waiter is gone, the main agent starts a new one; direct `review_wait`
  remains as the fallback.

## 🚀 Quick start

### 1. Install

**DSH Desktop — Plugins panel (recommended)**

1. Download `dsh-coding-enhanced-<version>.tgz` from the repository's
   **Releases** page (or build it with `npm run pack`).
2. Open **Plugins → Add plugin**.
3. Paste the tarball's absolute path (or its URL).
4. **Install** → **Enable now**.

**From GitHub (fastest)**

1. Open **Plugins → Add plugin**.
2. Paste the repository URL:
   `https://github.com/hello-2021/dsh-coding-enhanced`
3. **Install** → **Enable now**.

```sh
dsh plugin --profile desktop add https://github.com/hello-2021/dsh-coding-enhanced
```

DSH treats a GitHub repository URL as a git spec: it checks the repository with
`git ls-remote`, then pnpm clones the default branch. The package ships its
built `lib/`, so no build step is needed. A git install tracks the default
branch at install time and updates by uninstalling/reinstalling (the page has no
Versions section for git installs).

**Pinned release tarball** — download a `dsh-coding-enhanced-<version>.tgz`
from [Releases](https://github.com/hello-2021/dsh-coding-enhanced/releases) and
paste its URL; use this when you want a fixed version:

```sh
dsh plugin --profile desktop add https://github.com/hello-2021/dsh-coding-enhanced/releases/download/v<version>/dsh-coding-enhanced-<version>.tgz
```

> **Direct npm install is planned.** Once the package is published,
> `dsh plugin add dsh-coding-enhanced` will work without a URL.

**CLI (local tarball)**

```sh
dsh plugin --profile desktop add /path/to/dsh-coding-enhanced-<version>.tgz
```

**Development link** — in the same Add plugin dialog, use the absolute path of
this directory. DSH installs a link, so source edits apply on the next
recomposition or restart.

### 2. Choose features

Open **Settings → Coding Enhanced** (the same controls appear on the plugin's page in the **Plugins** tab):

| Setting | Default | What it does |
|---|---|---|
| **Change gate** (`AI Change Review`) | on | the pre-write review gate for `review_write` / `review_patch` |
| **AI explanations** | on | require at least one note per changed file; line-level notes for user-requested/key/hard changes; off = no notes and no AI rows |
| **Workspace time machine** (`Turn Withdraw`) | on | turn-start snapshots, multi-turn withdraw and the restore action |
| **Turns kept for withdraw** | 10 | how many recent turns stay withdrawable (1–50) |
| **Snapshot nested git repositories** | on | include nested repositories' working files (excluding `.git`) |
| **Automatic cleanup** | on | run `git gc` on shadow snapshots after pruning or withdrawing |
| **Clean up now** | — | prune extra snapshots and compact every shadow repository |
| **Updates** | — | check npm for the latest release and install it from the settings card; restart DSH after updating |

Settings apply immediately and persist in `$DSH_HOME/coding-enhanced/settings.json`.

### 3. Review tools switch

Next to the model selector at the bottom-right of the message input, the shield
button opens **Review tools**:

| Pre-review | What the agent gets |
|---|---|
| **on** | a system-prompt instruction to queue every edit with `review_write` / `review_patch`, then call `review_wait` and wait; the review tools are available |
| **off** | the review tools are not exposed; the agent uses normal `write` / `edit` |

This is a convenience switch, separate from **Settings → Coding Enhanced → AI
Change Review** (which enables the review tab and withdraw surfaces). More
review switches will be added to the same popover.

### 4. Use the change gate

Ask the agent to change files → it queues them with `review_write` / `review_patch` → the **Code review** tab opens → decide per file
→ **Finish**.

### 5. Use the time machine

Click the undo icon in the assistant action row on the latest completed turn →
confirm. Before the files are restored, the plugin snapshots the current
workspace as a pre-withdraw backup. After a withdrawal, the `Withdrawn` action
row offers **Restore pre-withdraw files**; it restores the files only, and the
turn stays hidden from the model. If a rewind spans turns without snapshots
(the plugin was off, installed later, or snapshots were pruned), the
confirmation lists those turns.

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
- The round is canceled with a model-only `user/message` surface replacement
  covering its surface nodes. It must be a `user/message` because
  `developer/message` is step-scoped and the replay validator rejects it after
  `turn/end`; [docs/withdraw.md](docs/withdraw.md#7-why-the-old-implementation-corrupted-the-session)
  walks through the exact failure.
- State lives in `$DSH_HOME/coding-enhanced/state.json`; old `withdraw-round`
  directories are migrated automatically.

</details>

---

<a id="limits"></a>

## ⚠️ Limits

- While **AI Change Review** and the input-bar **Pre-review** switch are on,
  native `write` / `edit` / `apply_patch` are refused by the plugin's
  `tools/pre-execute` policy; the agent must use `review_write` /
  `review_patch`. Turning Pre-review off allows native editing again. Shell
  commands (`bash`, `sed`, `rm`, …) are not intercepted.
- **Editable text is capped at 200 KiB** per file. Binary and larger files are
  review-only.
- **A pending review lives on the Host.** A page reload reopens it; a Host
  restart drops it together with the blocked turn.
- **Withdraw covers retained turns** (`keepTurns`, default 10). Older snapshots
  are pruned. Files matching the default excludes (`.git/`, `node_modules/`,
  `.DS_Store`, `.dsh-coding-enhanced/`) are not snapshotted. Nested repositories
  are snapshotted only while *Snapshot nested git repositories* is on; a nested
  repository created during the turn is left in place and reported as skipped.
- **Web UI required.** The review tab needs the Desktop or `dsh web` profile;
  headless and tui profiles have no review surface.
- **Feature switches** live in Settings → Coding Enhanced and are stored in the
  DSH home, not in the profile's YAML configuration.
- Two edits to the same file in one message are previewed cumulatively, in call
  order.
- **Review view typography is relative** (`em`) and follows the application's
  base font size; it is deliberately larger than the old fixed-pixel layout.

---

<a id="roadmap"></a>

## 🗺️ Roadmap

The gate, the time machine, and the handoff are the product. The local diff UI
is deliberately simple; [`dsh-diff-approval`](https://github.com/9087/dsh-diff-approval)
already covers the “beautiful diff panel” case. Next:

- **P1 — standalone web review**: passkey pairing, always-on standby, outbound
  WSS bridge, review display and decisions.
- **P2 — line-level AI comments (B)**: a dedicated comment subagent; line
  selection; suggestions.
- **P3 — multi-round AI revisions**: previous-round dimming; a previous-round
  addition removed this round stays red.
- **P4 — external AI adversarial cross-review**: review-scoped tokens,
  participants, verdicts, proposals.

See [the architecture](docs/web-review-architecture.md), [the prior-art
survey](docs/prior-art.md), and [the review contract](docs/review-prompts-and-chain.md)
for the exact prompts and the full chain.

## 🛠️ Development

No build step:

```text
lib/index.js        Host plugin (ESM)
lib/client.js       Browser bundle (prebuilt lazy-CJS, served by dsh-client-modules)
docs/withdraw.md    Turn withdraw mechanism (project + shadow-git views)
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
git tag v<version>
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

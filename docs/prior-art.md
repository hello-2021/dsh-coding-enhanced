# 撞创意检索：GitHub / B 站

> 检索日期：2026-11-22。范围：GitHub 仓库搜索、DSH 插件生态列表、B 站视频搜索，以及已知的 AI coding / code review 产品。
> 这不是法律意义上的 exhaustive prior-art 检索；GitHub 只取了按 star 排序的头部结果，B 站只取了搜索页面前几页。

## 0. 结论先说

**有直接撞的，而且不止一个。**

- **最直接**：[`9087/dsh-diff-approval`](https://github.com/9087/dsh-diff-approval) — 同样是 DSH 插件，做“pending agent edits 的 diff review + per-file/per-block keep & revert + undo/redo + 评论/标注”，已发布 npm，UI 比我们成熟很多。
- **同一生态里还有一批“AI reviewer / advisor”插件**：答案评分、独立 reviewer、advisor 二次意见、持久 PMO reviewer、把 DSH 暴露给外部 agent 做 review 等。
- **B 站**没有找到直接讲我们这个 DSH 插件的视频，但“如何审核 AI 写的代码”“Claude Code 子 Agent 审查”“Cursor 回退”这些主题已经是热门内容（最高 15 万播放）。
- **我们完整的一套组合**（native write/edit 前置 gate + 多轮 withdraw + 非阻塞人类 review waiter + passkey Web 端 + 外部 AI 对抗式 cross-review）**没有找到完全相同的产品**，但每一块都有 prior art。

**建议：不要再以“AI code review / diff approval”作为主卖点**。`dsh-diff-approval` 已经在局部做得比我们完整；我们的差异化应放在 **gate + withdraw + 非阻塞 waiter + 远程/跨 AI review**。

---

## 1. 直接相关：DSH 插件

### 1.1 `dsh-diff-approval`（最接近）

- 仓库：<https://github.com/9087/dsh-diff-approval>
- npm：<https://www.npmjs.com/package/dsh-diff-approval>
- 数据：16 stars / 3 forks；TypeScript；创建 2026-08-16；最后 push 2026-11-12。
- 它的定位：

> Make every agent edit approvable in DeepSeek Harness: full-diff review, per-file / per-block keep & revert, undo/redo.

它的 README 列出的能力（节选）：

- 自动跟踪成功的 `edit` / `write` / editor mutation，折叠成 sidebar 里的 pending 列表；
- per-file / per-block **Keep / Revert**，支持拖选行范围后 Keep/Revert；
- **Undo / Redo**（keep/revert/import/comment 都可 undo）；
- **Comments & annotations**：选中行写评论，评论卡锚定在行下方；agent 可以主动 annotate；
- 行引用 `(file:line)`、split view、Markdown 预览、VCS 导入、持久化、虚拟滚动等；
- 可 dock 成右侧 tab 或 floating panel。

**和我们重叠的部分：**

| 能力 | 我们 | dsh-diff-approval |
|---|---|---|
| Pending review 列表 / diff UI | ✓（较简） | ✓✓（成熟很多） |
| Per-file approve/reject | ✓ | ✓ keep/revert |
| 行级选择 / 行引用 | 规划中 | ✓ |
| AI 注释/解释 | ✓ 自动 notes | ✓ agent 可 annotate；评论 |
| Undo / redo | ✓ 多轮 withdraw（更强） | ✓ 单次操作 undo |
| 持久化 | ✓ snapshot/state | ✓ pending state |

**它没有（至少 README 没体现）的：**

- **Pre-write gate**：它是“成功写入后再 review”；我们是在 native `write/edit` 执行前拦截并排队。这是一个真正的语义差异。
- **多轮 workspace withdraw**：它是单次操作 undo/redo；我们是多轮 shadow-git 快照、回退整个工作区。
- **非阻塞的人类 review waiter**：它是写完后 review，不涉及等待人类；我们是 review 期间主 agent 可以继续/结束。
- **独立 Web + passkey 配对**：没有。
- **外部 AI 对抗式 cross-review API**：没有。
- **多轮 AI 二次提交**：它是 per-block keep/revert，不是 AI 在 review 未结束时重新提交并淡化上一轮。

**判断：在“diff review UI + per-file keep/revert + AI 注释”这一层，它是直接竞品，而且比我们成熟。** 我们的优势必须来自它没有的 gate / withdraw / waiter / web / cross-review。

### 1.2 其他 DSH reviewer / advisor 插件

来自 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表（这些都是真实存在的 DSH 插件）：

| 插件 | 做什么 | 和我们的关系 |
|---|---|---|
| [`bycall/dsh-answer-reviewer`](https://github.com/bycall/dsh-answer-reviewer) | 每个最终 assistant turn 由独立 LLM 重新审查，1–100 打分；低于阈值把 agent 拉回修改 | 直接对应我们“AI 改动预审查 + 评分”的未来想法 |
| [`CAI-MH/dsh-quality-review`](https://github.com/CAI-MH/dsh-quality-review) | 每个 turn 后独立 reviewer 审查，最多 2 轮，SOP 规则注入 | 答案质量 review |
| [`ccll/dsh-advisor-flow`](https://github.com/ccll/dsh-advisor-flow) | executor / advisor：关键时刻 ask_advisor；拦截重复工具调用做 advisor review，proceed/revise/blocked | 对抗式二次意见的 prior art |
| [`suifei/dsh-pmo-button`](https://github.com/suifei/dsh-pmo-button) | 给 session 加一个**持久 PMO reviewer 子 agent**，每轮审查，STATUS: CONTINUE/DONE/NEED_HUMAN | 持久 reviewer 子 agent 的 prior art |
| [`qian-dsh/dsh-as-mcp-server`](https://github.com/qian-dsh/dsh-as-mcp-server) | 把 DSH 暴露成 MCP server，让另一个 agent 实时看工具调用/写文件、拿 floor lock 拒绝 DSH 写工具、delegate reviews | 外部 AI review / 跨 agent 的 prior art |
| [`WDahah/portable-dsh-multi-agent-plugin`](https://github.com/WDahah/portable-dsh-multi-agent-plugin) | 任务给一个模型、review 给另一个模型；合格证据、故障转移、journal | 任务/审查分离、跨模型 review |
| [`hongcha-dsh/dsh-dev-plan-presets`](https://github.com/hongcha-dsh/dsh-dev-plan-presets) | 主模型只 plan/dispatch/review；recon/review/scribe/develop 子 agent | 子 agent review 的 prior art |
| [`LittleAlety/dsh-team-conductor`](https://github.com/LittleAlety/dsh-team-conductor) | Agent Teams；任务完成要等 Lead review | 团队内 review |
| [`2002XiaoYu/dsh-session-diff`](https://github.com/2002XiaoYu/dsh-session-diff) | 会话级 diff 视图，右侧 sidebar，+/− 计数、changes only/whole file | review UI 的 prior art |

**判断：DSH 生态里“review / advisor / 评分 / 多 agent 交叉审查”已经很拥挤。** 我们的非阻塞 waiter 在“人类 review”这个点上仍有差异，但“持久 reviewer 子 agent”不是全新概念（`dsh-pmo-button`）。

---

## 2. 非 DSH 的相邻 prior art

### 2.1 Human-in-the-loop coding agents

- [Cline](https://github.com/cline/cline)：每个 edit 的 diff approve/reject；checkpoints/rewind。
- [Roo Code](https://github.com/RooCodeInc/Roo-Code)：类似，模式化 agent；checkpoints。
- [Cursor](https://cursor.com)：review changes、accept/reject、checkpoints；闭源。
- [Claude Code](https://www.anthropic.com/claude-code)：permission prompts、plan mode、checkpoints/rewind；闭源。
- [Aider](https://github.com/Aider-AI/aider)：git diff、/undo；CLI。
- [OpenHands](https://github.com/All-Hands-AI/OpenHands)：Web workspace、agent 运行、diff review；开源。
- [Continue](https://github.com/continuedev/continue)：IDE 内 agent/chat/edit。

这些产品已经把“AI 改代码 → 人看 diff → approve/reject”变成标准交互。**我们的 review gate 不是新交互**，只是把它搬进 DSH 并做成统一队列 + Finish。

### 2.2 AI PR review

- [CodeRabbit](https://www.coderabbit.ai)：PR 行级 review、建议、摘要。
- [Qodo Merge / PR-Agent](https://github.com/qodo-ai/pr-agent)：开源 PR review、行级 comment、建议。
- [Graphite Diamond](https://graphite.dev)：PR review + AI。
- GitHub Copilot code review：行级 comments。
- [`villesau/ai-codereviewer`](https://github.com/villesau/ai-codereviewer)、`codereview.gpt`、`open-code-review`（阿里）等。

这些把“AI 逐行解释/建议”做成主流。**我们的紫色 AI 说明行不是新概念**，只是把它嵌入“agent edit queue”而不是 PR。

### 2.3 Rewind / checkpoint

- Cursor / Cline checkpoints。
- [`arpagon/pi-rewind`](https://github.com/arpagon/pi-rewind)：per-turn checkpoint、/rewind、diff preview。
- [`Buzburg/agent-rewind`](https://github.com/Buzburg/agent-rewind)：local checkpoints、readable diffs、validated recovery。
- [`Simon-rss/undokey`](https://github.com/Simon-rss/undokey)：通用 undo key，filesystem checkpoints。
- `opencode-rewind`、`stepback` 等。

**多轮 withdraw / workspace rewind 也不是我们独有**；我们的差异是“按 turn 的 shadow-git 快照 + 多轮 rewind + pre-withdraw backup”。

---

## 3. B 站

搜索关键词：`AI 代码 审查`、`Cursor 代码 确认` 等；结果（播放量/作者/标题）：

| 播放 | 视频 | 相关性 |
|---|---|---|
| 150,070 | [如何审核 AI 写的代码？从写代码到上线，一套保证产品质量的全流程](https://www.bilibili.com/video/BV1PznU6YEZE) | 直接说明“审核 AI 代码”是热门话题 |
| 553 | [Claude Code 代码审查流程实践：提交前钩子、子 Agent 审查与 PR 风险分级](https://www.bilibili.com/video/BV1M3sM6NEs9) | **和我们的“子 agent 等待/审查”最接近的 workflow 内容** |
| 7,297 | [Claude Code 官方团队怎么审查代码？](https://www.bilibili.com/video/BV1XZx36pEUG) | 官方 review 流程 |
| 690 | [open-code-review：阿里开源 AI 代码审查神器](https://www.bilibili.com/video/BV1W9sL6UEsA) | 开源 AI PR review |
| 11,546 | [Cursor 怎么回退代码，防止改错改乱](https://www.bilibili.com/video/BV1TtwCehEzG) | withdraw/rewind 的 prior art |
| 567 | [国庆不带电脑，也能用手机盯着 Cursor 干活](https://www.bilibili.com/video/BV1HFaz6bEj3) | 远程/手机 review 的相邻需求 |

**B 站没有找到直接介绍 DSH 插件的视频**（DSH 生态相对小众），但“审核 AI 代码”已经是 15 万播放级别的主题，说明需求真实存在。

---

## 4. 能力重叠矩阵

| 能力 | 我们 | dsh-diff-approval | answer-reviewer | advisor-flow | pmo-button | as-mcp-server | Cline/Cursor | CodeRabbit/Qodo | B 站 workflow |
|---|---|---|---|---|---|---|---|---|---|
| Diff review UI | ✓ | ✓✓ | — | — | — | — | ✓ | ✓ | 教程 |
| Per-file decisions | ✓ | ✓ | — | — | — | — | ✓ | ✓ | — |
| AI 行级注释 | ✓ 自动 notes | ✓ agent annotate | — | — | — | — | 部分 | ✓ | — |
| **Pre-write gate（拦 native write/edit）** | **✓** | —（写后 review） | — | 拦截工具调用 | — | floor lock | 权限提示 | — | hooks |
| **多轮 workspace withdraw** | **✓** | 单次 undo | — | — | — | — | checkpoints | — | Cursor 回退 |
| **非阻塞人类 review waiter** | **✓** | — | — | — | — | — | — | — | 子 agent 审查 |
| 持久 reviewer 子 agent | ✓（人类 review） | — | ✓（AI review） | ✓ | ✓（PMO） | — | — | — | Claude 子 agent |
| 独立 Web + passkey | 规划中 | — | — | — | — | — | Cursor 手机 | Web/GitHub | — |
| 多轮 AI 修改/淡化 | 规划中 | per-block | — | — | — | — | — | 部分 | — |
| 外部 AI 对抗式 API | 规划中 | — | — | advisor | — | ✓ 外部 agent | — | — | — |

> ✓✓ = 明显更强；— = 未体现或没有。

---

## 5. 真正还有差异的部分

1. **Pre-write gate**：我们拦的是 native `write/edit/apply_patch`，在写入前排队；`dsh-diff-approval` 是写后 review。前者更“强制流程”，后者更“事后可撤销”。这是产品哲学差异，不一定是优势；要验证用户是否喜欢被 gate。
2. **多轮 workspace withdraw**：按 turn 的 shadow-git 快照 + 多轮回退 + pre-withdraw backup；比单次 undo 更接近“时间机器”。
3. **非阻塞人类 review waiter**：主 agent 起一个持久 waiter 子 agent，主 agent 继续聊天/结束；完成后唤醒。这个组合在 DSH 里没找到同样的实现（`pmo-button` 是 AI 评审，不是人类 review）。
4. **独立 Web + passkey 配对 + 常驻 standby**：没找到完全一样的；`OpenHands`/`bottleneck` 有 Web review，但不是 passkey 配对。
5. **外部 AI 对抗式 cross-review API**：`dsh-as-mcp-server` / `portable-dsh-multi-agent-plugin` 是相邻能力，但“review-scoped token + participants/verdicts/proposals”这套接口没有现成产品。

---

## 6. 建议

1. **不要宣称“首个 / 唯一”**。`dsh-diff-approval` 在“review pending edits + per-file keep/revert + 注释”上已经是直接竞品，而且 UI 比我们成熟。
2. **不要把 P1 Web 端做成“又一个 diff review 面板”**。那会正面撞 `dsh-diff-approval`（本地）和 CodeRabbit/Qodo（PR）。
3. **把 P1 Web 端定位成“远程/常驻的 AI 变更 gate”**：
   - passkey 配对 + standby；
   - 行级 AI comment subagent（B）；
   - 多轮 AI 修改/淡化；
   - 对抗式 cross-review API；
   - 与 DSH 的 gate/withdraw 绑定。
4. **我们的身份**：不是“AI code review 工具”，而是 **“DSH 的变更 gate + 工作区时间机器 + 非阻塞人类 review 交接”**。
5. **不急着改代码**。先把 README 的 positioning 改掉，避免和 `dsh-diff-approval` 正面比较；把“gate / withdraw / waiter / cross-review”作为主叙事。
6. **市场仍然早**：`dsh-diff-approval` 16 stars，DSH 插件生态刚起；不是赢家通吃。B 站 15 万播放说明需求在，但用户要的是“怎么审核”，不是“又一个 diff 工具”。

---

## 7. 来源

- dsh-diff-approval：<https://github.com/9087/dsh-diff-approval> · <https://www.npmjs.com/package/dsh-diff-approval>
- awesome-dsh-plugin：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- dsh-answer-reviewer：<https://github.com/bycall/dsh-answer-reviewer>
- dsh-quality-review：<https://github.com/CAI-MH/dsh-quality-review>
- dsh-advisor-flow：<https://github.com/ccll/dsh-advisor-flow>
- dsh-pmo-button：<https://github.com/suifei/dsh-pmo-button>
- dsh-as-mcp-server：<https://github.com/qian-dsh/dsh-as-mcp-server>
- portable-dsh-multi-agent-plugin：<https://github.com/WDahah/portable-dsh-multi-agent-plugin>
- dsh-session-diff：<https://github.com/2002XiaoYu/dsh-session-diff>
- Cline：<https://github.com/cline/cline> · Roo Code：<https://github.com/RooCodeInc/Roo-Code> · Aider：<https://github.com/Aider-AI/aider> · OpenHands：<https://github.com/All-Hands-AI/OpenHands> · Continue：<https://github.com/continuedev/continue>
- PR-Agent/Qodo：<https://github.com/qodo-ai/pr-agent> · CodeRabbit：<https://www.coderabbit.ai> · Graphite：<https://graphite.dev>
- ai-codereviewer：<https://github.com/villesau/ai-codereviewer>
- pi-rewind：<https://github.com/arpagon/pi-rewind> · agent-rewind：<https://github.com/Buzburg/agent-rewind> · undokey：<https://github.com/Simon-rss/undokey>
- B 站：<https://www.bilibili.com/video/BV1PznU6YEZE> · <https://www.bilibili.com/video/BV1M3sM6NEs9> · <https://www.bilibili.com/video/BV1XZx36pEUG> · <https://www.bilibili.com/video/BV1W9sL6UEsA> · <https://www.bilibili.com/video/BV1TtwCehEzG> · <https://www.bilibili.com/video/BV1HFaz6bEj3>

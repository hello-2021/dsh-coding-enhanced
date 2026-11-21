# Review UI directions

A single interactive demo with three directions for the coding-enhanced review
UI. Open [`index.html`](index.html) in a browser; switch directions with the
tabs at the top.

## What to try

- Switch **GitHub 原生 / AI 原生 / 科幻 HUD**.
- Click or drag the **line numbers** on the left of the diff; the floating bar
  offers **Explain**, **Suggest change**, **Ask AI**, and **Clear**.
- Toggle **Dim previous round** (on by default): round-1 additions fade; a
  previous-round line removed in round 2 stays red at current intensity.
- Approve / reject a file, then **Finish review**.
- Ask the AI reviewer about a selection in the right rail.

## The three directions

| Direction | Idea | Strengths | Trade-offs | Best for |
|---|---|---|---|---|
| **GitHub 原生** | Keep GitHub's grammar: dense file rail, unified diff, compact review rail. AI notes are a subtle gradient row. | Familiar, information-dense, lowest implementation risk, closest to the existing DSH tab. | Least differentiated; AI feels like an add-on. | **DSH client tab**, first release. |
| **AI 原生** | Explanation-first: each hunk is a card, AI notes are prominent, and the right rail is a persistent reviewer conversation. | AI explanations are first-class; diff + chat stay together; comfortable reading. | More vertical space; lower density. | **Standalone web app** and longer reviews. |
| **科幻 HUD** | Dark glass, neon violet→cyan gradient, glowing line-range selection, HUD-like status. | Strongest visual identity; line selection feels physical; great for demo/showcase. | Can fatigue during long reviews; highest maintenance/accessibility cost. | Optional theme, demos, power users. |

## Recommendation

A good product can combine them:

1. **Structure** from GitHub native: file rail, diff, review rail, low-friction
   decisions.
2. **Explanation treatment** from AI native: line-anchored gradient notes,
   hunk cards, and a place to ask about a line range.
3. **A small amount of sci-fi HUD** for selection feedback: a glowing range and
   a floating action bar, not a fully dark theme by default.

For the next implementation step:

- **In the DSH client tab**: ship GitHub native + gradient AI notes first.
- **Standalone web app**: use AI native as the default, with GitHub native as
  a "compact" density option and sci-fi HUD as a theme.

## Shared behavior in the demo

- **AI notes** are line-anchored: the purple gradient row is inserted directly
  after the anchored added line, inside the green group (not only at the end of
  the group).
- **Rounds**: current round is full intensity; previous-round additions are
  dimmed; a previous-round addition deleted in the current round is red at
  current intensity.
- **Line selection**: click a line number, or press and drag across line
  numbers; the selection bar exposes Explain / Suggest / Ask.
- **Review waiter**: the right rail shows a waiting subagent, so the main agent
  is not blocked while the human reviews.

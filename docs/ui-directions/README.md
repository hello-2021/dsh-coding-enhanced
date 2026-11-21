# Review UI — GitHub native

The chosen direction is **GitHub native only**. No alternate themes or
directions are offered.

Open [`index.html`](index.html) to try the interaction.

## AI explanation row

The AI explanation is no longer a card. It is a **normal diff row**:

- same grid and line height as the code rows;
- a subtle violet → fuchsia → cyan gradient tint;
- a 2px violet edge, `✦` in the sign column, and a tiny `AI` badge;
- one line of text with ellipsis; hover the row to read the full explanation;
- no margin, border radius, shadow or card chrome.

This keeps the code rhythm intact and makes the explanation feel like a
annotation line rather than a block that interrupts the diff.

## What to try

- Switch files in the left rail.
- Click or drag line numbers to select a range; use **Explain**,
  **Suggest change**, **Ask AI**, **Clear**.
- Toggle **Dim previous round**: round-1 additions fade; a previous-round line
  removed in round 2 stays red at current intensity.
- Approve / reject a file and **Finish review**.
- Ask the AI reviewer about a selection in the right rail.

## Why this direction

- familiar GitHub grammar, dense and low-risk;
- the AI explanation is visible without taking over the diff;
- closest to the existing DSH review tab and the fastest to ship.

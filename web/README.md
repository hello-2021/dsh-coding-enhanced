# dsh-coding-enhanced-web

Standalone web review server for `dsh-coding-enhanced`.

- **Username + user key** auth. Registration issues a 32-byte key once; the
  server stores only `sha256(key)` and a 6-character hint.
- One-time pairing code -> device token (only the token hash is stored).
- `/ws/device`: plugin outbound WSS; receives `review.snapshot` /
  `review.update` / `review.result`.
- `/ws/browser`: session cookie; receives snapshots and sends `decision` /
  `line.request` / `chat.send` to the paired device.
- `/api/reviews` / `/api/reviews/:id`: cached review list and snapshot.
- `/api/chat`: global chat history.
- SQLite via Node's built-in `node:sqlite` (no native `better-sqlite3`).
- React UI: Standby, Devices, Reviews, Review detail with a persistent Ask AI
  box in the left sidebar; per-file Approve/Reject and Finish; pure white theme.

Passkey/WebAuthn is **not** used.

## Run

Requires Node **>= 22.5** (Node 24 tested; `node:sqlite`).

Production:

```bash
cd web
npm install
npm run build
node server/index.js --port 4317 --data ~/.dsh-coding-enhanced-web
# open http://localhost:4317
```

The server serves `dist/` after the build. Before the first build it falls back
to the small `public/index.html` health page.

Vite dev UI with HMR (separate terminal):

```bash
ORIGIN=http://localhost:5173 node server/index.js --port 4317 --data ~/.dsh-coding-enhanced-web
cd web && npm run dev:web
# open http://localhost:5173
```

Defaults:

| Flag | Default | Notes |
|---|---|---|
| `--port` | `4317` | |
| `--host` | `127.0.0.1` | binding only; open `localhost` |
| `--data` | `~/.dsh-coding-enhanced-web` | SQLite lives here |
| `--origin` | `http://localhost:<port>` | must match the browser origin |

For Vite dev, start the server with `ORIGIN=http://localhost:5173` so the
session cookie and the page share an origin. For LAN/remote use, put the server
behind HTTPS and set `--origin` explicitly.

## Auth

1. `POST /api/auth/register` with `{ username }`; the server returns
   `{ user, key }` once.
2. Save the key (password manager). It is the only way to sign in.
3. `POST /api/auth/login` with `{ username, key }`; the server compares the
   `sha256` hash with `timingSafeEqual` and sets an `HttpOnly` session cookie.
4. There is no password and no passkey. No plaintext user key is stored.

## Pairing flow

1. Register / login in the browser.
2. `POST /api/devices/pairing-code` -> `{ code, expiresAt }` (10 min TTL).
3. Plugin calls `POST /api/pair` with `{ code, deviceName, instanceId }` and
   receives `{ deviceId, token }`.
4. Plugin connects `ws://localhost:4317/ws/device?token=<token>`.
5. Browser connects `ws://localhost:4317/ws/browser` with the session cookie.

The plugin stores the token locally and reconnects with 1s/2s/5s/10s backoff,
sending its current `review.snapshot` after `hello`.

## REST

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | none |
| POST | `/api/auth/register` | none (username) |
| POST | `/api/auth/login` | none (username + key) |
| GET | `/api/auth/me` | session |
| POST | `/api/auth/logout` | session |
| POST | `/api/devices/pairing-code` | session |
| POST | `/api/pair` | pairing code |
| GET | `/api/devices` | session |
| DELETE | `/api/devices/:id` | session |
| GET | `/api/reviews?status=open` | session |
| GET | `/api/reviews/:id` | session |

## WSS messages

Server -> plugin:

```json
{ "type": "hello", "deviceId": "device-...", "serverTime": 0 }
{ "type": "decision", "requestId": "...", "reviewId": "...", "decisionId": "...", "expectedVersion": 1, "decisions": {} }
{ "type": "line.request", "requestId": "...", "reviewId": "...", "lineRequest": { "id": "...", "path": "src/a.ts", "startLine": 1, "endLine": 2, "kind": "explain" } }
```

Plugin -> server:

```json
{ "type": "hello", "deviceId": "device-...", "pluginVersion": "0.9.1", "capabilities": {} }
{ "type": "review.snapshot", "review": { "id": "review-...", "version": 1, "sessionId": "...", "status": "open", "title": "...", "files": [] } }
{ "type": "review.update", "review": {} }
{ "type": "review.result", "reviewId": "...", "results": [], "version": 1, "error": "optional" }
```

Browser -> server: `decision`, `line.request`, `ping`. Server -> browser:
`hello`, `device.status`, `review.snapshot`, `review.result`, `error`, `pong`.

## Security notes

- User key: 32 random bytes; only `sha256(key)` and a 6-character hint are
  stored. Registration/login are rate-limited.
- Device token: 32 random bytes; only `sha256(token)` is stored. Revoke via
  `DELETE /api/devices/:id`.
- Pairing code: one-time, 10 minute TTL, rate-limited.
- Session: random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie; the
  server stores only its hash.
- CSP and `X-Content-Type-Options` are set on HTTP responses; code/AI text must
  be escaped by the UI.
- AI keys never enter this server; AI still runs in DSH.

## Next

- W4 syntax highlighting (light theme), inline AI notes, soft-wrapped diffs,
  the collapsible app sidebar, and the topbar back button are shipped.
- Remaining: PWA/manifest, push, TLS deployment docs, and multiple bots / DSH
  instances submitting reviews under one user.

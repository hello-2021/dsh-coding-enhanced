# dsh-coding-enhanced-web

Standalone web review server for `dsh-coding-enhanced`. This is the **W1a
skeleton**: passkey auth, DSH device pairing, device/browser WSS, and a review
snapshot cache. The React review UI and the plugin-side outbound WSS client are
the next slices.

## Scope

- username + passkey registration / login (WebAuthn, `@simplewebauthn/server`);
- one-time pairing code -> device token (hash stored server-side);
- `/ws/device`: plugin outbound WSS, receives `review.snapshot` / `review.update`
  / `review.result`;
- `/ws/browser`: passkey session cookie, receives snapshots and sends
  `decision` / `line.request` to the paired device;
- `/api/reviews` / `/api/reviews/:id`: cached review list and snapshot;
- SQLite via Node's built-in `node:sqlite` (no native `better-sqlite3`).

Not in W1a: React review UI (W1b), plugin outbound client (W2), decisions applied
end-to-end (W3), PWA/push (W4).

## Run

Requires Node **>= 22.5** (Node 24 tested; `node:sqlite`).

```bash
cd web
npm install
npm run dev:server
# open http://localhost:4317
```

Defaults:

| Flag | Default | Notes |
|---|---|---|
| `--port` | `4317` | |
| `--host` | `127.0.0.1` | binding only; open `localhost` |
| `--data` | `~/.dsh-coding-enhanced-web` | SQLite lives here |
| `--rp-id` | `localhost` | WebAuthn RP ID |
| `--origin` | `http://localhost:<port>` | must match the browser origin |

Passkeys require a secure context. Open **`http://localhost:4317`**, not
`http://127.0.0.1:4317` — some browsers reject an IP RP ID. For LAN/remote use,
put the server behind HTTPS and set `--origin` / `--rp-id` explicitly.

For Vite dev (`npm run dev:web`, port 5173), start the server with
`ORIGIN=http://localhost:5173` so WebAuthn verification matches the page origin.

## Pairing flow

1. Register / login in the browser.
2. `POST /api/devices/pairing-code` -> `{ code, expiresAt }` (10 min TTL).
3. Plugin calls `POST /api/pair` with `{ code, deviceName, instanceId }` and
   receives `{ deviceId, token }`.
4. Plugin connects `ws://localhost:4317/ws/device?token=<token>`.
5. Browser connects `ws://localhost:4317/ws/browser` with the session cookie.

The plugin should store the token locally and reconnect with 1s/2s/5s/10s
backoff, sending its current `review.snapshot` after `hello`.

## REST

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | none |
| POST | `/api/auth/passkey/register/options` | none (username) |
| POST | `/api/auth/passkey/register/verify` | none (challenge) |
| POST | `/api/auth/passkey/login/options` | none (username) |
| POST | `/api/auth/passkey/login/verify` | none (challenge) |
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
{ "type": "hello", "deviceId": "device-...", "pluginVersion": "0.8.5", "capabilities": {} }
{ "type": "review.snapshot", "review": { "id": "review-...", "version": 1, "sessionId": "...", "status": "open", "title": "...", "files": [] } }
{ "type": "review.update", "review": {} }
{ "type": "review.result", "reviewId": "...", "results": [], "version": 1 }
```

Browser -> server: `decision`, `line.request`, `ping`. Server -> browser:
`hello`, `device.status`, `review.snapshot`, `review.result`, `error`, `pong`.

## Security notes

- Device token: 32 random bytes, server stores only `sha256(token)`; revoke via
  `DELETE /api/devices/:id`.
- Pairing code: one-time, 10 minute TTL, rate-limited.
- Session: random 32-byte token in an `HttpOnly`, `SameSite=Lax` cookie; the
  server stores only its hash. CSRF hardening and a per-session CSRF token are
  a W3/W4 item.
- CSP and `X-Content-Type-Options` are set on HTTP responses; code/AI text must
  be escaped by the UI.
- AI keys never enter this server; AI still runs in DSH.

## Next

- W1b: React + Vite review UI (login/register, standby, reviews, review detail,
  devices) using `docs/ui-directions/index.html` as the visual reference.
- W2: plugin Web settings + outbound WSS + snapshot sync.
- W3: decision/edit/finish end-to-end, reconnect, offline read-only.
- W4: PWA/manifest, push, rate-limit/audit hardening, TLS deployment docs.

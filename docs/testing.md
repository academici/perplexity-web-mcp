# Testing Guide

This guide walks you through the different ways to test `perplexity-web-mcp` locally before integrating it into your MCP client.

The browser always runs **visible** (non-headless) — this is required to pass Cloudflare's bot detection.

## Prerequisites

Make sure you have built the project first:

```bash
npm install
npm run build
```

### Unit tests (no browser, no network)

The pure logic — config/pool resolution, the NDJSON protocol, the saturation tab-pool, and the daemon socket bind-race — is covered by `node:test`:

```bash
npm test
```

These run in well under a second and require no display or Perplexity login. Run them after any change to `src/config.ts`, `src/pool.ts`, `src/daemon/*`, or `src/dispatcher.ts`.

---

## Test 1 — Authentication via the `login` tool

Call the `login` tool to authenticate with a Perplexity account. The browser opens on demand — no `--auth` flag needed.

```bash
# Linux / macOS
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"login","arguments":{}}}' | node dist/index.js
```

```bash
# Windows (Git Bash / MINGW64)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"login","arguments":{}}}' > /tmp/mcp-login.json
node dist/index.js < /tmp/mcp-login.json
```

**If already authenticated**, expected stdout:

```json
{ "result": { "content": [{ "type": "text", "text": "Already authenticated on Perplexity.ai." }] } }
```

**If not authenticated:**

1. A Chromium window opens on `perplexity.ai`
2. Sign in with your Google account (or email)
3. Once logged in, the tool returns:

```json
{ "result": { "content": [{ "type": "text", "text": "Login successful. You are now authenticated on Perplexity.ai." }] } }
```

Your session is persisted in `.playwright/profile/` — you will not need to log in again.

> **Timeout:** If you do not log in within 5 minutes, the server will exit with an error.

---

## Test 2 — Integration with Claude Code

Add the following to your Claude Code MCP settings (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "perplexity-web": {
      "command": "node",
      "args": ["C:/src/perplexity-web-mcp/dist/index.js"]
    }
  }
}
```

Then:
- Ask Claude: **"Login to Perplexity"** to authenticate
- Ask Claude: **"Search for TypeScript best practices using perplexity"** — uses `search`
- Ask Claude: **"Search for AI research papers using perplexity with web and academic sources"** — uses `search_advanced`

---

## Test 3 — Concurrency & browser pools (daemon mode)

These verify the daemon fixes cross-project/sub-agent collisions. They need a real display (visible Chromium) and a logged-in `default` pool. Helper to send one tool call:

```bash
call() { echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"search\",\"arguments\":{\"query\":\"$1\"}}}"; }
```

1. **Shared pool, parallel tabs (the original bug).** In two terminals, both on the `default` pool:
   ```bash
   call "site reliability engineering" | node dist/index.js          # terminal A
   call "kubernetes operators"        | node dist/index.js          # terminal B
   ```
   Expect: **one** window, **two tabs** running at once, both return. The second does **not** wait ~120s and the window does **not** get torn down/reopened. Tail the log to see `req <id> -> tab <n>`:
   ```bash
   tail -f "${XDG_RUNTIME_DIR:-/tmp}/perplexity-web-mcp/default.log"
   ```

2. **Isolated pools.** Run a deep search on pool `a` and a normal search on pool `b` concurrently:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_deep","arguments":{"query":"history of TLS"}}}' | node dist/index.js --pool=a
   call "what is QUIC" | node dist/index.js --pool=b
   ```
   Expect: **two** windows, fully independent, no lock errors. (Pool `a`/`b` need their own `login` the first time.)

3. **Saturation policies.** Force a cap of 1 via a config file and fire two calls at once:
   ```jsonc
   // .playwright/config.json
   { "pools": { "default": { "maxConcurrency": 1, "saturation": { "mode": "fail-fast" } } } }
   ```
   Expect the 2nd concurrent call to return a `BROWSER_BUSY` message immediately. Switch `mode` to `hybrid` (`waitMs: 5000`) → it waits ≤5s then `BROWSER_BUSY`; `queue` → it waits and then succeeds.

4. **Idle shutdown.** Set `"idleShutdownMs": 15000`, run one search, then watch the daemon exit and the socket disappear after ~15s idle:
   ```bash
   ss -lx | grep perplexity-web-mcp   # socket present during/after a call, gone after idle
   ```

5. **Crash recovery.** While idle, `kill -9` the daemon PID (see the log / `pgrep -f 'index.js --daemon'`). The next search transparently respawns it and succeeds.

6. **Legacy fallback.** `PERPLEXITY_WEB_MCP_MODE=legacy node dist/index.js` reproduces the pre-daemon in-process behavior byte-for-byte.

---

## CLI flags reference

| Flag | Default | Description |
|------|---------|-------------|
| `--timeout=N` | `60` | Max seconds to wait for Perplexity to answer (overrides the pool's `searchTimeoutMs`) |
| `--pool=NAME` | `default` | Which browser pool (daemon/socket/profile) to use |
| `--mode=daemon\|legacy` | `daemon` | `daemon` = shared background browser; `legacy` = in-process (pre-daemon) |
| `--config=PATH` | — | Path to a `config.json` (see the README) |

Env equivalents: `PERPLEXITY_WEB_MCP_MODE`, `PERPLEXITY_WEB_MCP_POOL`, `PERPLEXITY_WEB_MCP_CONFIG`.

> **The daemon is a separate executable** — `dist/daemon/main.js` (bin `perplexity-web-mcp-daemon`). The MCP client (`dist/index.js`) spawns it automatically and detached; you never run it by hand. For debugging you can start one in the foreground:
>
> ```bash
> node dist/daemon/main.js --pool=default     # logs to the pool's logfile; Ctrl+C to stop
> ```

---

## Debug logs

The **client** prints a startup line to stderr; per-search progress goes to the **daemon** logfile (`<runtime-dir>/perplexity-web-mcp/<pool>.log`) in daemon mode, or to stderr in legacy mode:

```
[perplexity-web-mcp] Starting (mode=daemon, pool=default). Browser launches on first tool call.
```

Daemon logfile sample:

```
[2026-06-30T...] [pid 12345] Daemon starting for pool "default" (socket=..., profile=...)
[2026-06-30T...] [pid 12345] Listening on .../default.sock (maxConcurrency=3, saturation=hybrid, idleShutdownMs=300000).
[2026-06-30T...] [pid 12345] Browser ready.
[2026-06-30T...] [pid 12345] req 7f3a... -> tab 0 (search, inFlight=1/3, waiting=0)
[2026-06-30T...] [pid 12345] Done. Answer length: 1243 chars, sources: 5
```

---

## Troubleshooting

**`button:has-text("sources")` timeout**

Perplexity did not finish generating the answer within the timeout, or the selector changed. Try increasing the timeout with `--timeout=40`. If the problem persists, inspect the Chromium window and update the selector in `src/search.ts`.

**Chromium not found**

Run `npx playwright install chromium` manually. This should have been done automatically via the `postinstall` script, but may fail in restricted environments.

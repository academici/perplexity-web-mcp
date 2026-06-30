# perplexity-web-mcp

A lightweight MCP (Model Context Protocol) server that enables AI assistants to perform searches on [Perplexity.ai](https://www.perplexity.ai/) through browser automation. No official API key required.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-FastMCP-purple.svg)](https://github.com/punkpeye/fastmcp)

---

## Overview

`perplexity-web-mcp` bridges your AI assistant (Claude, Cursor, etc.) with Perplexity.ai by automating a real browser session via Playwright. It reads search results directly from the DOM — making it indistinguishable from a real user — and returns the answer text along with cited sources.

### Key features

- **Login once, search forever** — use the `login` tool to authenticate once; your session persists across restarts
- **Lazy browser launch** — the browser only opens on the first tool call, not at server startup
- **Always visible browser** — runs non-headless to bypass Cloudflare's bot detection (the window stays in the background during searches)
- **Concurrent searches, one browser** — a single background **daemon** owns the browser and runs each request in its own tab, so multiple projects and parallel sub-agents search at the same time without colliding (see [Concurrency & browser pools](#concurrency--browser-pools))
- **Isolated pools** — point different projects at named pools for fully separate browser windows/profiles, or share one pool to share a window
- **Sources included** — returns cited URLs alongside the answer text
- **Zero API key** — uses your existing Perplexity session (free or Pro)

---

## Installation

**Prerequisites:**
- [Node.js](https://nodejs.org/) >= 20
- Chromium (via Playwright): `npx playwright install chromium`

```bash
npx playwright install chromium
```

That's it — no clone, no build required.

---

## MCP configuration

### Claude Code

```bash
claude mcp add perplexity-web -- npx perplexity-web-mcp@latest
```

### Claude Desktop / other clients

Add to your MCP config (`.claude.json`):

```json
{
  "mcpServers": {
    "perplexity-web": {
      "command": "npx",
      "args": ["perplexity-web-mcp@latest"]
    }
  }
}
```

Optional flags: `--timeout=N` (max seconds to wait for an answer), `--pool=NAME` (which browser pool to use, default `default`), `--mode=daemon|legacy`, `--config=PATH`.

To authenticate, ask your AI client to call the `login` tool once. A Chromium window will open for you to sign in. Your session is persisted in `.playwright/profile/` and reused on future runs.

> **Why is a browser window visible?** Perplexity.ai uses Cloudflare Turnstile which blocks headless browsers. The window stays in the background and requires no interaction during normal use.

---

## Concurrency & browser pools

Chromium allows only **one** browser per profile directory, so historically two projects (or several parallel sub-agents) calling Perplexity at once would fight over the shared profile — one request would tear the window down while another was still streaming, and a second project could block for up to two minutes before erroring.

To fix this, the server runs in **daemon mode** by default:

- The **first tool call** in a pool launches a small background **daemon process** — a separate executable, `perplexity-web-mcp-daemon` (`dist/daemon/main.js`), spawned detached — that owns the persistent Chromium for that pool. Every MCP server process (one per client) becomes a thin client that talks to the daemon over a Unix domain socket.
- Each search runs in **its own tab**; up to `maxConcurrency` run in **parallel**. A 10-minute deep research no longer blocks ordinary searches.
- When all tabs are busy, the **saturation policy** decides what a new request does.
- The daemon **self-shuts-down** after an idle period and releases everything.
- If the daemon can't be started (e.g. sandboxed environment, Windows), the client **automatically falls back** to the old in-process behavior — nothing breaks.

### Pools

A **pool** is one daemon = one socket + one profile + one window. Select a pool per project with `--pool=NAME` or `PERPLEXITY_WEB_MCP_POOL`:

- Two projects using the **same** pool name → they **share** one daemon/window (searches run as parallel tabs).
- Different pool names → **fully isolated** daemons, profiles, and windows.

> The `default` pool reuses the existing `.playwright/profile/`, so your current login is preserved. Other pools get their own profile under `.playwright/profiles/<pool>/` and need their own `login`.

### Configuration

Resolution order — **CLI flag > env var > config file > built-in default**:

| Setting | CLI | Env | Config key | Default |
|---------|-----|-----|------------|---------|
| Mode | `--mode=` | `PERPLEXITY_WEB_MCP_MODE` | `mode` | `daemon` |
| Pool | `--pool=` | `PERPLEXITY_WEB_MCP_POOL` | `defaultPool` | `default` |
| Config file path | `--config=` | `PERPLEXITY_WEB_MCP_CONFIG` | — | `$XDG_CONFIG_HOME/perplexity-web-mcp/config.json`, then `.playwright/config.json` |

Config file (`config.json`):

```json
{
  "mode": "daemon",
  "defaultPool": "default",
  "pools": {
    "default":  { "maxConcurrency": 3, "idleShutdownMs": 300000, "saturation": { "mode": "hybrid", "waitMs": 30000 } },
    "research": { "profileDir": "/home/me/.pplx-research", "maxConcurrency": 5, "saturation": { "mode": "queue" } }
  }
}
```

Per-pool knobs (all optional):

| Key | Default | Meaning |
|-----|---------|---------|
| `maxConcurrency` | `3` | Max parallel search tabs |
| `idleShutdownMs` | `300000` | Close the browser & exit after this idle time |
| `saturation.mode` | `hybrid` | `queue` (wait) · `fail-fast` (immediate `BROWSER_BUSY`) · `hybrid` (wait then `BROWSER_BUSY`) |
| `saturation.waitMs` | `30000` | For `hybrid`: how long to wait before `BROWSER_BUSY` |
| `socketPath` | derived | Override the Unix socket path |
| `profileDir` | derived | Override the Chromium profile directory |
| `searchTimeoutMs` / `deepTimeoutMs` | `60000` / `600000` | Per-request answer timeouts |

When a pool is saturated under `fail-fast`/`hybrid`, the tool returns a `BROWSER_BUSY` message so the calling agent can retry shortly.

Daemon logs (no stdout is attached to it) go to `<runtime-dir>/perplexity-web-mcp/<pool>.log`.

To force the pre-daemon behavior everywhere, set `--mode=legacy` (or `PERPLEXITY_WEB_MCP_MODE=legacy`).

---

## MCP Tools

### `login`

Checks if you are authenticated on Perplexity.ai. If not, opens a browser window so you can log in.

**Parameters:** none

**Returns:** A status message — either `"Already authenticated"` or `"Login successful"` after the user completes the login flow.

> Your session is persisted in `.playwright/profile/` — you only need to call `login` once, or after a session expiry.

---

### `search`

Performs a search on Perplexity.ai using default settings and returns the answer with sources. Prefer this for general queries.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | Yes | The search query |

**Returns:**

```
The capital of France is Paris...

Sources:
1. [Capital City of France - CountryReports](https://www.countryreports.org/...)
```

---

### `search_advanced`

Same as `search` but lets you select which sources Perplexity searches. You can combine multiple sources. Uses browser UI automation to toggle the source checkboxes — more powerful but slightly less resilient to UI changes.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | Yes | The search query |
| `sources` | `string[]` | Yes | One or more sources: `web`, `academic`, `social` |

**Example:** `sources: ["web", "academic"]` searches both general web and scholarly articles simultaneously.

**Returns:** Same format as `search`.

---

## Architecture

In **daemon mode** (default) the FastMCP server is a thin client: it forwards each tool call over a Unix socket to a per-pool **daemon** that owns the browser and runs the flow below in a dedicated tab (many in parallel). In **legacy mode** the FastMCP server runs that same flow in-process. Either way the per-search steps are identical:

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Client (Claude Desktop / Claude Code / Cursor / ...)        │
└────────────────────────┬────────────────────────────────────────┘
                         │  MCP stdio transport
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  perplexity-web-mcp  (FastMCP server)                           │
│                                                                 │
│  ┌─────────────────┐   ┌──────────────────────────────────────┐ │
│  │  CLI Arguments  │   │  MCP Tools                           │ │
│  │                 │   │                                      │ │
│  │  --timeout=N    │   │  login()                             │ │
│  │                 │   │    checks session, opens browser     │ │
│  │                 │   │    for login if not authenticated     │ │
│  │                 │   │                                      │ │
│  │                 │   │  search(query, mode?)                │ │
│  │                 │   │    returns: { answer, sources[] }    │ │
│  └────────┬────────┘   └──────────────┬───────────────────────┘ │
│           │                           │                         │
│           ▼                           ▼                         │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Browser Manager (Playwright, always visible)              │ │
│  │                                                            │ │
│  │  (browser launches lazily on first tool call)              │ │
│  │                                                            │ │
│  │  login()                                                   │ │
│  │    ├── GET /api/auth/session                               │ │
│  │    │    ├── active ──► "already authenticated"             │ │
│  │    │    └── none   ──► open browser, wait for user login   │ │
│  │                                                            │ │
│  │  search(query)                                             │ │
│  │    ├── open new tab, navigate to perplexity.ai             │ │
│  │    ├── type query in search box                            │ │
│  │    ├── wait for answer to complete (DOM signal)            │ │
│  │    ├── extract answer text from DOM                        │ │
│  │    ├── extract cited sources                               │ │
│  │    └── close tab                                           │ │
│  │                                                            │ │
│  │  search_advanced(query, sources[])                         │ │
│  │    ├── open new tab, navigate to perplexity.ai             │ │
│  │    ├── open "+" menu → "Connecteurs et sources"            │ │
│  │    ├── toggle source checkboxes to match requested sources │ │
│  │    ├── type query, wait for answer, extract DOM            │ │
│  │    └── close tab                                           │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   perplexity.ai      │
              │  (real browser req)  │
              └──────────────────────┘
```

---

## Development

```bash
# Run in development mode (hot reload)
npm run dev

# Build
npm run build

# Lint
npm run lint

# Type check
npm run typecheck
```

### Testing locally

See **[docs/testing.md](docs/testing.md)** for a full step-by-step guide covering:

- First-time authentication flow
- Persistent session verification
- Integration with Claude Code / Claude Desktop

---

## How it works

1. **Lazy browser launch** — the browser only opens when the first tool (`login` or `search`) is called, not at server startup.
2. **Login** — the `login` tool calls `GET /api/auth/session` to check the persisted session. If no session is found, a browser window opens and the server waits for the user to log in (up to 5 minutes).
3. **Search** — the `search` tool opens a new tab, navigates to `perplexity.ai`, types the query, and waits for Perplexity's answer to complete (detected via a DOM signal — the "N sources" button appearing).
4. **Search Advanced** — `search_advanced` does the same but first opens the source selector menu and toggles the requested sources (identified by their SVG icon IDs, which are locale-independent).
5. **Extraction** — the answer and sources are extracted from the DOM and returned as text to the MCP client. The tab is then closed.
5. **Visible browser** — the browser always runs non-headless to pass Cloudflare's Turnstile bot detection, which reliably blocks headless Chromium regardless of stealth patches.

---

## Limitations

- Depends on Perplexity.ai's DOM structure — may break if they update their UI
- Rate limiting applies as per Perplexity's standard usage policies
- A visible browser window is always present (required to bypass Cloudflare Turnstile)
- Pro features (deeper research, Claude model) require an authenticated Pro account

---

## Contributing

Contributions are welcome! Please open an issue before submitting large PRs.

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Commit your changes
4. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Disclaimer

This project automates a browser session for personal use. It is not affiliated with Perplexity AI, Inc. Use responsibly and in accordance with [Perplexity's Terms of Service](https://www.perplexity.com/hub/legal/terms-of-service).

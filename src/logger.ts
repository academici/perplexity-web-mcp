// Single process-wide log sink. Defaults to stderr (the MCP client convention —
// stdout is the JSON-RPC channel). The daemon redirects this to a per-pool
// logfile via setLogger() at startup, so search/auth/browser-core logging works
// the same in both legacy (client) and daemon processes.
type Sink = (msg: string) => void;

let sink: Sink = (msg) => console.error(`[perplexity-web-mcp] ${msg}`);

export function setLogger(fn: Sink): void {
  sink = fn;
}

export function log(msg: string): void {
  sink(msg);
}

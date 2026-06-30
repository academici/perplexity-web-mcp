import type { SearchResult } from "./search.js";

export type DispatcherErrorCode =
  | "BROWSER_BUSY"
  | "LOGIN_REQUIRED"
  | "PROTOCOL_MISMATCH"
  | "TIMEOUT"
  | "INTERNAL";

// Carries a machine-readable code so index.ts can map BROWSER_BUSY / LOGIN_REQUIRED
// to a clean FastMCP UserError and surface everything else as a generic failure.
export class DispatcherError extends Error {
  code: DispatcherErrorCode;
  constructor(code: DispatcherErrorCode, message: string) {
    super(message);
    this.name = "DispatcherError";
    this.code = code;
  }
}

// Transport-agnostic surface shared by the legacy (in-process) and daemon
// (over-socket) implementations. index.ts wires whichever one the mode selects.
export interface Dispatcher {
  search(query: string): Promise<SearchResult>;
  searchAdvanced(query: string, sources: string[]): Promise<SearchResult>;
  searchDeep(query: string): Promise<SearchResult>;
  login(): Promise<string>;
}

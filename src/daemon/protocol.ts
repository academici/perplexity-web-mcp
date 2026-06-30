import type { SearchResult } from "../search.js";

// Bumped whenever the wire format changes incompatibly. A client refuses to talk
// to a daemon whose hello.v differs (and vice-versa) instead of misbehaving.
export const PROTOCOL_VERSION = 1;

export type Method = "search" | "search_advanced" | "search_deep" | "login" | "ping";

export type ErrorCode =
  | "BROWSER_BUSY"
  | "LOGIN_REQUIRED"
  | "PROTOCOL_MISMATCH"
  | "TIMEOUT"
  | "INTERNAL";

// client -> daemon
export interface RpcRequest {
  v: number;
  id: string;
  method: Method;
  params: { query?: string; sources?: string[] };
}

// daemon -> client
export interface RpcHello { type: "hello"; v: number; pool: string; pid: number }
export interface RpcAccepted { type: "accepted"; id: string; tabIndex: number }
export interface RpcProgress { type: "progress"; id: string; note?: string }
export interface RpcResult { type: "result"; id: string; result: SearchResult | { message: string } }
export interface RpcError { type: "error"; id: string; code: ErrorCode; message: string }
export interface RpcPong { type: "pong" }

export type ServerMessage = RpcHello | RpcAccepted | RpcProgress | RpcResult | RpcError | RpcPong;
export type ClientMessage = RpcRequest;

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg) + "\n";
}

// Buffered newline-delimited JSON decoder. Feed raw socket chunks (which may
// split or coalesce messages); get back the complete objects parsed so far.
export class NdjsonDecoder {
  private buf = "";

  push(chunk: string | Buffer): unknown[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() === "") continue;
      out.push(JSON.parse(line));
    }
    return out;
  }
}

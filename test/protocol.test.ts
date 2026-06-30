import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encode,
  NdjsonDecoder,
  PROTOCOL_VERSION,
  type RpcRequest,
  type RpcResult,
} from "../src/daemon/protocol.ts";

test("PROTOCOL_VERSION is a positive integer", () => {
  assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION >= 1);
});

test("encode appends exactly one newline and round-trips", () => {
  const req: RpcRequest = { v: 1, id: "abc", method: "search", params: { query: "hi" } };
  const wire = encode(req);
  assert.ok(wire.endsWith("\n"));
  assert.equal(wire.indexOf("\n"), wire.length - 1);
  const dec = new NdjsonDecoder();
  const [out] = dec.push(wire);
  assert.deepEqual(out, req);
});

test("decoder buffers a frame split across chunks", () => {
  const dec = new NdjsonDecoder();
  const wire = encode({ type: "pong" });
  const mid = Math.floor(wire.length / 2);
  assert.deepEqual(dec.push(wire.slice(0, mid)), []); // incomplete -> nothing yet
  const out = dec.push(wire.slice(mid));
  assert.deepEqual(out, [{ type: "pong" }]);
});

test("decoder splits multiple frames coalesced in one chunk", () => {
  const dec = new NdjsonDecoder();
  const a: RpcResult = { type: "result", id: "1", result: { message: "ok" } };
  const b = { type: "pong" } as const;
  const out = dec.push(encode(a) + encode(b));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);
});

test("decoder ignores blank lines and keeps a trailing partial", () => {
  const dec = new NdjsonDecoder();
  const out = dec.push('\n' + encode({ type: "pong" }) + '{"type":"po');
  assert.deepEqual(out, [{ type: "pong" }]);
  // the partial completes on the next push
  const out2 = dec.push('ng"}\n');
  assert.deepEqual(out2, [{ type: "pong" }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createDaemonDispatcher, DaemonUnavailableError } from "../src/daemon/client.ts";
import { DispatcherError } from "../src/dispatcher.ts";
import { encode, NdjsonDecoder, type RpcRequest, type ServerMessage } from "../src/daemon/protocol.ts";
import type { ResolvedPool } from "../src/pool.ts";

function poolFor(socketPath: string): ResolvedPool {
  return {
    name: "test",
    socketPath,
    profileDir: "/tmp/none",
    logPath: "/tmp/none.log",
    maxConcurrency: 3,
    idleShutdownMs: 1000,
    saturation: { mode: "queue", waitMs: 0 },
    searchTimeoutMs: 5000,
    deepTimeoutMs: 5000,
  };
}

// Stub daemon: sends hello, then for each request invokes `reply` to produce
// server messages. Returns the started server + its socket path.
async function startStub(
  helloV: number,
  reply: (req: RpcRequest) => ServerMessage[],
): Promise<{ server: net.Server; socketPath: string; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pplx-client-"));
  const socketPath = path.join(dir, "d.sock");
  const server = net.createServer((socket) => {
    const decoder = new NdjsonDecoder();
    socket.write(encode({ type: "hello", v: helloV, pool: "test", pid: 0 }));
    socket.on("data", (chunk) => {
      for (const m of decoder.push(chunk)) {
        const req = m as RpcRequest;
        if (req.method === "ping") { socket.write(encode({ type: "pong" })); continue; }
        for (const msg of reply(req)) socket.write(encode(msg));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((res) => server.listen(socketPath, res));
  return { server, socketPath, dir };
}

test("daemon client: happy-path search returns the SearchResult", async () => {
  const stub = await startStub(1, (req) => [
    { type: "accepted", id: req.id, tabIndex: 0 },
    { type: "result", id: req.id, result: { answer: "hello world", sources: [{ title: "T", url: "https://x" }] } },
  ]);
  try {
    const d = createDaemonDispatcher(poolFor(stub.socketPath), "node", []);
    const r = await d.search("q");
    assert.equal(r.answer, "hello world");
    assert.equal(r.sources[0].url, "https://x");
  } finally {
    stub.server.close();
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("daemon client: login returns the message string", async () => {
  const stub = await startStub(1, (req) => [
    { type: "result", id: req.id, result: { message: "Already authenticated on Perplexity.ai." } },
  ]);
  try {
    const d = createDaemonDispatcher(poolFor(stub.socketPath), "node", []);
    const msg = await d.login();
    assert.match(msg, /Already authenticated/);
  } finally {
    stub.server.close();
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("daemon client: server error maps to a DispatcherError with its code", async () => {
  const stub = await startStub(1, (req) => [
    { type: "error", id: req.id, code: "BROWSER_BUSY", message: "all tabs busy" },
  ]);
  try {
    const d = createDaemonDispatcher(poolFor(stub.socketPath), "node", []);
    await assert.rejects(
      () => d.search("q"),
      (e: unknown) => e instanceof DispatcherError && e.code === "BROWSER_BUSY",
    );
  } finally {
    stub.server.close();
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("daemon client: protocol version mismatch rejects (and does NOT fall back)", async () => {
  const stub = await startStub(999, () => []);
  try {
    const d = createDaemonDispatcher(poolFor(stub.socketPath), "node", []);
    await assert.rejects(
      () => d.search("q"),
      (e: unknown) =>
        e instanceof DispatcherError &&
        e.code === "PROTOCOL_MISMATCH" &&
        !(e instanceof DaemonUnavailableError),
    );
  } finally {
    stub.server.close();
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("daemon client: a daemon that closes before replying surfaces INTERNAL", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pplx-drop-"));
  const socketPath = path.join(dir, "d.sock");
  const server = net.createServer((socket) => {
    socket.write(encode({ type: "hello", v: 1, pool: "test", pid: 0 }));
    socket.on("data", () => socket.destroy()); // accept the request, then drop
    socket.on("error", () => {});
  });
  await new Promise<void>((res) => server.listen(socketPath, res));
  try {
    const d = createDaemonDispatcher(poolFor(socketPath), "node", []);
    await assert.rejects(
      () => d.search("q"),
      (e: unknown) => e instanceof DispatcherError && e.code === "INTERNAL",
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

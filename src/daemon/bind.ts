import net from "net";
import { unlinkSync } from "fs";

// Probe whether a live server is accepting connections on socketPath.
export function probeAlive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(alive);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    const t = setTimeout(() => finish(false), timeoutMs);
    t.unref?.();
  });
}

function listenOnce(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => { server.removeListener("listening", onOk); reject(e); };
    const onOk = () => { server.removeListener("error", onErr); resolve(); };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen(socketPath);
  });
}

// Become the single owner of socketPath, or return null if a live daemon already
// owns it (the caller should then exit). A socket file left by a crashed daemon
// is detected (connect refused) and removed before retrying.
export async function acquireSocket(server: net.Server, socketPath: string): Promise<net.Server | null> {
  try {
    await listenOnce(server, socketPath);
    return server;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    if (await probeAlive(socketPath)) return null; // a live peer owns it — we lose the race
    try { unlinkSync(socketPath); } catch {} // stale socket from a crashed daemon
    await listenOnce(server, socketPath); // retry once; throws if it still fails
    return server;
  }
}

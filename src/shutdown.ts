import { connect } from "node:net";
import { authEnvelope, pingDaemon, readAuthToken, type DaemonPaths } from "./vendor-runtime.js";

export async function shutdownDaemon(paths: DaemonPaths): Promise<boolean> {
  const token = readAuthToken(paths);
  const owner = token ? await pingDaemon(paths, token) : null;
  if (!token || !owner) return false;
  await new Promise<void>((resolve, reject) => {
    const socket = connect(paths.socket);
    const timer = setTimeout(() => socket.destroy(new Error("Daemon shutdown timed out")), 5000);
    let text = "";
    socket.on("connect", () => socket.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "opencode/shutdown", params: { _omo: authEnvelope(token) },
    }) + "\n"));
    socket.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      try {
        const reply: { result?: { stopped?: boolean }; error?: unknown } = JSON.parse(text.trim());
        if (!reply.result?.stopped) reject(new Error("Daemon refused authenticated shutdown"));
        else resolve();
      } catch (error) { reject(error); }
    });
  });
  const deadline = Date.now() + 10000;
  while (isAlive(owner.pid)) {
    if (Date.now() >= deadline) throw new Error("Daemon accepted shutdown but has not finished cleanup.");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
    }
    throw error;
  }
}

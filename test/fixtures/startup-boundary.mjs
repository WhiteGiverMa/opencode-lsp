import { registerHooks } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";

const runtime = new URL("../../dist/vendor-runtime.js", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    return url === runtime
      ? { ...result, source: String(result.source) + "\nexport { JsonRpcConnection, LspClientTransport };\n" }
      : result;
  },
});
const { JsonRpcConnection, LspClientTransport } = await import(runtime);
const mode = process.argv[2];
const root = process.argv[3];
const events = [];
process.on("unhandledRejection", (error) => events.push(`unhandledRejection: ${String(error)}`));
process.on("uncaughtException", (error) => events.push(`uncaughtException: ${String(error)}`));

function frame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

if (mode === "remote-error") {
  const reader = new PassThrough();
  const writer = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const transport = new LspClientTransport(root, { id: "healthy", command: ["node"], extensions: [] });
  transport.proc = { exitCode: null, exited: new Promise(() => {}) };
  transport.connection = new JsonRpcConnection(reader, writer);
  transport.connection.listen();
  const pending = transport.sendRequest("probe", {});
  reader.write(frame({ jsonrpc: "2.0", id: 1, error: {
    code: -32603, message: "Upstream socket write EPIPE; server remains healthy",
  } }));
  let result;
  try {
    await pending;
    result = { unexpectedSuccess: true };
  } catch (error) {
    result = { name: error.name, message: error.message, alive: transport.isAlive() };
  }
  transport.connection.dispose();
  reader.destroy();
  writer.destroy();
  await pause(0);
  console.log(JSON.stringify({ ...result, events }));
} else if (mode === "close-write") {
  const transport = new LspClientTransport(root, {
    id: "closing-writer", extensions: [],
    command: [process.execPath, "-e", 'process.stderr.write("fixture closed stdout while still running\\n"); process.stdout.end(); setTimeout(() => process.exit(127), 600);'],
  }, { requestTimeoutMs: 100 });
  await transport.start();
  const proc = transport.proc;
  const connection = transport.connection;
  const closed = new Promise((resolve) => connection.onClose(resolve));
  let settled = false;
  let outcome;
  const pending = transport.sendRequest("initialize", {
    initializationOptions: { payload: "x".repeat(2 * 1024 * 1024) },
  }).then(
    () => { settled = true; outcome = { unexpectedSuccess: true }; },
    (error) => { settled = true; outcome = { name: error.name, message: error.message }; },
  );
  await closed;
  await pause(250);
  const settledAfterClose = settled;
  await proc.exited;
  await pending;
  await transport.stop();
  await pause(0);
  console.log(JSON.stringify({ settledAfterClose, outcome, events, writerErrorListeners: proc.stdin.listenerCount("error") }));
} else {
  throw new Error(`Unknown startup boundary mode: ${mode}`);
}

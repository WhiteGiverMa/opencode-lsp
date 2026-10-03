import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const documents = new Map();
const empty = new Map();
const mode = process.env.LSP_TS_REPLY_MODE ?? "normal";
const delay = Number(process.env.LSP_TS_DELAY_MS ?? 50);
const events = process.env.LSP_FIXTURE_EVENT_LOG;
if (process.env.LSP_FIXTURE_SPAWN_LOG) appendFileSync(process.env.LSP_FIXTURE_SPAWN_LOG, `${process.pid}\n`);
const log = value => { if (events) appendFileSync(events, `${value}\n`); };
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
function publish(uri, text, first) {
  const clean = !text.includes("ERROR");
  if (first || !clean || !empty.get(uri)) {
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
    log(`publish:${uri}`);
  }
  empty.set(uri, clean);
}
function handle({ id, method, params = {} }) {
  log(`in:${method}`);
  if (method === "initialize") {
    reply(id, { capabilities: { textDocumentSync: 1, documentSymbolProvider: true,
      executeCommandProvider: { commands: ["typescript.tsserverRequest"] } } });
  } else if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
    const { uri } = params.textDocument;
    const text = method === "textDocument/didOpen" ? params.textDocument.text : params.contentChanges.at(-1).text;
    documents.set(fileURLToPath(uri), text);
    publish(uri, text, method === "textDocument/didOpen");
  } else if (method === "textDocument/didClose") {
    documents.delete(fileURLToPath(params.textDocument.uri));
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
  } else if (method === "workspace/executeCommand") {
    const [command, args, options] = params.arguments;
    log(`command:${command}`);
    if (args.includeLinePosition !== true || options.executionTarget !== 0 || options.expectsResult !== true) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing semantic request options" } });
      return;
    }
    if (mode === "silent") return;
    const text = documents.get(args.file) ?? "";
    const diagnostics = command === "semanticDiagnosticsSync" && text.includes("ERROR") ? [{
      message: "Type 'string' is not assignable to type 'number'.", category: "error", code: 2322,
      start: 0, length: 5, startLocation: { line: 1, offset: 1 }, endLocation: { line: 1, offset: 6 }
    }] : [];
    setTimeout(() => {
      const result = mode === "malformed" ? { type: "response", success: true, body: {} }
        : mode === "no-server" ? { type: "noServer" }
        : { type: "response", success: true, command, body: diagnostics };
      reply(id, result);
      log(`reply:${command}`);
    }, delay);
  } else if (method === "textDocument/documentSymbol") {
    reply(id, []);
  } else if (method === "shutdown") {
    reply(id, null);
  } else if (method === "exit") {
    process.exit(0);
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported fixture method" } });
  }
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, boundary).toString());
    if (!match) throw new Error("Invalid fixture frame");
    const end = boundary + 4 + Number(match[1]);
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(boundary + 4, end).toString());
    buffer = buffer.subarray(end);
    handle(message);
  }
});

import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { encodeFrame, LspFrameReader } from "../src/lsp-framing";
import { cleanupAllSandboxes, newSandbox, startSession, writeProjectFile } from "./mcp-client";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await cleanupAllSandboxes(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function editor(label: string) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    let root = "";
    const reader = new LspFrameReader(message => {
      const params = message.params as { rootUri?: string; textDocument?: { uri: string; version: number } } | undefined;
      if (message.method === "initialize") {
        root = params?.rootUri ?? "";
        socket.write(encodeFrame({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 1 } } }));
      } else if (message.method === "textDocument/didOpen") {
        socket.write(encodeFrame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
          uri: params?.textDocument?.uri, version: params?.textDocument?.version,
          diagnostics: [{ severity: 1, message: `${label}:${root}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
        } }));
      } else if (message.id !== undefined) {
        socket.write(encodeFrame({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } }));
      }
    }, error => { throw error; });
    socket.on("data", chunk => reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

test("warm clients with different Godot ports reach their own editors", async () => {
  const firstPort = await editor("editor-A");
  const secondPort = await editor("editor-B");
  const sandbox = await newSandbox();
  await writeProjectFile(sandbox, "project.godot", "config_version=5\n");
  const file = await writeProjectFile(sandbox, "main.gd", "extends Node\n");
  const first = await startSession(sandbox, { env: { OPENCODE_LSP_GODOT_PORT: String(firstPort) } });
  expect(first.client.resultText(await first.client.call("diagnostics", { filePath: file }))).toContain("editor-A:");
  const second = await startSession(sandbox, { env: { OPENCODE_LSP_GODOT_PORT: String(secondPort) } });
  expect(second.client.resultText(await second.client.call("diagnostics", { filePath: file }))).toContain("editor-B:");
  await Promise.all([first.client.close(), second.client.close()]);
});

test("warm clients with different Godot URI mappings initialize the intended project", async () => {
  const port = await editor("editor");
  const sandbox = await newSandbox();
  await writeProjectFile(sandbox, "project.godot", "config_version=5\n");
  const file = await writeProjectFile(sandbox, "main.gd", "extends Node\n");
  const first = await startSession(sandbox, { env: { OPENCODE_LSP_GODOT_PORT: String(port), OPENCODE_LSP_GODOT_PROJECT_URI: "file:///G:/project-A" } });
  expect(first.client.resultText(await first.client.call("diagnostics", { filePath: file }))).toContain("file:///G:/project-A");
  const second = await startSession(sandbox, { env: { OPENCODE_LSP_GODOT_PORT: String(port), OPENCODE_LSP_GODOT_PROJECT_URI: "file:///G:/project-B" } });
  expect(second.client.resultText(await second.client.call("diagnostics", { filePath: file }))).toContain("file:///G:/project-B");
  await Promise.all([first.client.close(), second.client.close()]);
});

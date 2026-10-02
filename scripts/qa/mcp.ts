import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type McpToolResult } from "../../test/mcp-client";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = resolve(process.env.LSP_QA_ENTRY ?? join(repo, "bin/opencode-lsp.js"));
const node = process.env.LSP_QA_NODE ?? "node";
const evidence = resolve(process.env.LSP_QA_EVIDENCE ?? join(repo, ".omo/evidence/20261002-feature09"));
const root = await mkdtemp(join(tmpdir(), "opencode-lsp-real-"));
const home = join(root, "home");
const project = join(root, "project");
await Promise.all([mkdir(home), mkdir(project), mkdir(evidence, { recursive: true })]);
const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_LSP_HOME: home };
const a = join(project, "a.ts");
const b = join(project, "b.ts");
await writeFile(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }));
await writeFile(join(project, "package.json"), '{"private":true}');
await writeFile(a, 'export const counter: number = "wrong";\nexport function increment(value: number) { return value + 1; }\n');
await writeFile(b, 'import { counter, increment } from "./a";\nconsole.log(increment(counter));\n');
const calls: Record<string, McpToolResult> = {};
const child = spawn(node, [entry, "mcp"], { cwd: project, env, stdio: "pipe" });
const client = connect(child);
let cleanup = "not run";
let succeeded = false;
try {
  await client.initialize();
  const names = (await client.listTools()).map(tool => tool.name);
  assert.deepEqual(names, ["status", "diagnostics", "goto_definition", "find_references", "symbols", "prepare_rename", "rename"]);
  const call = async (key: string, tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.call(tool, args); calls[key] = result;
    assert.notEqual(result.isError, true, `${tool}: ${client.resultText(result)}`);
    return client.resultText(result);
  };
  assert.match(await call("cold-status", "status"), /Active LSP clients: 0/);
  assert.match(await call("error", "diagnostics", { filePath: a, severity: "error" }), /2322|not assignable/);
  assert.match(await call("definition", "goto_definition", { filePath: b, line: 2, character: 23 }), /a\.ts/);
  assert.match(await call("references", "find_references", { filePath: a, line: 1, character: 14 }), /b\.ts/);
  assert.match(await call("symbols", "symbols", { filePath: a, scope: "document" }), /counter|increment/);
  await call("prepare", "prepare_rename", { filePath: a, line: 1, character: 14 });
  await call("rename", "rename", { filePath: a, line: 1, character: 14, newName: "total" });
  assert.match(await readFile(a, "utf8"), /export const total/);
  assert.match(await readFile(b, "utf8"), /increment\(total\)/);
  await writeFile(a, 'export const total: number = 42;\nexport function increment(value: number) { return value + 1; }\n');
  assert.match(await call("fresh-clean", "diagnostics", { filePath: a, severity: "error" }), /No diagnostics found/);
  assert.match(await call("warm-status", "status"), /Active LSP clients: 1/);
  succeeded = true;
} finally {
  await client.close();
  cleanup = execFileSync(node, [entry, "shutdown"], { cwd: project, env, encoding: "utf8" }).trim();
  await writeFile(join(evidence, "real-typescript.json"), JSON.stringify({ succeeded, entry, nodeVersion: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(), root, calls, cleanup, proxyExited: child.exitCode !== null || child.signalCode !== null }, null, 2));
}
console.log(`Real TypeScript MCP QA passed; ${cleanup}; evidence ${evidence}`);

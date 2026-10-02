import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(process.argv[2]);
const reportFile = process.argv[3];
const root = mkdtempSync(join(tmpdir(), "opencode-lsp-packed-"));
const home = join(root, "home"); mkdirSync(home);
const project = join(root, "project"); mkdirSync(project);
const env = { ...process.env, OPENCODE_LSP_HOME: home, HOME: home, USERPROFILE: home };
const missing = "standalone-lsp-intentionally-not-installed";
writeFileSync(join(home, "lsp.json"), JSON.stringify({ lsp: { missing: { command: [missing], extensions: [".missing"] } } }));
writeFileSync(join(project, "probe.missing"), "probe\n");
const child = spawn(process.execPath, [entry, "mcp"], { cwd: project, env, stdio: "pipe" });
let buffer = ""; let nextId = 0; let errors = "";
const pending = new Map();
child.stderr.on("data", chunk => { errors += chunk.toString(); });
child.stdout.on("data", chunk => {
  buffer += chunk.toString();
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line); const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); clearTimeout(waiter.timer); waiter.resolve(response); }
  }
});
function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out: ${errors}`)), 20000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const text = response => response.result.content.map(item => item.text ?? "").join("\n");
const call = (name, args = {}) => request("tools/call", { name, arguments: args });
const report = { entry, node: process.version, platform: process.platform, root, passed: false };
try {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "packed-smoke", version: "1" } });
  assert.equal(init.result.serverInfo.name, "lsp");
  const list = await request("tools/list");
  report.tools = list.result.tools.map(tool => tool.name);
  assert.equal(report.tools.length, 7);
  assert(!report.tools.includes("install_decision"));
  assert.match(text(await call("status")), /Active LSP clients: 0/);
  assert.match(text(await call("diagnostics", { filePath: join(project, "probe.missing") })), /ASK THE USER/);
  assert(!existsSync(join(home, "refusals.json")));
  writeFileSync(join(home, "refusals.json"), '{"declined_servers":["missing"]}');
  assert.match(text(await call("diagnostics", { filePath: join(project, "probe.missing") })), /previously declined/);
  const removed = await call("lsp_install_decision", { server_id: "missing", decision: "allowed" });
  assert.equal(removed.result.isError, true);
  assert.equal(readFileSync(join(home, "refusals.json"), "utf8"), '{"declined_servers":["missing"]}');
  report.passed = true;
} finally {
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.stdin.end(); await exited;
  const run = spawnSync(process.execPath, [entry, "shutdown"], { cwd: project, env, encoding: "utf8", timeout: 20000 });
  report.shutdown = { status: run.status, stdout: run.stdout, stderr: run.stderr };
  assert.equal(run.status, 0);
  report.remainingOwnedPidFiles = readdirSync(join(home, "daemon"), { recursive: true }).filter(path => path.endsWith("daemon.pid"));
  assert.equal(report.remainingOwnedPidFiles.length, 0);
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

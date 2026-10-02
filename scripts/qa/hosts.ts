import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment } from "./host-env";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entry = resolve(process.env.LSP_QA_ENTRY ?? join(repo, "bin/opencode-lsp.js"));
const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
const evidence = resolve(process.env.LSP_QA_EVIDENCE ?? join(repo, ".omo/evidence/20261002-feature09"));
const binaries = {
  v2: process.env.OPENCODE_V2_BIN ?? join(homedir(), ".local/opt/opencode-v2/2.0.21/node_modules/.bin/opencode2"),
  v1: process.env.OPENCODE_V1_BIN ?? join(homedir(), ".opencode/bin/opencode"),
};
await mkdir(evidence, { recursive: true });
const hostDb = join(homedir(), ".local/share/opencode/opencode.db");
function realCount() { return existsSync(hostDb) ? execFileSync("sqlite3", ["-readonly", hostDb, "SELECT count(*) FROM session"], { encoding: "utf8" }).trim() : "absent"; }
const before = realCount();
const reports: unknown[] = [];
try {
  for (const version of ["v2", "v1"] as const) {
    reports.push(await drive(version, false));
    reports.push(await drive(version, true));
  }
} finally {
  const after = realCount();
  await writeFile(join(evidence, "bare-hosts.json"), JSON.stringify({ before, after, hostCountUnchanged: before === after, reports,
    nativeExecution: "Not invoked: pinned host APIs provide MCP management, not sessionless tool execution. Standalone MCP behavior is proven separately. No coding sessions created." }, null, 2));
  assert.equal(after, before, "Host session count changed during sessionless QA");
}
console.log(`Bare v2/v1 MCP host checks passed (${reports.length} runs); host sessions ${before} -> ${realCount()}`);

async function drive(version: "v1" | "v2", disabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), `opencode-lsp-${version}-`));
  const env = isolatedEnvironment(root);
  env.OPENCODE_SERVER_PASSWORD = randomBytes(24).toString("hex");
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` };
  const project = join(root, "project");
  await Promise.all([project, ...Object.entries(env).filter(([key]) => key === "HOME" || key.startsWith("XDG_") || key === "OPENCODE_CONFIG_DIR" || key === "OPENCODE_LSP_HOME").map(([,path]) => path)].map(path => mkdir(path, { recursive: true })));
  const log = join(root, "mcp-wire.jsonl");
  const command = [node, join(repo, "scripts/qa/record-mcp.mjs"), entry, log];
  const config = JSON.parse(execFileSync(node, [entry, "config", version], { env, encoding: "utf8" }));
  if (version === "v2") { config.plugins = []; config.mcp.servers.lsp.command = command; config.mcp.servers.lsp.disabled = disabled; }
  else { config.plugin = []; config.mcp.lsp.command = command; config.mcp.lsp.enabled = !disabled; }
  await writeFile(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(config));
  const actualVersion = execFileSync(binaries[version], ["--version"], { cwd: project, env, encoding: "utf8", timeout: 30000 }).trim();
  const port = await freePort();
  const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
  const child = spawn(binaries[version], args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk.toString(); });
  child.stderr.on("data", chunk => { logs += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const query = version === "v2" ? `?location%5Bdirectory%5D=${encodeURIComponent(project)}` : `?directory=${encodeURIComponent(project)}`;
  const prefix = version === "v2" ? "/api" : "";
  const api = async (path: string, method = "GET") => {
    const response = await fetch(`${base}${path}${query}`, { method, headers, signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    if (!response.ok) throw new Error(`${version} ${method} ${path}: ${response.status} ${body}`);
    return body ? JSON.parse(body) : null;
  };
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Host exited early: ${sanitize(logs)}`);
      try { return (await fetch(`${base}${version === "v2" ? "/api/info" : "/global/health"}`, { headers, signal: AbortSignal.timeout(2000) })).ok; }
      catch { return false; }
    }, 60000);
    let status: unknown;
    await until(async () => { status = await api(`${prefix}/mcp`); return state(status, version) === (disabled ? "disabled" : "connected"); }, 60000);
    const sessions = await api(`${prefix}/session`);
    assert.equal(sessionCount(sessions), 0, "Bare host acquired a coding session");
    const skills = await api(`${prefix}/skill`);
    assert.match(JSON.stringify(skills), /lsp-setup/, "Bundled setup skill was not discovered by the host");
    let disconnected: unknown;
    let reconnected: unknown;
    if (!disabled) {
      const control = version === "v2" ? "/api/experimental/mcp/lsp" : "/mcp/lsp";
      await api(`${control}/disconnect`, "POST");
      disconnected = await api(`${prefix}/mcp`);
      assert.notEqual(state(disconnected, version), "connected");
      await api(`${control}/connect`, "POST");
      await until(async () => { reconnected = await api(`${prefix}/mcp`); return state(reconnected, version) === "connected"; }, 30000);
    }
    const wire = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const catalogs = wire.filter(row => row.direction === "mcp-to-host" && row.wire.result?.tools).map(row => row.wire.result.tools.map((tool: { name: string }) => tool.name));
    if (disabled) assert.equal(wire.length, 0, "Disabled host spawned the MCP");
    else assert.deepEqual(catalogs[0], ["status", "diagnostics", "goto_definition", "find_references", "symbols", "prepare_rename", "rename"]);
    return { version: actualVersion, disabled, root, status, disconnected, reconnected, sessions, catalogs, setupSkillDiscovered: true, noCodingSessionCreated: true };
  } catch (error) {
    await writeFile(join(evidence, `${version}-${disabled ? "disabled" : "enabled"}-failure.log`), sanitize(logs + "\n" + String(error)));
    throw error;
  } finally {
    await stop(child);
    await writeFile(join(evidence, `${version}-${disabled ? "disabled" : "enabled"}-host.log`), sanitize(logs));
    execFileSync(node, [entry, "shutdown"], { cwd: project, env, encoding: "utf8", timeout: 15000 });
  }
}

function state(value: unknown, version: "v1" | "v2"): string | undefined {
  if (!value || typeof value !== "object") return;
  if (version === "v1") {
    const lsp = Reflect.get(value, "lsp");
    return lsp && typeof lsp === "object" ? Reflect.get(lsp, "status") : undefined;
  }
  const data = Reflect.get(value, "data");
  if (!Array.isArray(data)) return;
  return data.find(server => server.name === "lsp")?.status?.status;
}
function sessionCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    for (const key of ["data", "items", "sessions"]) { const data = Reflect.get(value, key); if (Array.isArray(data)) return data.length; }
  }
  throw new Error(`Unrecognized session-list shape: ${JSON.stringify(value)}`);
}
function sanitize(text: string): string { return text.replace(/server password [^\r\n]+/g, "server password [redacted sandbox credential]"); }
async function until(check: () => Promise<boolean>, timeout: number) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Host readiness/status timed out"); await new Promise(resolve => setTimeout(resolve, 250)); }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await until(async () => child.exitCode !== null || child.signalCode !== null, 10000).catch(() => child.kill("SIGKILL"));
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("No TCP address")); server.close(error => error ? reject(error) : resolve(address.port)); }); });
}

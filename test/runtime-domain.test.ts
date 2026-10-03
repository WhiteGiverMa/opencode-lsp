import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupAllSandboxes, newSandbox, writeJsonFile } from "./mcp-client";

afterEach(cleanupAllSandboxes);
test("runtime version and fingerprint separate domains for the same config and user", async () => {
  const sandbox = await newSandbox();
  const modulePath = join(sandbox.root, "config.ts");
  const source = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
  await writeFile(modulePath, source);
  const manifest = join(sandbox.root, "runtime-manifest.json");
  await writeJsonFile(manifest, { version: "0.1.0", fingerprint: "1111111111111111" });
  const config: typeof import("../src/config") = await import(pathToFileURL(modulePath).href);
  const environment = () => ({ OPENCODE_LSP_HOME: sandbox.home, PATH: process.env.PATH });
  const first = config.configureRuntime(environment(), sandbox.project).runtimeEnv;
  await writeJsonFile(manifest, { version: "0.1.0", fingerprint: "2222222222222222" });
  const second = config.configureRuntime(environment(), sandbox.project).runtimeEnv;
  await writeJsonFile(manifest, { version: "0.2.0", fingerprint: "2222222222222222" });
  const third = config.configureRuntime(environment(), sandbox.project).runtimeEnv;
  expect(first.LSP_TOOLS_MCP_USER_CONFIG).toBe(second.LSP_TOOLS_MCP_USER_CONFIG);
  expect(first.OPENCODE_LSP_DAEMON_DIR).not.toBe(second.OPENCODE_LSP_DAEMON_DIR);
  expect(second.OPENCODE_LSP_DAEMON_DIR).not.toBe(third.OPENCODE_LSP_DAEMON_DIR);
});

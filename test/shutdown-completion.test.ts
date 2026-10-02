import { afterEach, expect, test } from "bun:test";
import { cleanupAllSandboxes, isAlive, mockServer, newSandbox, readSpawnedPids, shutdownCli, startSession, waitForDaemonPids, writeProjectFile, writeUserConfig, writeWorkspaceMarker } from "./mcp-client";

afterEach(cleanupAllSandboxes);

test("shutdown CLI waits for daemon and delayed language-server cleanup before reporting success", async () => {
  const sandbox = await newSandbox();
  await writeWorkspaceMarker(sandbox);
  await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox, { env: { LSP_FIXTURE_SHUTDOWN_DELAY_MS: "400" } }) } });
  const file = await writeProjectFile(sandbox, "shutdown.testlang", "ERROR_MARKER\n");
  const { client } = await startSession(sandbox);
  await client.call("diagnostics", { filePath: file });
  const pids = [...await waitForDaemonPids(sandbox), ...await readSpawnedPids(sandbox)];
  expect(pids.length).toBeGreaterThanOrEqual(2);
  await client.close();
  const result = await shutdownCli(sandbox);
  expect(result.code).toBe(0);
  expect(pids.every(pid => !isAlive(pid))).toBe(true);
});

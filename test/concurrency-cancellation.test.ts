import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { cleanupAllSandboxes, mockServer, newSandbox, readEvents, readSpawnedPids, startSession, waitingFor, writeProjectFile, writeUserConfig, writeWorkspaceMarker } from "./mcp-client";

afterEach(cleanupAllSandboxes);

async function setup(stale = false) {
  const sandbox = await newSandbox();
  await writeWorkspaceMarker(sandbox);
  await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox, { env: stale ? { LSP_FIXTURE_STALE_PUSH: "1" } : {} }) } });
  const file = await writeProjectFile(sandbox, "main.testlang", "def alpha\nalpha\n");
  return { sandbox, file };
}

test("two simultaneous proxies share a client; one closing cannot stop the other", async () => {
  const { sandbox, file } = await setup();
  const first = await startSession(sandbox);
  const second = await startSession(sandbox);
  const results = await Promise.all([first.client.call("diagnostics", { filePath: file }), second.client.call("diagnostics", { filePath: file })]);
  expect(results.every(result => result.isError !== true)).toBe(true);
  expect(await readSpawnedPids(sandbox)).toHaveLength(1);
  await first.client.close();
  expect((await second.client.call("symbols", { filePath: file, scope: "document" })).isError).not.toBe(true);
  expect(await readSpawnedPids(sandbox)).toHaveLength(1);
  await second.client.close();
});

test("disconnect cancels a pending rename before a delayed edit can land", async () => {
  const { sandbox, file } = await setup();
  const { client } = await startSession(sandbox);
  await client.call("diagnostics", { filePath: file });
  const pending = client.call("rename", { filePath: file, line: 2, character: 1, newName: "OVERRIDE_DELAYED" }).catch(() => null);
  expect(await waitingFor(async () => (await readEvents(sandbox)).includes("rename-pending"), 5000)).toBe(true);
  await client.close();
  await pending;
  expect(await waitingFor(async () => (await readEvents(sandbox)).includes("in:$/cancelRequest"), 5000)).toBe(true);
  expect(await waitingFor(async () => (await readEvents(sandbox)).includes("rename-delayed-response"), 5000)).toBe(true);
  expect(await readFile(file, "utf8")).toBe("def alpha\nalpha\n");
});

test("stale diagnostic versions never masquerade as a clean file", async () => {
  const { sandbox, file } = await setup(true);
  const { client } = await startSession(sandbox);
  const result = await client.call("diagnostics", { filePath: file });
  expect(client.resultText(result)).toMatch(/fresh|timed out|timeout/i);
  expect(client.resultText(result)).not.toBe("No diagnostics found");
  await client.close();
});

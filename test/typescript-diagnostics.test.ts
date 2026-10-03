import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { cleanupAllSandboxes, isRecord, mockServer, newSandbox, readEvents, startSession, waitingFor, writeProjectFile, writeUserConfig, writeWorkspaceMarker } from "./mcp-client";

afterEach(cleanupAllSandboxes);
const fixture = fileURLToPath(new URL("./fixtures/tsserver-language-server.mjs", import.meta.url));
async function setup(mode = "normal", delay = 50) {
  const sandbox = await newSandbox();
  await writeWorkspaceMarker(sandbox);
  await writeUserConfig(sandbox, { lsp: { tsprobe: mockServer(sandbox, {
    command: ["node", fixture], extensions: [".probe", ".ts"],
    env: { LSP_TS_REPLY_MODE: mode, LSP_TS_DELAY_MS: String(delay) }
  }) } });
  const file = await writeProjectFile(sandbox, "main.probe", "CLEAN\n");
  const session = await startSession(sandbox);
  return { sandbox, file, session };
}
test("deduplicated clean-to-clean publications do not prevent correlated diagnostics", async () => {
  const { sandbox, file, session } = await setup();
  expect(session.client.resultText(await session.client.call("diagnostics", { filePath: file }))).toBe("No diagnostics found");
  await writeProjectFile(sandbox, "main.probe", "STILL CLEAN\n");
  const second = await session.client.call("diagnostics", { filePath: file });
  expect(second.isError).not.toBe(true);
  expect(session.client.resultText(second)).toBe("No diagnostics found");
  expect((await readEvents(sandbox)).filter(event => event.startsWith("command:"))).toHaveLength(6);
  await session.client.close();
});
test("versionless clear pushes cannot hide a delayed semantic error", async () => {
  const { sandbox, file, session } = await setup("normal", 450);
  await writeProjectFile(sandbox, "main.probe", "ERROR\n");
  const result = await session.client.call("diagnostics", { filePath: file });
  expect(result.isError).not.toBe(true);
  expect(session.client.resultText(result)).toMatch(/2322/);
  const details = isRecord(result.details) ? result.details : {};
  expect(details.totalDiagnostics).toBe(1);
  await session.client.close();
});
for (const mode of ["malformed", "no-server"]) {
  test(`${mode} request replies cannot become clean success`, async () => {
    const { file, session } = await setup(mode);
    const result = await session.client.call("diagnostics", { filePath: file });
    expect(result.isError).toBe(true);
    expect(session.client.resultText(result)).not.toBe("No diagnostics found");
    await session.client.close();
  });
}
test("disk changes during a diagnostic transaction discard the earlier snapshot", async () => {
  const { sandbox, file, session } = await setup("normal", 300);
  const pending = session.client.call("diagnostics", { filePath: file });
  expect(await waitingFor(async () => (await readEvents(sandbox)).includes("command:semanticDiagnosticsSync"), 5000)).toBe(true);
  await writeProjectFile(sandbox, "main.probe", "ERROR\n");
  expect(session.client.resultText(await pending)).toMatch(/2322/);
  expect((await readEvents(sandbox)).filter(event => event === "command:semanticDiagnosticsSync")).toHaveLength(2);
  await session.client.close();
});
test("two proxies share one transaction and one closing cannot cancel the remaining waiter", async () => {
  const { sandbox, file, session } = await setup("normal", 400);
  const second = await startSession(sandbox);
  const firstPending = session.client.call("diagnostics", { filePath: file }).catch(() => null);
  const secondPending = second.client.call("diagnostics", { filePath: file });
  expect(await waitingFor(async () => (await readEvents(sandbox)).includes("command:semanticDiagnosticsSync"), 5000)).toBe(true);
  await session.client.close();
  await firstPending;
  expect(second.client.resultText(await secondPending)).toBe("No diagnostics found");
  expect((await readEvents(sandbox)).filter(event => event.startsWith("command:"))).toHaveLength(3);
  await second.client.close();
});
test("silent advertised diagnostics retain the deadline and expose directory failures", async () => {
  const { sandbox, file, session } = await setup("silent");
  const started = Date.now();
  const result = await session.client.call("diagnostics", { filePath: file });
  expect(session.client.resultText(result)).toMatch(/fresh|timed out|timeout/i);
  expect(session.client.resultText(result)).not.toBe("No diagnostics found");
  expect(Date.now() - started).toBeLessThan(6000);
  await writeProjectFile(sandbox, "src/timeout.ts", "CLEAN\n");
  const directory = await session.client.call("diagnostics", { filePath: `${sandbox.project}/src` });
  expect(session.client.resultText(directory)).toMatch(/processing errors|timed out|timeout/i);
  const details = isRecord(directory.details) ? directory.details : {};
  expect(Array.isArray(details.fileFailures) ? details.fileFailures.length : 0).toBeGreaterThan(0);
  await session.client.close();
});

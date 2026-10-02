// Lifecycle contract: one language-server process is reused across calls in a
// session, sandboxes get private daemons/state, the proxy exits on stdin close,
// and the owned-PID cleanup reaps daemons and language servers without leaks.

import { afterEach, describe, expect, it } from "bun:test";
import {
	cleanupAllSandboxes,
	cleanupSandbox,
	isAlive,
	mockServer,
	newSandbox,
	readSpawnedPids,
	shutdownCli,
	startSession,
	waitForDaemonPids,
	waitingFor,
	writeProjectFile,
	writeUserConfig,
	writeWorkspaceMarker,
} from "./mcp-client.ts";

afterEach(async () => {
	await cleanupAllSandboxes();
});

async function sandboxWithFile(contents = "ERROR_MARKER\n") {
	const sandbox = await newSandbox();
	await writeWorkspaceMarker(sandbox);
	await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
	const file = await writeProjectFile(sandbox, "src/life.testlang", contents);
	return { sandbox, file };
}

describe("lifecycle", () => {
	it("reuses a single language-server process across calls", async () => {
		const { sandbox, file } = await sandboxWithFile();
		const { client } = await startSession(sandbox);
		await client.call("diagnostics", { filePath: file });
		await client.call("diagnostics", { filePath: file });
		expect((await readSpawnedPids(sandbox)).length).toBe(1);
		await client.close();
	});

	it("isolates daemons and language servers per sandbox home", async () => {
		const first = await sandboxWithFile();
		const second = await sandboxWithFile();
		const firstSession = await startSession(first.sandbox);
		const secondSession = await startSession(second.sandbox);
		await firstSession.client.call("diagnostics", { filePath: first.file });
		await secondSession.client.call("diagnostics", { filePath: second.file });
		const firstPids = await readSpawnedPids(first.sandbox);
		const secondPids = await readSpawnedPids(second.sandbox);
		expect(firstPids.length).toBe(1);
		expect(secondPids.length).toBe(1);
		expect(firstPids[0]).not.toBe(secondPids[0]);
		await firstSession.client.close();
		await secondSession.client.close();
	});

	it("exits the proxy when stdin closes", async () => {
		const { sandbox, file } = await sandboxWithFile();
		const { client, child } = await startSession(sandbox);
		await client.call("diagnostics", { filePath: file });
		await client.close();
		const stopped = await waitingFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
		expect(stopped).toBe(true);
	});

	it("stops the owned daemon and its language server via CLI shutdown", async () => {
		const { sandbox, file } = await sandboxWithFile();
		const { client } = await startSession(sandbox);
		await client.call("diagnostics", { filePath: file });
		const daemons = await waitForDaemonPids(sandbox);
		const languages = await readSpawnedPids(sandbox);
		expect(daemons.length).toBeGreaterThan(0);
		await client.close();

		const run = await shutdownCli(sandbox);
		expect(run.code).toBe(0);
		expect(run.stdout).toMatch(/stopped/i);
		for (const pid of [...daemons, ...languages]) {
			expect(await waitingFor(() => !isAlive(pid), 5000)).toBe(true);
		}
	});

	it("reaps owned daemon and language-server processes during cleanup", async () => {
		const { sandbox, file } = await sandboxWithFile();
		const { client } = await startSession(sandbox);
		await client.call("diagnostics", { filePath: file });
		const daemons = await waitForDaemonPids(sandbox);
		expect(daemons.length).toBeGreaterThan(0);
		const owned = [...(await readSpawnedPids(sandbox)), ...daemons];
		expect(owned.length).toBeGreaterThanOrEqual(2);
		for (const pid of owned) expect(isAlive(pid)).toBe(true);
		await client.close();
		await cleanupSandbox(sandbox);
		for (const pid of owned) expect(isAlive(pid)).toBe(false);
	});
});

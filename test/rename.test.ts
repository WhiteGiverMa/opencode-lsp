// Rename contract: real workspace edits land on disk, while out-of-workspace
// and overlapping edits from the language server are rejected without touching
// any file.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
	cleanupAllSandboxes,
	isRecord,
	type McpToolResult,
	mockServer,
	newSandbox,
	startSession,
	writeProjectFile,
	writeUserConfig,
	writeWorkspaceMarker,
} from "./mcp-client.ts";

afterEach(async () => {
	await cleanupAllSandboxes();
});

function applyOf(result: McpToolResult): Record<string, unknown> {
	const details = isRecord(result.details) ? result.details : {};
	return isRecord(details["apply"]) ? details["apply"] : {};
}

async function sessionWithMock() {
	const sandbox = await newSandbox();
	await writeWorkspaceMarker(sandbox);
	await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
	const session = await startSession(sandbox);
	return { sandbox, session };
}

describe("rename", () => {
	it("applies a multi-file rename edit to disk", async () => {
		const { sandbox, session } = await sessionWithMock();
		const main = await writeProjectFile(sandbox, "src/main.testlang", "def alpha\nalpha\n");
		const other = await writeProjectFile(sandbox, "src/other.testlang", "def alpha_other\nalpha\n");

		const result = await session.client.call("rename", { filePath: main, line: 2, character: 3, newName: "beta" });
		expect(result.isError ?? false).toBe(false);
		const apply = applyOf(result);
		expect(apply["success"]).toBe(true);
		expect((apply["filesModified"] as unknown[]).length).toBe(2);
		expect(await readFile(main, "utf8")).toBe("def beta\nbeta\n");
		expect(await readFile(other, "utf8")).toBe("def alpha_other\nbeta\n");
		await session.client.close();
	});

	it("rejects an out-of-workspace edit and never writes the escaped path", async () => {
		const { sandbox, session } = await sessionWithMock();
		const file = await writeProjectFile(sandbox, "esc.testlang", "def esc\nesc\n");
		const escaped = join(sandbox.project, "..", "escaped.testlang");

		const result = await session.client.call("rename", { filePath: file, line: 2, character: 1, newName: "OVERRIDE_OUTSIDE" });
		expect(result.isError ?? false).toBe(true);
		const apply = applyOf(result);
		expect(apply["success"]).toBe(false);
		expect(session.client.resultText(result)).toMatch(/outside workspace/i);
		expect(existsSync(escaped)).toBe(false);
		expect(await readFile(file, "utf8")).toBe("def esc\nesc\n");
		await session.client.close();
	});

	it("rejects overlapping edits and leaves the file unchanged", async () => {
		const { sandbox, session } = await sessionWithMock();
		const file = await writeProjectFile(sandbox, "ov.testlang", "def ov\nov\n");

		const result = await session.client.call("rename", { filePath: file, line: 2, character: 1, newName: "OVERRIDE_OVERLAP" });
		expect(result.isError ?? false).toBe(true);
		expect(applyOf(result)["success"]).toBe(false);
		expect(session.client.resultText(result)).toMatch(/overlapping edits/i);
		expect(await readFile(file, "utf8")).toBe("def ov\nov\n");
		await session.client.close();
	});
});

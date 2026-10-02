// Diagnostics contract: per-file results, severity filtering, content-changing
// freshness on disk rewrite, and directory aggregation. All values come from
// the real proxy + fixture wire, not from internal runtime imports.

import { afterEach, describe, expect, it } from "bun:test";
import {
	cleanupAllSandboxes,
	isRecord,
	type McpToolResult,
	mockServer,
	newSandbox,
	readEvents,
	startSession,
	writeProjectFile,
	writeUserConfig,
	writeWorkspaceMarker,
} from "./mcp-client.ts";

afterEach(async () => {
	await cleanupAllSandboxes();
});

function detailsOf(result: McpToolResult): Record<string, unknown> {
	return isRecord(result.details) ? result.details : {};
}

async function sessionWithMock() {
	const sandbox = await newSandbox();
	await writeWorkspaceMarker(sandbox);
	await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
	const session = await startSession(sandbox);
	return { sandbox, session };
}

describe("diagnostics", () => {
	it("returns the file diagnostic with severity and message", async () => {
		const { sandbox, session } = await sessionWithMock();
		const path = await writeProjectFile(sandbox, "src/error.testlang", "ERROR_MARKER\n");
		const result = await session.client.call("diagnostics", { filePath: path });
		const details = detailsOf(result);
		expect(details["totalDiagnostics"]).toBe(1);
		const diagnostics = details["diagnostics"] as Array<Record<string, unknown>>;
		const diagnostic = diagnostics[0] as Record<string, unknown>;
		expect(isRecord(diagnostic["diagnostic"]) ? diagnostic["diagnostic"]["severity"] : undefined).toBe(1);
		expect(session.client.resultText(result)).toMatch(/error.*error marker present/i);
		await session.client.close();
	});

	it("filters by severity", async () => {
		const { sandbox, session } = await sessionWithMock();
		const path = await writeProjectFile(sandbox, "src/sev.testlang", "ERROR_MARKER\nWARN_MARKER\nINFO_MARKER\nHINT_MARKER\n");

		const all = await session.client.call("diagnostics", { filePath: path });
		expect(detailsOf(all)["totalDiagnostics"]).toBe(4);

		const errors = await session.client.call("diagnostics", { filePath: path, severity: "error" });
		expect(detailsOf(errors)["totalDiagnostics"]).toBe(1);
		expect(session.client.resultText(errors)).toMatch(/error.*error marker present/i);

		const warnings = await session.client.call("diagnostics", { filePath: path, severity: "warning" });
		expect(detailsOf(warnings)["totalDiagnostics"]).toBe(1);
		expect(session.client.resultText(warnings)).toMatch(/warning.*warn marker present/i);
		await session.client.close();
	});

	it("reflects content changed on disk between calls", async () => {
		const { sandbox, session } = await sessionWithMock();
		const path = await writeProjectFile(sandbox, "src/fresh.testlang", "ERROR_MARKER\n");

		const first = await session.client.call("diagnostics", { filePath: path });
		expect(detailsOf(first)["totalDiagnostics"]).toBe(1);

		await writeProjectFile(sandbox, "src/fresh.testlang", "def harmless\n");
		const second = await session.client.call("diagnostics", { filePath: path });
		expect(detailsOf(second)["totalDiagnostics"]).toBe(0);
		expect(session.client.resultText(second)).toBe("No diagnostics found");

		const events = await readEvents(sandbox);
		expect(events).toContain("in:textDocument/didChange");
		expect(events).toContain("out:textDocument/publishDiagnostics");
		await session.client.close();
	});

	it("aggregates diagnostics over a directory", async () => {
		const sandbox = await newSandbox();
		await writeWorkspaceMarker(sandbox);
		await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox, { extensions: [".ts"] }) } });
		const session = await startSession(sandbox);
		await writeProjectFile(sandbox, "src/a.ts", "ERROR_MARKER\n");
		await writeProjectFile(sandbox, "src/b.ts", "WARN_MARKER\n");
		await writeProjectFile(sandbox, "src/ignored.testlang", "ERROR_MARKER\n");

		const result = await session.client.call("diagnostics", { filePath: `${sandbox.project}/src` });
		const details = detailsOf(result);
		expect(details["mode"]).toBe("directory");
		expect(details["totalDiagnostics"]).toBe(2);
		const text = session.client.resultText(result);
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
		expect(text).not.toContain("ignored.testlang");
		expect(text).toContain("Total diagnostics: 2");
		await session.client.close();
	});
});

// Navigation contract: goto_definition, find_references, and symbols in both
// document and workspace scope, resolved against the deterministic fixture.

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

function detailsOf(result: McpToolResult): Record<string, unknown> {
	return isRecord(result.details) ? result.details : {};
}

describe("navigation", () => {
	it("resolves definition, references, and symbols across workspace files", async () => {
		const sandbox = await newSandbox();
		await writeWorkspaceMarker(sandbox);
		await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
		const main = await writeProjectFile(sandbox, "src/main.testlang", "def alpha\n  alpha\n");
		await writeProjectFile(sandbox, "src/other.testlang", "def alpha_other\nalpha\n");
		const { client } = await startSession(sandbox);

		const definition = await client.call("goto_definition", { filePath: main, line: 2, character: 3 });
		const locations = detailsOf(definition)["locations"] as Array<Record<string, unknown>>;
		expect(locations).toHaveLength(1);
		const location = locations[0] as Record<string, unknown>;
		expect(String(location["uri"])).toContain("main.testlang");
		const range = location["range"] as Record<string, unknown>;
		expect((range["start"] as Record<string, unknown>)["line"]).toBe(0);
		expect(client.resultText(definition)).toContain("main.testlang:1:0");

		const references = await client.call("find_references", { filePath: main, line: 2, character: 3 });
		expect(detailsOf(references)["totalReferences"]).toBe(3);

		const document = await client.call("symbols", { filePath: main, scope: "document" });
		const documentDetails = detailsOf(document);
		expect(documentDetails["scope"]).toBe("document");
		expect(documentDetails["totalSymbols"]).toBe(1);
		const documentSymbols = documentDetails["symbols"] as Array<Record<string, unknown>>;
		expect(documentSymbols[0]?.["name"]).toBe("alpha");

		const workspace = await client.call("symbols", { filePath: main, scope: "workspace", query: "alpha" });
		const workspaceDetails = detailsOf(workspace);
		expect(workspaceDetails["scope"]).toBe("workspace");
		expect(workspaceDetails["totalSymbols"]).toBe(2);
		await client.close();
	});

	it("reports a rename range for prepare_rename", async () => {
		const sandbox = await newSandbox();
		await writeWorkspaceMarker(sandbox);
		await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
		const main = await writeProjectFile(sandbox, "src/prepare.testlang", "def alpha\n  alpha\n");
		const { client } = await startSession(sandbox);

		const result = await client.call("prepare_rename", { filePath: main, line: 2, character: 3 });
		expect(result.isError ?? false).toBe(false);
		const shape = detailsOf(result)["result"] as Record<string, unknown>;
		const range = shape["range"] as Record<string, unknown>;
		expect((range["start"] as Record<string, unknown>)["line"]).toBe(1);
		expect((range["start"] as Record<string, unknown>)["character"]).toBe(2);
		expect(client.resultText(result)).toMatch(/rename available at 2:2-2:7/i);
		expect(client.resultText(result)).toContain("alpha");
		await client.close();
	});
});

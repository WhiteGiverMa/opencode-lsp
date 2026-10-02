// Black-box MCP contract: the seven-tool surface, alias callability, removed
// tools, and the status-is-read-only boundary. Drives the real
// `node bin/opencode-lsp.js mcp` proxy; no internal imports of the runtime.

import { afterEach, describe, expect, it } from "bun:test";
import {
	cleanupAllSandboxes,
	isRecord,
	type McpToolResult,
	mockServer,
	newSandbox,
	readSpawnedPids,
	startSession,
	writeProjectFile,
	writeUserConfig,
	writeWorkspaceMarker,
} from "./mcp-client.ts";

const SEVEN = ["diagnostics", "find_references", "goto_definition", "prepare_rename", "rename", "status", "symbols"];
const REMOVED = ["install_decision", "lsp_install_decision", "format", "lsp_format"];

afterEach(async () => {
	await cleanupAllSandboxes();
});

function detailsOf(result: McpToolResult): Record<string, unknown> {
	return isRecord(result.details) ? result.details : {};
}

function requiredFields(tool: { readonly inputSchema: { readonly required?: string[] } }): string[] {
	return tool.inputSchema.required ?? [];
}

async function sessionWithMock() {
	const sandbox = await newSandbox();
	await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
	const session = await startSession(sandbox);
	return { sandbox, session };
}

describe("tool surface", () => {
	it("lists exactly the seven bare tool names with schemas", async () => {
		const { session } = await sessionWithMock();
		const tools = await session.client.listTools();
		expect([...tools.map((tool) => tool.name)].sort()).toEqual([...SEVEN].sort());
		expect(tools.some((tool) => tool.name.startsWith("lsp_"))).toBe(false);
		for (const tool of tools) {
			expect(tool.inputSchema.type).toBe("object");
			expect(tool.description ?? "").not.toHaveLength(0);
		}
		await session.client.close();
	});

	it("declares the documented required parameters per tool", async () => {
		const { session } = await sessionWithMock();
		const tools = new Map((await session.client.listTools()).map((tool) => [tool.name, tool]));
		const required = (name: string): string[] => requiredFields(tools.get(name) ?? { inputSchema: { required: [] } });
		expect(required("status")).toEqual([]);
		expect(required("diagnostics")).toEqual(["filePath"]);
		expect([...required("symbols")].sort()).toEqual(["filePath", "scope"]);
		for (const name of ["goto_definition", "find_references", "prepare_rename"]) {
			expect([...required(name)].sort()).toEqual(["character", "filePath", "line"]);
		}
		expect([...required("rename")].sort()).toEqual(["character", "filePath", "line", "newName"]);
		await session.client.close();
	});

	it("exposes callable lsp_* aliases that are not advertised", async () => {
		const { sandbox, session } = await sessionWithMock();
		const tools = await session.client.listTools();
		expect(tools.some((tool) => tool.name === "lsp_status")).toBe(false);

		const alias = await session.client.call("lsp_status", {});
		expect(alias.isError ?? false).toBe(false);
		const details = detailsOf(alias);
		expect(Array.isArray(details["servers"])).toBe(true);
		expect((details["servers"] as unknown[]).some((server) => isRecord(server) && server["id"] === "mock")).toBe(true);
		expect(await readSpawnedPids(sandbox)).toEqual([]);
		await session.client.close();
		expect(await readSpawnedPids(sandbox)).toEqual([]);
	});

	it("accepts every documented lsp_* alias", async () => {
		const sandbox = await newSandbox();
		await writeWorkspaceMarker(sandbox);
		await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
		const file = await writeProjectFile(sandbox, "src/alias.testlang", "def alpha\n  alpha\n");
		const { client } = await startSession(sandbox);

		const calls: Array<[string, Record<string, unknown>]> = [
			["lsp_status", {}],
			["lsp_diagnostics", { filePath: file }],
			["lsp_goto_definition", { filePath: file, line: 2, character: 3 }],
			["lsp_find_references", { filePath: file, line: 2, character: 3 }],
			["lsp_symbols", { filePath: file, scope: "document" }],
			["lsp_prepare_rename", { filePath: file, line: 2, character: 3 }],
			["lsp_rename", { filePath: file, line: 2, character: 3, newName: "omega" }],
		];
		for (const [name, args] of calls) {
			const result = await client.call(name, args);
			expect(result.isError ?? false).toBe(false);
			expect(client.resultText(result)).not.toMatch(/unknown lsp tool/i);
		}
		await client.close();
	});

	it("rejects removed install_decision and format tools, including aliases", async () => {
		const { session } = await sessionWithMock();
		const names = new Set((await session.client.listTools()).map((tool) => tool.name));
		for (const removed of REMOVED) {
			expect(names.has(removed)).toBe(false);
			const result = await session.client.call(removed, {});
			expect(result.isError ?? false).toBe(true);
			expect(session.client.resultText(result)).toMatch(/unknown lsp tool/i);
		}
		const unknown = await session.client.call("definitely_not_a_tool", {});
		expect(unknown.isError ?? false).toBe(true);
		expect(session.client.resultText(unknown)).toMatch(/unknown lsp tool/i);
		await session.client.close();
	});

	it("status reports configuration without starting a language server", async () => {
		const { sandbox, session } = await sessionWithMock();
		const result = await session.client.call("status", {});
		const details = detailsOf(result);
		const servers = details["servers"] as Array<Record<string, unknown>>;
		expect(servers.some((server) => server["id"] === "mock" && server["installed"] === true)).toBe(true);
		expect(servers.some((server) => server["id"] === "gdscript" && server["source"] === "builtin")).toBe(true);
		expect(details["snapshots"]).toEqual([]);
		expect(await readSpawnedPids(sandbox)).toEqual([]);
		await session.client.close();
	});
});

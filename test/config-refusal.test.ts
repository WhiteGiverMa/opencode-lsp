// Configuration trust and refusal contract: unconfigured extensions, missing
// commands, read-only `declined_servers` refusals, installed-server precedence,
// malformed refusal state, project-config trust limits, and explicit paths.

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
	readSpawnedPids,
	startSession,
	writeJsonFile,
	writeProjectFile,
	writeRefusals,
	writeUserConfig,
	writeWorkspaceMarker,
} from "./mcp-client.ts";

afterEach(async () => {
	await cleanupAllSandboxes();
});

function detailsOf(result: McpToolResult): Record<string, unknown> {
	return isRecord(result.details) ? result.details : {};
}

function availabilityOf(result: McpToolResult): Record<string, unknown> {
	const availability = detailsOf(result)["availability"];
	return isRecord(availability) ? availability : {};
}

const MISSING_COMMAND = { command: ["/nonexistent/omo-missing-lsp"], extensions: [".testlang"] };

describe("configuration and refusals", () => {
	it("reports an unconfigured extension without spawning anything", async () => {
		const sandbox = await newSandbox();
		const file = await writeProjectFile(sandbox, "plain.unknownlang", "content\n");
		const { client } = await startSession(sandbox);
		const result = await client.call("diagnostics", { filePath: file });
		expect(result.isError ?? false).toBe(false);
		expect(detailsOf(result)["errorKind"]).toBe("missing_dependency");
		expect(availabilityOf(result)["kind"]).toBe("not_configured");
		expect(client.resultText(result)).toMatch(/no lsp server configured/i);
		await client.close();
	});

	it("skips common unconfigured documents instead of requesting an LSP", async () => {
		const sandbox = await newSandbox();
		const { client } = await startSession(sandbox);
		for (const extension of [".md", ".MD", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx", ".txt", ".text", ".rst", ".rest", ".adoc", ".asciidoc", ".org", ".rtf", ".pdf", ".doc", ".docx", ".odt"]) {
			const file = await writeProjectFile(sandbox, `document${extension}`, "Document content\n");
			const result = await client.call("diagnostics", { filePath: file });
			expect(result.isError ?? false).toBe(false);
			expect(detailsOf(result)["skipped"]).toBe(true);
			expect(detailsOf(result)["reason"]).toBe("document_file");
			expect(detailsOf(result)["error"]).toBeUndefined();
			expect(detailsOf(result)["errorKind"]).toBeUndefined();
			expect(availabilityOf(result)["kind"]).toBe("not_applicable");
			expect(availabilityOf(result)["extension"]).toBe(extension);
			expect(client.resultText(result)).toMatch(/document.*normally.*require LSP/i);
			expect(client.resultText(result)).not.toMatch(/no LSP server configured|configure a custom server|ASK THE USER|No diagnostics found/i);
		}
		expect(await readSpawnedPids(sandbox)).toEqual([]);
		expect(existsSync(sandbox.refusalsPath)).toBe(false);
		await client.close();
	});

	it("uses the document feedback across file tools and document-only directories", async () => {
		const sandbox = await newSandbox();
		const file = await writeProjectFile(sandbox, "docs/guide.md", "# Guide\n");
		const { client } = await startSession(sandbox);
		for (const [name, args] of [
			["goto_definition", { filePath: file, line: 1, character: 0 }],
			["find_references", { filePath: file, line: 1, character: 0 }],
			["symbols", { filePath: file, scope: "document" }],
			["symbols", { filePath: file, scope: "workspace", query: "Guide" }],
			["prepare_rename", { filePath: file, line: 1, character: 0 }],
			["rename", { filePath: file, line: 1, character: 0, newName: "renamed" }],
			["diagnostics", { filePath: join(sandbox.project, "docs") }],
		] as const) {
			const result = await client.call(name, args);
			expect(result.isError ?? false).toBe(false);
			expect(detailsOf(result)["skipped"]).toBe(true);
			expect(detailsOf(result)["errorKind"]).toBeUndefined();
			expect(client.resultText(result)).toMatch(/LSP check skipped/i);
		}
		const invalid = await client.call("symbols", { filePath: file, scope: "workspace" });
		expect(detailsOf(invalid)["errorKind"]).toBe("missing_query");
		expect(detailsOf(invalid)["skipped"]).toBeUndefined();
		expect(await readFile(file, "utf8")).toBe("# Guide\n");
		expect(await readSpawnedPids(sandbox)).toEqual([]);
		await client.close();
	});

	it("still uses an explicitly configured document language server", async () => {
		const sandbox = await newSandbox();
		await writeWorkspaceMarker(sandbox);
		await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox, { extensions: [".md"] }) } });
		const file = await writeProjectFile(sandbox, "checked.md", "ERROR_MARKER\n");
		const { client } = await startSession(sandbox);
		const result = await client.call("diagnostics", { filePath: file });
		expect(detailsOf(result)["totalDiagnostics"]).toBe(1);
		expect(detailsOf(result)["skipped"]).toBeUndefined();
		expect(await readSpawnedPids(sandbox)).toHaveLength(1);
		await client.close();
	});

	it("still reports a missing explicitly configured document server", async () => {
		const sandbox = await newSandbox();
		await writeUserConfig(sandbox, { lsp: { mock: { ...MISSING_COMMAND, extensions: [".md"] } } });
		const file = await writeProjectFile(sandbox, "checked.md", "# Guide\n");
		const { client } = await startSession(sandbox);
		const result = await client.call("diagnostics", { filePath: file });
		expect(detailsOf(result)["errorKind"]).toBe("missing_dependency");
		expect(availabilityOf(result)["kind"]).toBe("not_installed");
		expect(detailsOf(result)["skipped"]).toBeUndefined();
		expect(client.resultText(result)).toMatch(/not installed/i);
		await client.close();
	});

	it("guides on a missing command and never writes a refusal file", async () => {
		const sandbox = await newSandbox();
		await writeUserConfig(sandbox, { lsp: { mock: MISSING_COMMAND } });
		const file = await writeProjectFile(sandbox, "missing.testlang", "def a\n");
		const { client } = await startSession(sandbox);
		const result = await client.call("diagnostics", { filePath: file });
		const text = client.resultText(result);
		expect(text).toMatch(/not installed/i);
		expect(text).toMatch(/ask the user/i);
		expect(text).toMatch(/declined_servers/);
		expect(text).toContain(sandbox.refusalsPath);
		expect(availabilityOf(result)["kind"]).toBe("not_installed");
		expect(availabilityOf(result)["installDecisionTool"]).toBe(false);
		expect(existsSync(sandbox.refusalsPath)).toBe(false);
		await client.close();
	});

	it("reads declined_servers refusals without rewriting them", async () => {
		const sandbox = await newSandbox();
		await writeUserConfig(sandbox, { lsp: { mock: MISSING_COMMAND } });
		await writeRefusals(sandbox, { declined_servers: ["mock"] });
		const before = await readFile(sandbox.refusalsPath, "utf8");
		const file = await writeProjectFile(sandbox, "refused.testlang", "def a\n");
		const { client } = await startSession(sandbox);
		const result = await client.call("diagnostics", { filePath: file });
		expect(client.resultText(result)).toMatch(/declined/i);
		expect(await readFile(sandbox.refusalsPath, "utf8")).toBe(before);
		await client.close();
	});

	it("uses an installed server even when a stale refusal exists", async () => {
		const sandbox = await newSandbox();
		await writeWorkspaceMarker(sandbox);
		await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
		await writeRefusals(sandbox, { declined_servers: ["mock"] });
		const file = await writeProjectFile(sandbox, "reinstalled.testlang", "ERROR_MARKER\n");
		const { client } = await startSession(sandbox);
		const result = await client.call("diagnostics", { filePath: file });
		expect(detailsOf(result)["totalDiagnostics"]).toBe(1);
		expect(client.resultText(result)).not.toMatch(/not installed|declined/i);
		await client.close();
	});

	it("treats malformed refusal state as an explicit error, not as permission", async () => {
		const sandbox = await newSandbox();
		await writeUserConfig(sandbox, { lsp: { mock: MISSING_COMMAND } });
		await writeRefusals(sandbox, '{ "declined_servers": "mock" }\n');
		const before = await readFile(sandbox.refusalsPath, "utf8");
		const file = await writeProjectFile(sandbox, "malformed.testlang", "def a\n");
		const { client } = await startSession(sandbox);
		const result = await client.call("diagnostics", { filePath: file });
		expect(result.isError ?? false).toBe(true);
		expect(client.resultText(result)).toMatch(/refus|invalid|malformed/i);
		expect(await readFile(sandbox.refusalsPath, "utf8")).toBe(before);
		await client.close();
	});

	it("ignores executables and env declared only in project config", async () => {
		const sandbox = await newSandbox();
		const projectConfig = join(sandbox.project, ".opencode", "lsp.json");
		await writeJsonFile(projectConfig, {
			lsp: { mock: { command: ["node", "/nonexistent/project-only.mjs"], extensions: [".testlang"], env: { EVIL: "1" } } },
		});
		const file = await writeProjectFile(sandbox, "project.testlang", "def a\n");
		const { client } = await startSession(sandbox, { projectConfigPath: projectConfig });
		const result = await client.call("diagnostics", { filePath: file });
		expect(availabilityOf(result)["kind"]).toBe("not_configured");
		expect(client.resultText(result)).toMatch(/no lsp server configured/i);
		expect(await readSpawnedPids(sandbox)).toEqual([]);
		await client.close();
	});

	it("honors explicit config and refusal paths", async () => {
		const sandbox = await newSandbox();
		await writeWorkspaceMarker(sandbox);
		const explicitConfig = join(sandbox.root, "explicit", "lsp.json");
		await writeJsonFile(explicitConfig, { lsp: { mock: mockServer(sandbox) } });
		const file = await writeProjectFile(sandbox, "explicit.testlang", "WARN_MARKER\n");
		const first = await startSession(sandbox, { configPath: explicitConfig });
		const result = await first.client.call("diagnostics", { filePath: file });
		expect(detailsOf(result)["totalDiagnostics"]).toBe(1);
		await first.client.close();

		const explicitRefusals = join(sandbox.root, "explicit", "refusals.json");
		await writeJsonFile(explicitRefusals, { declined_servers: ["mock"] });
		const missingConfig = join(sandbox.root, "explicit", "missing.json");
		await writeJsonFile(missingConfig, { lsp: { mock: MISSING_COMMAND } });
		const second = await startSession(sandbox, { configPath: missingConfig, refusalsPath: explicitRefusals });
		const refused = await second.client.call("diagnostics", { filePath: file });
		expect(second.client.resultText(refused)).toMatch(/declined/i);
		await second.client.close();
	});
});

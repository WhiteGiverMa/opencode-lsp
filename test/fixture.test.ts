// Proves the deterministic `.testlang` LSP fixture behaves exactly as the
// contract tests assume. This does not touch the parent CLI, so it stays green
// while the runtime is still being built and guards against fixture drift.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { FIXTURE_PATH, nodeBin, waitingFor } from "./mcp-client.ts";

interface Pending {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface Peer {
	request(method: string, params?: Record<string, unknown>): Promise<unknown>;
	notify(method: string, params?: Record<string, unknown>): void;
	latestDiagnostics(uri: string): Promise<Record<string, unknown>>;
	waitForVersion(uri: string, version: number): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function createPeer(cwd: string): Peer {
	const child: ChildProcess = spawn(nodeBin(), [FIXTURE_PATH], { cwd, stdio: ["pipe", "pipe", "pipe"] });
	const stdin = child.stdin;
	const stdout = child.stdout;
	if (stdin === null || stdout === null) throw new Error("fixture spawn missing stdio");
	let buffer = Buffer.alloc(0);
	let nextId = 1;
	const pending = new Map<number, Pending>();
	const publishes: Array<Record<string, unknown>> = [];

	const handle = (message: Record<string, unknown>): void => {
		const id = message["id"];
		if (typeof id === "number" && (message["result"] !== undefined || message["error"] !== undefined)) {
			const call = pending.get(id);
			pending.delete(id);
			if (call === undefined) return;
			if (message["error"] !== undefined) call.reject(new Error(`fixture ${call.method} error`));
			else call.resolve(message["result"]);
			return;
		}
		if (message["method"] === "textDocument/publishDiagnostics") publishes.push(record(message["params"]));
	};

	stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		for (;;) {
			const separator = buffer.indexOf("\r\n\r\n");
			if (separator === -1) return;
			const headers = buffer.subarray(0, separator).toString("ascii");
			const match = /content-length:\s*(\d+)/i.exec(headers);
			if (match === null) {
				buffer = buffer.subarray(separator + 4);
				continue;
			}
			const start = separator + 4;
			const end = start + Number(match[1]);
			if (buffer.length < end) return;
			const body = buffer.subarray(start, end).toString("utf8");
			buffer = buffer.subarray(end);
			try {
				handle(record(JSON.parse(body)));
			} catch {
				// A malformed frame leaves the reply missing; the assertions report it.
			}
		}
	});

	const send = (message: unknown): void => {
		const body = JSON.stringify(message);
		stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
	};

	const matching = (uri: string): Array<Record<string, unknown>> => publishes.filter((params) => params["uri"] === uri);

	return {
		request(method, params) {
			const id = nextId;
			nextId += 1;
			return new Promise<unknown>((resolveRequest, rejectRequest) => {
				pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
				send({ jsonrpc: "2.0", id, method, params: params ?? {} });
			});
		},
		notify(method, params) {
			send({ jsonrpc: "2.0", method, params: params ?? {} });
		},
		async latestDiagnostics(uri) {
			const ok = await waitingFor(() => matching(uri).length > 0, 2000);
			if (!ok) throw new Error(`no diagnostics for ${uri}`);
			return matching(uri)[matching(uri).length - 1] ?? {};
		},
		async waitForVersion(uri, version) {
			const ok = await waitingFor(() => matching(uri).some((params) => params["version"] === version), 2000);
			if (!ok) throw new Error(`no version ${version} diagnostics for ${uri}`);
			return matching(uri).filter((params) => params["version"] === version).slice(-1)[0] ?? {};
		},
		async close() {
			stdin.end();
			child.kill("SIGTERM");
			await waitingFor(() => child.exitCode !== null || child.signalCode !== null, 2000);
		},
	};
}

describe("testlang fixture", () => {
	let root: string;
	let peer: Peer;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "testlang-fixture-"));
		peer = createPeer(root);
		const initialized = await peer.request("initialize", { rootPath: root, rootUri: pathToFileURL(root).href });
		expect(record(initialized)).toHaveProperty("capabilities");
		peer.notify("initialized", {});
	});

	afterAll(async () => {
		await peer.close();
		await rm(root, { recursive: true, force: true });
	});

	it("publishes marker diagnostics with the matching severity", async () => {
		const uri = pathToFileURL(join(root, "markers.testlang")).href;
		peer.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "testlang", version: 1, text: "ERROR_MARKER\ndef thing\nWARN_MARKER\nINFO_MARKER\nHINT_MARKER\n" },
		});
		const published = await peer.latestDiagnostics(uri);
		const diagnostics = published["diagnostics"] as Array<Record<string, unknown>>;
		expect(diagnostics.map((item) => item["severity"])).toEqual([1, 2, 3, 4]);
		expect(diagnostics.map((item) => item["message"])).toEqual([
			"error marker present",
			"warn marker present",
			"info marker present",
			"hint marker present",
		]);
	});

	it("re-publishes fresh diagnostics after a full-content change", async () => {
		const uri = pathToFileURL(join(root, "fresh.testlang")).href;
		peer.notify("textDocument/didOpen", { textDocument: { uri, languageId: "testlang", version: 1, text: "ERROR_MARKER\n" } });
		const first = await peer.waitForVersion(uri, 1);
		expect((first["diagnostics"] as unknown[]).length).toBe(1);
		peer.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: "clean content\n" }] });
		const second = await peer.waitForVersion(uri, 2);
		expect((second["diagnostics"] as unknown[]).length).toBe(0);
	});

	it("resolves definitions, references, document and workspace symbols", async () => {
		const mainPath = join(root, "main.testlang");
		const otherPath = join(root, "other.testlang");
		await writeFile(mainPath, "def alpha\n  alpha\n", "utf8");
		await writeFile(otherPath, "def alpha_other\nalpha\n", "utf8");
		const mainUri = pathToFileURL(mainPath).href;
		peer.notify("textDocument/didOpen", { textDocument: { uri: mainUri, languageId: "testlang", version: 1, text: await readFile(mainPath, "utf8") } });

		const definition = record(await peer.request("textDocument/definition", { textDocument: { uri: mainUri }, position: { line: 1, character: 3 } }));
		expect(definition["uri"]).toBe(mainUri);
		expect(record(record(definition["range"])["start"])["line"]).toBe(0);

		const references = (await peer.request("textDocument/references", {
			textDocument: { uri: mainUri },
			position: { line: 1, character: 3 },
			context: { includeDeclaration: true },
		})) as unknown[];
		expect(references.length).toBe(3);

		const documentSymbols = (await peer.request("textDocument/documentSymbol", { textDocument: { uri: mainUri } })) as Array<Record<string, unknown>>;
		expect(documentSymbols.map((symbol) => symbol["name"])).toEqual(["alpha"]);

		const workspaceSymbols = (await peer.request("workspace/symbol", { query: "alpha" })) as Array<Record<string, unknown>>;
		expect(workspaceSymbols.length).toBeGreaterThanOrEqual(2);
	});

	it("prepares and applies a rename across workspace files", async () => {
		const renamedPath = join(root, "renamed.testlang");
		await writeFile(renamedPath, "def beta\nbeta again\n", "utf8");
		const uri = pathToFileURL(renamedPath).href;
		peer.notify("textDocument/didOpen", { textDocument: { uri, languageId: "testlang", version: 1, text: await readFile(renamedPath, "utf8") } });
		const prepared = record(await peer.request("textDocument/prepareRename", { textDocument: { uri }, position: { line: 1, character: 2 } }));
		expect(prepared["placeholder"]).toBe("beta");
		const rename = record(await peer.request("textDocument/rename", { textDocument: { uri }, position: { line: 1, character: 2 }, newName: "gamma" }));
		const changes = record(rename["changes"]);
		const edits = changes[uri] as Array<Record<string, unknown>>;
		expect(edits.length).toBe(2);
		expect(edits.every((edit) => edit["newText"] === "gamma")).toBe(true);
	});

	it("supports the out-of-workspace and overlapping rename overrides", async () => {
		const uri = pathToFileURL(join(root, "override.testlang")).href;
		peer.notify("textDocument/didOpen", { textDocument: { uri, languageId: "testlang", version: 1, text: "def delta\ndelta\n" } });
		const outside = record(await peer.request("textDocument/rename", { textDocument: { uri }, position: { line: 1, character: 1 }, newName: "OVERRIDE_OUTSIDE" }));
		expect(Object.keys(record(outside["changes"]))[0]).toContain("escaped.testlang");
		const overlap = record(await peer.request("textDocument/rename", { textDocument: { uri }, position: { line: 1, character: 1 }, newName: "OVERRIDE_OVERLAP" }));
		const edits = record(overlap["changes"])[uri] as unknown[];
		expect(edits.length).toBe(2);
		expect(record(record(edits[1])["range"])).toHaveProperty("start");
	});
});

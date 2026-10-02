#!/usr/bin/env node
// Deterministic stdio language server for the `.testlang` contract tests.
// Speaks LSP over stdin/stdout with Content-Length framing. It is intentionally
// small and self-contained so the standalone MCP proxy can be exercised as a
// black box without mocking our own CLI.
//
// `.testlang` semantics (owned by this fixture, relied on by the tests):
//   - `def NAME` declares a symbol.
//   - Any line containing ERROR_MARKER/WARN_MARKER/INFO_MARKER/HINT_MARKER
//     publishes a diagnostic with severity 1/2/3/4 respectively.
//   - rename with newName OVERRIDE_OUTSIDE returns an out-of-workspace edit.
//   - rename with newName OVERRIDE_OVERLAP returns overlapping edits.

import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SPAWN_LOG = process.env["LSP_FIXTURE_SPAWN_LOG"];
if (typeof SPAWN_LOG === "string" && SPAWN_LOG.length > 0) {
	try {
		appendFileSync(SPAWN_LOG, `${process.pid}\n`);
	} catch {
		// Spawn logging is best-effort evidence only; never fail the server for it.
	}
}

const EVENT_LOG = process.env["LSP_FIXTURE_EVENT_LOG"];
function logEvent(entry) {
	if (typeof EVENT_LOG !== "string" || EVENT_LOG.length === 0) return;
	try {
		appendFileSync(EVENT_LOG, `${entry}\n`);
	} catch {
		// Event logging is best-effort evidence only.
	}
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
const DEFINITION = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".opencode", ".omo", "dist", "build"]);

let workspaceRoot = process.cwd();
/** @type {Map<string, { text: string, version: number | undefined }>} */
const documents = new Map();

function listDocuments() {
	const files = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) walk(join(dir, entry.name));
				continue;
			}
			if (entry.isFile() && extname(entry.name) === ".testlang") files.push(join(dir, entry.name));
		}
	};
	walk(workspaceRoot);
	return files.sort();
}

function readDocument(uri) {
	const open = documents.get(uri);
	if (open) return open.text;
	try {
		return readFileSync(fileURLToPath(uri), "utf8");
	} catch {
		return "";
	}
}

function lineStarts(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

function offsetToPosition(text, offset) {
	const starts = lineStarts(text);
	let line = 0;
	for (let i = 0; i < starts.length; i += 1) {
		if (starts[i] > offset) break;
		line = i;
	}
	return { line, character: offset - starts[line] };
}

function rangeForOffsets(text, start, end) {
	return { start: offsetToPosition(text, start), end: offsetToPosition(text, end) };
}

function lineRange(text, lineIndex) {
	const starts = lineStarts(text);
	const start = starts[lineIndex] ?? 0;
	const rawEnd = starts[lineIndex + 1];
	const end = rawEnd === undefined ? text.length : rawEnd - 1;
	return rangeForOffsets(text, start, end < start ? start : end);
}

function wordOffsets(text, word) {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const matcher = new RegExp(`\\b${escaped}\\b`, "g");
	const offsets = [];
	let match;
	while ((match = matcher.exec(text)) !== null) {
		if (match[0].length > 0) offsets.push([match.index, match.index + match[0].length]);
	}
	return offsets;
}

function identifierAt(text, line, character) {
	const lines = text.split(/\r?\n/);
	const lineText = lines[line] ?? "";
	let nearest = null;
	IDENTIFIER.lastIndex = 0;
	let match;
	while ((match = IDENTIFIER.exec(lineText)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (character >= start && character <= end) return { word: match[0], start, end };
		if (nearest === null || Math.abs(character - start) < Math.abs(character - nearest.start)) {
			nearest = { word: match[0], start, end };
		}
	}
	return nearest;
}

const MARKERS = [
	{ token: "ERROR_MARKER", severity: 1, message: "error marker present", code: "E001" },
	{ token: "WARN_MARKER", severity: 2, message: "warn marker present", code: "W002" },
	{ token: "INFO_MARKER", severity: 3, message: "info marker present", code: "I003" },
	{ token: "HINT_MARKER", severity: 4, message: "hint marker present", code: "H004" },
];

function computeDiagnostics(text) {
	const lines = text.split(/\r?\n/);
	const diagnostics = [];
	for (let index = 0; index < lines.length; index += 1) {
		const lineText = lines[index];
		for (const marker of MARKERS) {
			const at = lineText.indexOf(marker.token);
			if (at === -1) continue;
			diagnostics.push({
				range: {
					start: { line: index, character: at },
					end: { line: index, character: at + marker.token.length },
				},
				severity: marker.severity,
				code: marker.code,
				source: "fixture",
				message: marker.message,
			});
			break;
		}
	}
	return diagnostics;
}

function send(message) {
	if (typeof message?.method === "string") logEvent(`out:${message.method}`);
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function publishDiagnostics(uri) {
	const open = documents.get(uri);
	if (!open) return;
	const diagnostics = computeDiagnostics(open.text);
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			diagnostics,
			...(open.version === undefined ? {} : { version: process.env.LSP_FIXTURE_STALE_PUSH === "1" ? open.version - 1 : open.version }),
		},
	});
}

function findDefinition(word) {
	for (const file of listDocuments()) {
		const text = readFileSync(file, "utf8");
		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const match = DEFINITION.exec(lines[index]);
			if (match !== null && match[1] === word) {
				return { uri: pathToFileURL(file).href, range: lineRange(text, index) };
			}
		}
	}
	return null;
}

function findReferences(word) {
	const locations = [];
	for (const file of listDocuments()) {
		const text = readFileSync(file, "utf8");
		const uri = pathToFileURL(file).href;
		for (const [start, end] of wordOffsets(text, word)) {
			locations.push({ uri, range: rangeForOffsets(text, start, end) });
		}
	}
	return locations;
}

function documentSymbols(text) {
	const lines = text.split(/\r?\n/);
	const symbols = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = DEFINITION.exec(lines[index]);
		if (match === null || match[1] === undefined) continue;
		const nameAt = lines[index].indexOf(match[1]);
		symbols.push({
			name: match[1],
			kind: 12,
			range: lineRange(text, index),
			selectionRange: rangeForOffsets(text, (lineStarts(text)[index] ?? 0) + nameAt, (lineStarts(text)[index] ?? 0) + nameAt + match[1].length),
		});
	}
	return symbols;
}

function workspaceSymbols(query) {
	const needle = query.toLowerCase();
	const symbols = [];
	for (const file of listDocuments()) {
		const text = readFileSync(file, "utf8");
		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const match = DEFINITION.exec(lines[index]);
			if (match === null || match[1] === undefined) continue;
			if (needle.length > 0 && !match[1].toLowerCase().includes(needle)) continue;
			symbols.push({ name: match[1], kind: 12, location: { uri: pathToFileURL(file).href, range: lineRange(text, index) } });
		}
	}
	return symbols;
}

function renameEdits(uri, word, newName) {
	if (newName === "OVERRIDE_OUTSIDE") {
		const outside = pathToFileURL(join(workspaceRoot, "..", "escaped.testlang")).href;
		return { changes: { [outside]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: newName }] } };
	}
	if (newName === "OVERRIDE_OVERLAP") {
		return {
			changes: {
				[uri]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "AAA" },
					{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: "BBB" },
				],
			},
		};
	}
	const changes = {};
	for (const file of listDocuments()) {
		const text = readFileSync(file, "utf8");
		const offsets = wordOffsets(text, word);
		if (offsets.length === 0) continue;
		changes[pathToFileURL(file).href] = offsets
			.map(([start, end]) => ({ range: rangeForOffsets(text, start, end), newText: newName }))
			.sort((left, right) => right.range.start.character - left.range.start.character || right.range.start.line - left.range.start.line);
	}
	if (Object.keys(changes).length === 0) return null;
	return { changes };
}

function handle(message) {
	const method = message.method;
	const params = message.params ?? {};
	const id = message.id;
	if (typeof method === "string") logEvent(`in:${method}`);

	if (method === "initialize") {
		const rootPath = params.rootPath;
		const rootUri = params.rootUri;
		if (typeof rootPath === "string" && rootPath.length > 0) workspaceRoot = rootPath;
		else if (typeof rootUri === "string" && rootUri.length > 0) workspaceRoot = fileURLToPath(rootUri);
		if (id !== undefined) {
			respond(id, {
				capabilities: {
					textDocumentSync: 1,
					definitionProvider: true,
					referencesProvider: true,
					documentSymbolProvider: true,
					workspaceSymbolProvider: true,
					renameProvider: { prepareProvider: true },
				},
				serverInfo: { name: "testlang-fixture", version: "1.0.0" },
			});
		}
		return;
	}

	if (method === "shutdown") {
		if (id !== undefined) {
			const delay = Number(process.env.LSP_FIXTURE_SHUTDOWN_DELAY_MS ?? 0);
			if (delay > 0) setTimeout(() => respond(id, null), delay);
			else respond(id, null);
		}
		return;
	}
	if (method === "exit") {
		process.exit(0);
	}
	if (method === "textDocument/didOpen") {
		const doc = params.textDocument ?? {};
		if (typeof doc.uri === "string") {
			documents.set(doc.uri, { text: typeof doc.text === "string" ? doc.text : "", version: doc.version });
			publishDiagnostics(doc.uri);
		}
		return;
	}
	if (method === "textDocument/didChange") {
		const doc = params.textDocument ?? {};
		const changes = Array.isArray(params.contentChanges) ? params.contentChanges : [];
		const last = changes.length > 0 ? changes[changes.length - 1] : undefined;
		if (typeof doc.uri === "string" && last !== undefined && typeof last.text === "string") {
			documents.set(doc.uri, { text: last.text, version: doc.version });
			publishDiagnostics(doc.uri);
		}
		return;
	}
	if (method === "textDocument/didClose") {
		const doc = params.textDocument ?? {};
		if (typeof doc.uri === "string") documents.delete(doc.uri);
		return;
	}
	if (method === "textDocument/definition") {
		const doc = params.textDocument ?? {};
		const position = params.position ?? { line: 0, character: 0 };
		const text = typeof doc.uri === "string" ? readDocument(doc.uri) : "";
		const found = identifierAt(text, position.line ?? 0, position.character ?? 0);
		if (id !== undefined) respond(id, found === null ? null : findDefinition(found.word));
		return;
	}
	if (method === "textDocument/references") {
		const doc = params.textDocument ?? {};
		const position = params.position ?? { line: 0, character: 0 };
		const text = typeof doc.uri === "string" ? readDocument(doc.uri) : "";
		const found = identifierAt(text, position.line ?? 0, position.character ?? 0);
		const includeDeclaration = params.context?.includeDeclaration !== false;
		let locations = found === null ? [] : findReferences(found.word);
		if (!includeDeclaration && found !== null) {
			const definition = findDefinition(found.word);
			if (definition !== null) {
				locations = locations.filter((location) => location.uri !== definition.uri || location.range.start.line !== definition.range.start.line);
			}
		}
		if (id !== undefined) respond(id, locations);
		return;
	}
	if (method === "textDocument/documentSymbol") {
		const doc = params.textDocument ?? {};
		const text = typeof doc.uri === "string" ? readDocument(doc.uri) : "";
		if (id !== undefined) respond(id, documentSymbols(text));
		return;
	}
	if (method === "workspace/symbol") {
		if (id !== undefined) respond(id, workspaceSymbols(typeof params.query === "string" ? params.query : ""));
		return;
	}
	if (method === "textDocument/prepareRename") {
		const doc = params.textDocument ?? {};
		const position = params.position ?? { line: 0, character: 0 };
		const text = typeof doc.uri === "string" ? readDocument(doc.uri) : "";
		const found = identifierAt(text, position.line ?? 0, position.character ?? 0);
		if (id !== undefined) {
			respond(
				id,
				found === null
					? null
					: {
							range: rangeForOffsets(text, (lineStarts(text)[position.line ?? 0] ?? 0) + found.start, (lineStarts(text)[position.line ?? 0] ?? 0) + found.end),
							placeholder: found.word,
						},
			);
		}
		return;
	}
	if (method === "textDocument/rename") {
		const doc = params.textDocument ?? {};
		const position = params.position ?? { line: 0, character: 0 };
		const text = typeof doc.uri === "string" ? readDocument(doc.uri) : "";
		const found = identifierAt(text, position.line ?? 0, position.character ?? 0);
		const newName = typeof params.newName === "string" ? params.newName : "";
		if (id !== undefined && newName === "OVERRIDE_DELAYED") {
			logEvent("rename-pending");
			setTimeout(() => {
				respond(id, found === null ? null : renameEdits(doc.uri, found.word, newName));
				logEvent("rename-delayed-response");
			}, 350);
			return;
		}
		if (id !== undefined) respond(id, found === null ? null : renameEdits(doc.uri, found.word, newName));
		return;
	}

	if (id !== undefined) respondError(id, -32601, `Method not found: ${String(method)}`);
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
	for (;;) {
		const separator = buffer.indexOf("\r\n\r\n");
		if (separator === -1) return;
		const header = buffer.subarray(0, separator).toString("ascii");
		const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
		if (lengthMatch === null) {
			buffer = buffer.subarray(separator + 4);
			continue;
		}
		const length = Number(lengthMatch[1]);
		const bodyStart = separator + 4;
		if (buffer.length < bodyStart + length) return;
		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		try {
			handle(JSON.parse(body));
		} catch {
			// Malformed frames are ignored; the proxy owns framing errors.
		}
	}
});

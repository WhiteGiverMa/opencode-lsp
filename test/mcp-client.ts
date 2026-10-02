// Minimal newline-delimited JSON-RPC client for the standalone `opencode-lsp
// mcp` stdio proxy, plus an isolated sandbox harness (temp home, config, owned
// process cleanup). The tests and downstream QA drive the real CLI through
// this module; nothing here mocks the CLI or the vendored runtime.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const FIXTURE_PATH = join(HERE, "fixtures", "language-server.mjs");
export const CLI_PATH = join(REPO_ROOT, "bin", "opencode-lsp.js");

export type JsonRpcId = number | string | null;
export type JsonRpcParams = Record<string, unknown>;

export interface JsonRpcErrorObject {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface JsonRpcSuccess {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly result: unknown;
}

export interface JsonRpcFailure {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpToolSchema {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema: {
		readonly type: "object";
		readonly properties?: Record<string, unknown>;
		readonly required?: string[];
		readonly [key: string]: unknown;
	};
}

export interface McpToolContent {
	readonly type: string;
	readonly text?: string;
	readonly [key: string]: unknown;
}

export interface McpToolResult {
	readonly content: McpToolContent[];
	readonly isError?: boolean;
	readonly details?: unknown;
}

export class McpRequestError extends Error {
	constructor(
		readonly method: string,
		readonly rpcError: JsonRpcErrorObject,
	) {
		super(`MCP ${method} failed: ${rpcError.message} (code ${rpcError.code})`);
		this.name = "McpRequestError";
	}
}

interface PendingCall {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export interface McpClient {
	readonly child: ChildProcess;
	readonly pid: number | undefined;
	request<R = unknown>(method: string, params?: JsonRpcParams): Promise<R>;
	notify(method: string, params?: JsonRpcParams): void;
	initialize(): Promise<unknown>;
	listTools(): Promise<McpToolSchema[]>;
	call(name: string, args?: JsonRpcParams): Promise<McpToolResult>;
	resultText(result: McpToolResult): string;
	close(): Promise<void>;
	stderrText(): string;
}

export function connect(child: ChildProcess): McpClient {
	const stdout = child.stdout;
	const stdin = child.stdin;
	const stderr = child.stderr;
	if (stdout === null || stdin === null) {
		throw new Error("connect() requires a child spawned with piped stdio");
	}

	let buffer = Buffer.alloc(0);
	let nextId = 1;
	let exited = false;
	const pending = new Map<JsonRpcId, PendingCall>();
	const stderrChunks: string[] = [];
	stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));

	const settleAll = (error: Error): void => {
		exited = true;
		for (const call of pending.values()) call.reject(error);
		pending.clear();
	};

	const handleMessage = (parsed: unknown): void => {
		if (!isRecord(parsed)) return;
		const id = parsed["id"];
		if (typeof id !== "number" && typeof id !== "string") return;
		const call = pending.get(id);
		if (call === undefined) return;
		pending.delete(id);
		if ("error" in parsed) {
			call.reject(new McpRequestError(call.method, normalizeRpcError(parsed["error"])));
			return;
		}
		call.resolve(parsed["result"]);
	};

	const pump = (): void => {
		for (;;) {
			if (buffer.length === 0) return;
			const framed = buffer.subarray(0, 15).toString("ascii").toLowerCase().startsWith("content-length:");
			if (framed) {
				const separator = buffer.indexOf("\r\n\r\n");
				if (separator === -1) return;
				const headers = buffer.subarray(0, separator).toString("ascii");
				const match = /content-length:\s*(\d+)/i.exec(headers);
				if (match === null) {
					buffer = buffer.subarray(separator + 4);
					continue;
				}
				const bodyStart = separator + 4;
				const bodyEnd = bodyStart + Number(match[1]);
				if (buffer.length < bodyEnd) return;
				handlePayload(buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
				buffer = buffer.subarray(bodyEnd);
				continue;
			}
			const newline = buffer.indexOf(10);
			if (newline === -1) return;
			const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
			buffer = buffer.subarray(newline + 1);
			if (line.trim().length > 0) handlePayload(line);
		}
	};

	const handlePayload = (payload: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return;
		}
		handleMessage(parsed);
	};

	stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		pump();
	});
	child.on("exit", (code, signal) => {
		settleAll(new Error(`opencode-lsp mcp exited (code=${String(code)}, signal=${String(signal)}): ${stderrChunks.join("")}`));
	});
	child.on("error", (error) => settleAll(error instanceof Error ? error : new Error(String(error))));

	const request = <R = unknown>(method: string, params?: JsonRpcParams): Promise<R> => {
		if (exited) return Promise.reject(new Error("opencode-lsp mcp client already closed"));
		const id = nextId;
		nextId += 1;
		const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
		if (params !== undefined) payload["params"] = params;
		return new Promise<R>((resolveRequest, rejectRequest) => {
			pending.set(id, {
				method,
				resolve: (value) => resolveRequest(value as R),
				reject: rejectRequest,
			});
			stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (error === undefined || error === null) return;
				const call = pending.get(id);
				pending.delete(id);
				call?.reject(error);
			});
		});
	};

	const notify = (method: string, params?: JsonRpcParams): void => {
		const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
		if (params !== undefined) payload["params"] = params;
		stdin.write(`${JSON.stringify(payload)}\n`);
	};

	const client: McpClient = {
		child,
		pid: child.pid,
		request,
		notify,
		async initialize(): Promise<unknown> {
			const result = await request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "opencode-lsp-contract-tests", version: "0.1.0" },
			});
			notify("notifications/initialized", {});
			return result;
		},
		async listTools(): Promise<McpToolSchema[]> {
			const raw = await request("tools/list", {});
			if (!isRecord(raw) || !Array.isArray(raw["tools"])) throw new Error("Malformed tools/list response");
			const tools: McpToolSchema[] = [];
			for (const tool of raw["tools"] as unknown[]) {
				if (!isMcpToolSchema(tool)) throw new Error("Malformed tool schema in tools/list response");
				tools.push(tool);
			}
			return tools;
		},
		async call(name: string, args?: JsonRpcParams): Promise<McpToolResult> {
			const raw = await request("tools/call", { name, arguments: args ?? {} });
			if (!isMcpToolResult(raw)) throw new Error(`Malformed tools/call result for ${name}`);
			return raw;
		},
		resultText(result: McpToolResult): string {
			return result.content
				.filter((item) => item.type === "text" && typeof item.text === "string")
				.map((item) => item.text ?? "")
				.join("\n");
		},
		async close(): Promise<void> {
			if (child.exitCode === null && child.signalCode === null) {
				stdin.end();
				const stopped = await waitingFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
				if (!stopped) {
					child.kill("SIGTERM");
					await waitingFor(() => child.exitCode !== null || child.signalCode !== null, 2000);
				}
			}
		},
		stderrText(): string {
			return stderrChunks.join("");
		},
	};
	return client;
}

// ---------------------------------------------------------------------------
// Sandbox harness
// ---------------------------------------------------------------------------

export interface LspServerEntry {
	readonly command: string[];
	readonly extensions: string[];
	readonly env?: Record<string, string>;
	readonly disabled?: boolean;
	readonly priority?: number;
	readonly initialization?: Record<string, unknown>;
}

export interface LspConfigFile {
	readonly lsp: Record<string, LspServerEntry>;
}

export interface RefusalFile {
	readonly declined_servers: string[];
}

export interface Sandbox {
	readonly root: string;
	readonly home: string;
	readonly project: string;
	readonly configPath: string;
	readonly refusalsPath: string;
	readonly stateDir: string;
	readonly spawnLog: string;
	readonly eventLog: string;
	readonly env: Record<string, string>;
	readonly children: ChildProcess[];
}

export interface SpawnOptions {
	readonly cwd?: string;
	readonly projectConfigPath?: string;
	readonly configPath?: string;
	readonly refusalsPath?: string;
	readonly env?: Record<string, string>;
}

export interface Session {
	readonly client: McpClient;
	readonly child: ChildProcess;
}

export async function createSandbox(): Promise<Sandbox> {
	const root = await mkdtemp(join(tmpdir(), "opencode-lsp-test-"));
	const home = join(root, "home");
	const project = join(root, "project");
	await mkdir(home, { recursive: true });
	await mkdir(project, { recursive: true });
	const sandbox: Sandbox = {
		root,
		home,
		project,
		configPath: join(home, "lsp.json"),
		refusalsPath: join(home, "refusals.json"),
		stateDir: join(home, "daemon"),
		spawnLog: join(root, "fixture-spawn.log"),
		eventLog: join(root, "fixture-events.log"),
		env: {
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			OPENCODE_LSP_HOME: home,
		},
		children: [],
	};
	return sandbox;
}

export function mockServer(sandbox: Sandbox, overrides: Partial<LspServerEntry> = {}): LspServerEntry {
	return {
		command: ["node", FIXTURE_PATH],
		extensions: [".testlang"],
		...overrides,
		env: {
			LSP_FIXTURE_SPAWN_LOG: sandbox.spawnLog,
			LSP_FIXTURE_EVENT_LOG: sandbox.eventLog,
			...(overrides.env ?? {}),
		},
	};
}

const ACTIVE_SANDBOXES: Sandbox[] = [];

/** Creates a sandbox that `cleanupAllSandboxes()` will reap in afterEach. */
export async function newSandbox(): Promise<Sandbox> {
	const sandbox = await createSandbox();
	ACTIVE_SANDBOXES.push(sandbox);
	return sandbox;
}

export async function cleanupAllSandboxes(): Promise<void> {
	const pending = ACTIVE_SANDBOXES.splice(0);
	for (const sandbox of pending) await cleanupSandbox(sandbox);
}

export async function readEvents(sandbox: Sandbox): Promise<string[]> {
	try {
		return (await readFile(sandbox.eventLog, "utf8")).split("\n").filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeUserConfig(sandbox: Sandbox, config: LspConfigFile): Promise<void> {
	await writeJsonFile(sandbox.configPath, config);
}

export async function writeProjectConfig(sandbox: Sandbox, config: LspConfigFile): Promise<string> {
	const path = join(sandbox.project, ".opencode", "lsp.json");
	await writeJsonFile(path, config);
	return path;
}

export async function writeRefusals(sandbox: Sandbox, refusals: RefusalFile | string): Promise<void> {
	if (typeof refusals === "string") {
		await mkdir(dirname(sandbox.refusalsPath), { recursive: true });
		await writeFile(sandbox.refusalsPath, refusals, "utf8");
		return;
	}
	await writeJsonFile(sandbox.refusalsPath, refusals);
}

export async function writeProjectFile(sandbox: Sandbox, relativePath: string, contents: string): Promise<string> {
	const path = join(sandbox.project, relativePath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents, "utf8");
	return path;
}

/** Marker file that gives the request context a workspace root for rename safety. */
export async function writeWorkspaceMarker(sandbox: Sandbox): Promise<void> {
	await writeFile(join(sandbox.project, "package.json"), '{ "name": "fixture-project", "private": true }\n', "utf8");
}

export function nodeBin(): string {
	const override = process.env["OPENCODE_LSP_NODE"];
	return override === undefined || override.length === 0 ? "node" : override;
}

function buildCliEnv(sandbox: Sandbox, options: SpawnOptions): NodeJS.ProcessEnv {
	const env: Record<string, string> = { ...sandbox.env, ...(options.env ?? {}) };
	if (options.configPath !== undefined) env["OPENCODE_LSP_CONFIG"] = options.configPath;
	if (options.refusalsPath !== undefined) env["OPENCODE_LSP_REFUSALS"] = options.refusalsPath;
	if (options.projectConfigPath !== undefined) env["OPENCODE_LSP_PROJECT_CONFIG"] = options.projectConfigPath;
	return { ...process.env, ...env };
}

export function spawnCli(sandbox: Sandbox, options: SpawnOptions = {}): ChildProcess {
	const child = spawn(nodeBin(), [CLI_PATH, "mcp"], {
		cwd: options.cwd ?? sandbox.project,
		env: buildCliEnv(sandbox, options),
		stdio: ["pipe", "pipe", "pipe"],
	});
	sandbox.children.push(child);
	return child;
}

export interface CliRunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export async function runCli(sandbox: Sandbox, args: string[], options: SpawnOptions = {}): Promise<CliRunResult> {
	const child = spawn(nodeBin(), [CLI_PATH, ...args], {
		cwd: options.cwd ?? sandbox.project,
		env: buildCliEnv(sandbox, options),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
	child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
	await new Promise<void>((resolveClose) => child.on("close", () => resolveClose()));
	return { code: child.exitCode, stdout, stderr };
}

export async function shutdownCli(sandbox: Sandbox, options: SpawnOptions = {}): Promise<CliRunResult> {
	return runCli(sandbox, ["shutdown"], options);
}

export async function waitForDaemonPids(sandbox: Sandbox, timeoutMs = 5000): Promise<number[]> {
	await waitingFor(async () => (await listOwnedDaemonPids(sandbox)).length > 0, timeoutMs);
	return listOwnedDaemonPids(sandbox);
}

export async function startSession(sandbox: Sandbox, options: SpawnOptions = {}): Promise<Session> {
	const child = spawnCli(sandbox, options);
	const client = connect(child);
	await client.initialize();
	return { client, child };
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

export async function waitingFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
	intervalMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
	}
}

async function forceKill(pid: number): Promise<void> {
	if (!isAlive(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	if (await waitingFor(() => !isAlive(pid), 1500)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return;
	}
	await waitingFor(() => !isAlive(pid), 1000);
}

export async function readSpawnedPids(sandbox: Sandbox): Promise<number[]> {
	try {
		const contents = await readFile(sandbox.spawnLog, "utf8");
		return contents
			.split("\n")
			.map((line) => Number.parseInt(line.trim(), 10))
			.filter((value) => Number.isInteger(value) && value > 0);
	} catch {
		return [];
	}
}

export async function listOwnedDaemonPids(sandbox: Sandbox): Promise<number[]> {
	const pids = new Set<number>();
	const drain = async (directory: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await drain(path);
				continue;
			}
			if (entry.name === "daemon.pid") {
				const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
				if (Number.isInteger(pid) && pid > 0) pids.add(pid);
				continue;
			}
			if (entry.name === "daemon.owner") {
				const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
				if (isRecord(parsed) && typeof parsed["pid"] === "number") pids.add(parsed["pid"]);
			}
		}
	};
	await drain(sandbox.stateDir);
	return [...pids];
}

export function cliInstalled(): boolean {
	return existsSync(CLI_PATH);
}

/** Terminates only processes this sandbox started, then removes the sandbox. */
export async function cleanupSandbox(sandbox: Sandbox): Promise<void> {
	for (const child of sandbox.children) {
		if (typeof child.pid === "number") await forceKill(child.pid);
	}
	const owned = new Set<number>([...(await readSpawnedPids(sandbox)), ...(await listOwnedDaemonPids(sandbox))]);
	for (const pid of owned) await forceKill(pid);
	await rm(sandbox.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMcpToolSchema(value: unknown): value is McpToolSchema {
	if (!isRecord(value) || typeof value["name"] !== "string") return false;
	const schema = value["inputSchema"];
	return isRecord(schema) && schema["type"] === "object";
}

export function isMcpToolResult(value: unknown): value is McpToolResult {
	if (!isRecord(value) || !Array.isArray(value["content"])) return false;
	for (const item of value["content"] as unknown[]) {
		if (!isRecord(item) || typeof item["type"] !== "string") return false;
	}
	return value["isError"] === undefined || typeof value["isError"] === "boolean";
}

function normalizeRpcError(value: unknown): JsonRpcErrorObject {
	if (isRecord(value) && typeof value["code"] === "number" && typeof value["message"] === "string") {
		return { code: value["code"], message: value["message"], ...(value["data"] === undefined ? {} : { data: value["data"] }) };
	}
	return { code: -32603, message: "malformed JSON-RPC error" };
}

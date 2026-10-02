/**
 * Attach-only stdio <-> TCP bridge to a running Godot editor language server.
 *
 * The bridge never owns the editor: LSP `shutdown`/`exit` are answered at this
 * boundary and never reach Godot. Connection failures are bounded and fatal so
 * the caller can respawn the bridge on its next tool call; there is no port
 * discovery, reconnection, or message replay.
 */
import { connect, Socket } from "node:net";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFrame, LspFrameReader, type LspMessage } from "./lsp-framing.ts";
import { createUriMapper, rewriteProtocolUris } from "./lsp-uri-mapping.ts";

export * from "./lsp-framing.ts";
export * from "./lsp-uri-mapping.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 6005;
export const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface GodotBridgeConfig {
  readonly host: string;
  readonly port: number;
  readonly projectUri?: string;
  readonly localRoot: string;
  readonly connectTimeoutMs: number;
}

export interface GodotBridgeIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface GodotBridgeHandle {
  stop(code?: number): void;
}

export interface GodotBridgeOptions {
  readonly config: GodotBridgeConfig;
  readonly io: GodotBridgeIo;
  readonly connectFn?: (host: string, port: number) => Socket;
  readonly exit?: (code: number) => void;
}

export function readGodotBridgeConfig(env: EnvLike, cwd: string): GodotBridgeConfig {
  const host = env.OPENCODE_LSP_GODOT_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.OPENCODE_LSP_GODOT_PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPENCODE_LSP_GODOT_PORT "${rawPort}": expected an integer 1-65535`);
  }
  const projectUri = env.OPENCODE_LSP_GODOT_PROJECT_URI?.trim();
  if (projectUri !== undefined && projectUri !== "" && !projectUri.startsWith("file:")) {
    throw new Error(`Invalid OPENCODE_LSP_GODOT_PROJECT_URI "${projectUri}": expected a file: URI`);
  }
  return {
    host,
    port,
    projectUri: projectUri ? projectUri : undefined,
    localRoot: resolve(cwd),
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
  };
}

export function startGodotBridge(options: GodotBridgeOptions): GodotBridgeHandle {
  const { config, io } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const connectFn = options.connectFn ?? ((host: string, port: number) => connect({ host, port }));
  const mapper = config.projectUri
    ? createUriMapper(pathToFileURL(config.localRoot).href, config.projectUri)
    : undefined;
  const warn = (message: string) => io.stderr.write(`[godot-bridge] ${message}\n`);

  let stopping = false;
  let connected = false;
  let shutdownReceived = false;
  let pendingBytes = 0;
  const pending: Buffer[] = [];

  const socket = connectFn(config.host, config.port);

  const finish = (code: number): void => {
    if (stopping) return;
    stopping = true;
    pending.length = 0;
    socket.removeAllListeners();
    socket.destroy();
    exit(code);
  };

  const fatal = (source: string, error: Error): void => {
    warn(`Fatal ${source} framing fault: ${error.message}`);
    finish(1);
  };

  const forwardToGodot = (message: LspMessage): void => {
    if (message.method === "shutdown" && message.id !== undefined) {
      shutdownReceived = true;
      io.stdout.write(encodeFrame({ jsonrpc: "2.0", id: message.id, result: null }));
      return;
    }
    if (message.method === "exit") {
      finish(shutdownReceived ? 0 : 1);
      return;
    }
    const outbound = mapper ? (rewriteProtocolUris(message, mapper.toRemote) as LspMessage) : message;
    const frame = encodeFrame(outbound);
    if (connected) {
      socket.write(frame);
      return;
    }
    pendingBytes += frame.byteLength;
    if (pendingBytes > MAX_PENDING_BYTES) {
      warn(`Refusing to buffer more than ${MAX_PENDING_BYTES} bytes before the Godot connection is established`);
      finish(1);
      return;
    }
    pending.push(frame);
  };

  const socketReader = new LspFrameReader(
    (message) => {
      const inbound = mapper ? (rewriteProtocolUris(message, mapper.toLocal) as LspMessage) : message;
      io.stdout.write(encodeFrame(inbound));
    },
    (error) => warn(`Ignoring malformed message from Godot: ${error.message}`),
    (error) => fatal("Godot", error),
  );
  const clientReader = new LspFrameReader(
    forwardToGodot,
    (error) => warn(`Ignoring malformed message from client: ${error.message}`),
    (error) => fatal("client", error),
  );

  io.stdin.on("data", (chunk: Buffer) => clientReader.push(chunk));
  io.stdin.on("end", () => finish(0));
  io.stdin.on("close", () => finish(0));
  io.stdin.on("error", (error: Error) => {
    warn(`Client stdin error: ${error.message}`);
    finish(1);
  });

  socket.setTimeout(config.connectTimeoutMs);
  socket.on("connect", () => {
    connected = true;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    pendingBytes = 0;
    for (const frame of pending.splice(0)) socket.write(frame);
  });
  socket.on("data", (chunk: Buffer) => socketReader.push(chunk));
  socket.on("timeout", () => {
    warn(
      `Timed out after ${config.connectTimeoutMs}ms connecting to Godot LSP at ${config.host}:${config.port}. ` +
        "Start the Godot editor, enable its language server (Editor Settings > Network > Language Server), and set OPENCODE_LSP_GODOT_HOST/PORT.",
    );
    finish(1);
  });
  socket.on("error", (error: Error) => {
    if (stopping) return;
    warn(
      connected
        ? `Godot LSP connection lost (${error.message}); exiting so the next tool call reconnects.`
        : `Cannot connect to Godot LSP at ${config.host}:${config.port} (${error.message}). Start the Godot editor with its language server enabled and set OPENCODE_LSP_GODOT_HOST/PORT.`,
    );
    finish(1);
  });
  socket.on("close", () => {
    if (stopping) return;
    warn("Godot LSP connection closed; exiting so the next tool call reconnects.");
    finish(1);
  });

  return { stop: (code?: number) => finish(code ?? 0) };
}

export function isEntrypoint(modulePath: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  return modulePath === resolve(argv1);
}

export function main(env: EnvLike = process.env, cwd: string = process.cwd()): void {
  let config: GodotBridgeConfig;
  try {
    config = readGodotBridgeConfig(env, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[godot-bridge] ${message}\n`);
    process.exitCode = 1;
    return;
  }
  startGodotBridge({ config, io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr } });
}

if (isEntrypoint(fileURLToPath(import.meta.url), process.argv[1])) {
  main();
}

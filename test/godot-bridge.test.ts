import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  createUriMapper,
  encodeFrame,
  isEntrypoint,
  LspFrameReader,
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  MAX_PENDING_BYTES,
  readGodotBridgeConfig,
  rewriteProtocolUris,
  startGodotBridge,
  type GodotBridgeConfig,
  type GodotBridgeHandle,
  type LspMessage,
} from "../src/godot-bridge";

interface Fixture {
  readonly port: number;
  readonly server: Server;
  readonly received: LspMessage[];
  readonly sockets: Socket[];
  close(): Promise<void>;
}

async function startFixture(
  respond?: (message: LspMessage, socket: Socket) => void,
  onConnect?: (socket: Socket) => void,
): Promise<Fixture> {
  const received: LspMessage[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    onConnect?.(socket);
    const reader = new LspFrameReader(
      (message) => {
        received.push(message);
        respond?.(message, socket);
      },
      () => {},
    );
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture failed to bind a TCP port");
  return {
    port: address.port,
    server,
    received,
    sockets,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => done());
      }),
  };
}

interface Harness {
  readonly bridge: GodotBridgeHandle;
  readonly stdin: PassThrough;
  readonly outMessages: LspMessage[];
  exited(): number | undefined;
  stderrText(): string;
}

function startHarness(port: number, overrides: Partial<GodotBridgeConfig> = {}): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outMessages: LspMessage[] = [];
  const reader = new LspFrameReader((message) => outMessages.push(message), () => {});
  stdout.on("data", (chunk: Buffer) => reader.push(chunk));
  let stderrText = "";
  stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  let exitCode: number | undefined;
  const config: GodotBridgeConfig = {
    host: "127.0.0.1",
    port,
    localRoot: resolve("/tmp/local-root"),
    connectTimeoutMs: 2000,
    ...overrides,
  };
  const bridge = startGodotBridge({
    config,
    io: { stdin, stdout, stderr },
    exit: (code) => {
      exitCode = code;
    },
  });
  return { bridge, stdin, outMessages, exited: () => exitCode, stderrText: () => stderrText };
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe("readGodotBridgeConfig", () => {
  test("applies defaults for host, port, and local root", () => {
    const config = readGodotBridgeConfig({}, "/tmp/project");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(6005);
    expect(config.projectUri).toBeUndefined();
    expect(config.localRoot).toBe(resolve("/tmp/project"));
  });

  test("reads host, port, and project URI overrides", () => {
    const config = readGodotBridgeConfig(
      {
        OPENCODE_LSP_GODOT_HOST: " 192.168.1.9 ",
        OPENCODE_LSP_GODOT_PORT: "7001",
        OPENCODE_LSP_GODOT_PROJECT_URI: "file:///srv/godot/project",
      },
      "/work",
    );
    expect(config.host).toBe("192.168.1.9");
    expect(config.port).toBe(7001);
    expect(config.projectUri).toBe("file:///srv/godot/project");
  });

  test("rejects an invalid port and a non-file project URI", () => {
    expect(() => readGodotBridgeConfig({ OPENCODE_LSP_GODOT_PORT: "nope" }, "/work")).toThrow(/PORT/);
    expect(() => readGodotBridgeConfig({ OPENCODE_LSP_GODOT_PROJECT_URI: "/srv/godot" }, "/work")).toThrow(/file:/);
  });
});

describe("createUriMapper", () => {
  test("maps both directions and respects containment boundaries", () => {
    const mapper = createUriMapper("file:///home/me/proj", "file:///srv/godot/proj");
    expect(mapper.toRemote("file:///home/me/proj")).toBe("file:///srv/godot/proj");
    expect(mapper.toRemote("file:///home/me/proj/main.gd")).toBe("file:///srv/godot/proj/main.gd");
    expect(mapper.toRemote("file:///home/me/proj-other/main.gd")).toBe("file:///home/me/proj-other/main.gd");
    expect(mapper.toRemote("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(mapper.toLocal("file:///srv/godot/proj/player.gd")).toBe("file:///home/me/proj/player.gd");
    expect(mapper.toLocal("file:///srv/godot/projish/player.gd")).toBe("file:///srv/godot/projish/player.gd");
  });
});

describe("rewriteProtocolUris", () => {
  const mapper = createUriMapper("file:///home/me/proj", "file:///srv/godot/proj");

  test("maps URI fields, WorkspaceEdit.changes keys, and nested locations", () => {
    const message: unknown = {
      method: "textDocument/rename",
      params: {
        textDocument: { uri: "file:///srv/godot/proj/player.gd" },
        newName: "Player",
      },
      result: {
        changes: {
          "file:///srv/godot/proj/player.gd": [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "Player" },
          ],
        },
        documentChanges: [
          { textDocument: { uri: "file:///srv/godot/proj/player.gd", version: 1 } },
          { kind: "rename", oldUri: "file:///srv/godot/proj/a.gd", newUri: "file:///srv/godot/proj/b.gd" },
        ],
      },
      relatedInformation: [{ location: { uri: "file:///srv/godot/proj/other.gd" } }],
    };
    const local = rewriteProtocolUris(message, mapper.toLocal) as {
      params: { textDocument: { uri: string } };
      result: {
        changes: Record<string, { newText: string }[]>;
        documentChanges: { textDocument?: { uri: string }; oldUri?: string; newUri?: string }[];
      };
      relatedInformation: { location: { uri: string } }[];
    };
    expect(local.params.textDocument.uri).toBe("file:///home/me/proj/player.gd");
    expect(Object.keys(local.result.changes)).toEqual(["file:///home/me/proj/player.gd"]);
    expect(local.result.documentChanges[0].textDocument?.uri).toBe("file:///home/me/proj/player.gd");
    expect(local.result.documentChanges[1].oldUri).toBe("file:///home/me/proj/a.gd");
    expect(local.result.documentChanges[1].newUri).toBe("file:///home/me/proj/b.gd");
    expect(local.relatedInformation[0].location.uri).toBe("file:///home/me/proj/other.gd");
  });

  test("leaves source text, newText, and non-URI strings byte-identical", () => {
    const remoteLiteral = "file:///srv/godot/proj/should-not-move.gd";
    const message: unknown = {
      params: { contentChanges: [{ text: remoteLiteral }], newName: remoteLiteral },
      result: {
        changes: {
          "file:///srv/godot/proj/player.gd": [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: remoteLiteral },
          ],
        },
      },
    };
    const local = rewriteProtocolUris(message, mapper.toLocal) as {
      params: { contentChanges: { text: string }[]; newName: string };
      result: { changes: Record<string, { newText: string }[]> };
    };
    expect(local.params.contentChanges[0].text).toBe(remoteLiteral);
    expect(local.params.newName).toBe(remoteLiteral);
    expect(local.result.changes["file:///home/me/proj/player.gd"][0].newText).toBe(remoteLiteral);

    const localLiteral = "file:///home/me/proj/source.gd";
    const up = rewriteProtocolUris({ params: { contentChanges: [{ text: localLiteral }] } }, mapper.toRemote) as {
      params: { contentChanges: { text: string }[] };
    };
    expect(up.params.contentChanges[0].text).toBe(localLiteral);
  });

  test("keeps out-of-root edit URIs unmapped for the runtime to reject", () => {
    const outside = "file:///elsewhere/other.gd";
    const toLocal = rewriteProtocolUris({ changes: { [outside]: [] } }, mapper.toLocal) as {
      changes: Record<string, unknown>;
    };
    expect(Object.keys(toLocal.changes)).toEqual([outside]);
    const toRemote = rewriteProtocolUris({ changes: { [outside]: [] } }, mapper.toRemote) as {
      changes: Record<string, unknown>;
    };
    expect(Object.keys(toRemote.changes)).toEqual([outside]);
  });
});

describe("LspFrameReader", () => {
  test("reassembles split frames and multiple frames in one chunk", () => {
    const messages: LspMessage[] = [];
    const errors: Error[] = [];
    const reader = new LspFrameReader(
      (message) => messages.push(message),
      (error) => errors.push(error),
    );
    const joined = Buffer.concat([
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      encodeFrame({ jsonrpc: "2.0", method: "initialized" }),
    ]);
    reader.push(joined.subarray(0, 5));
    expect(messages).toHaveLength(0);
    reader.push(joined.subarray(5, joined.length - 3));
    reader.push(joined.subarray(joined.length - 3));
    expect(messages.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    expect(errors).toHaveLength(0);
  });

  test("rejects a Content-Length past the frame bound and stops reading", () => {
    const messages: LspMessage[] = [];
    const fatal: Error[] = [];
    const reader = new LspFrameReader(
      (message) => messages.push(message),
      () => {},
      (error) => fatal.push(error),
    );
    reader.push(Buffer.from(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n`, "ascii"));
    expect(fatal).toHaveLength(1);
    reader.push(encodeFrame({ jsonrpc: "2.0", method: "ignored-after-fatal" }));
    expect(messages).toHaveLength(0);
  });

  test("rejects an overflowing Content-Length", () => {
    const fatal: Error[] = [];
    const reader = new LspFrameReader(
      () => {},
      () => {},
      (error) => fatal.push(error),
    );
    reader.push(Buffer.from(`Content-Length: ${"9".repeat(40)}\r\n\r\n`, "ascii"));
    expect(fatal).toHaveLength(1);
  });

  test("rejects a header that grows past the header bound", () => {
    const fatal: Error[] = [];
    const reader = new LspFrameReader(
      () => {},
      () => {},
      (error) => fatal.push(error),
    );
    reader.push(Buffer.alloc(MAX_HEADER_BYTES + 1, 0x41));
    expect(fatal).toHaveLength(1);
  });

  test("drops an array body without becoming fatal and keeps reading", () => {
    const messages: LspMessage[] = [];
    const errors: Error[] = [];
    const fatal: Error[] = [];
    const reader = new LspFrameReader(
      (message) => messages.push(message),
      (error) => errors.push(error),
      (error) => fatal.push(error),
    );
    reader.push(encodeFrame([1, 2, 3]));
    expect(errors).toHaveLength(1);
    expect(fatal).toHaveLength(0);
    reader.push(encodeFrame({ jsonrpc: "2.0", method: "still-works" }));
    expect(messages.map((message) => message.method)).toEqual(["still-works"]);
  });
});

describe("isEntrypoint", () => {
  test("matches the resolved module path against argv[1]", () => {
    const modulePath = resolve("/tmp/entry.js");
    expect(isEntrypoint(modulePath, "/tmp/entry.js")).toBe(true);
    expect(isEntrypoint(modulePath, "/tmp/other.js")).toBe(false);
    expect(isEntrypoint(modulePath, undefined)).toBe(false);
    expect(isEntrypoint(modulePath, "")).toBe(false);
  });

  test("resolves a relative argv[1] against the working directory", () => {
    expect(isEntrypoint(resolve("entry.js"), "entry.js")).toBe(true);
  });

  test("uses explicit .ts relative specifiers so Node can run the source directly", async () => {
    for (const file of ["godot-bridge.ts", "lsp-framing.ts", "lsp-uri-mapping.ts"]) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
      for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        expect(match[1].endsWith(".ts")).toBe(true);
      }
    }
  });
});

describe("startGodotBridge", () => {
  test("forwards the initialize handshake and maps URIs in both directions", async () => {
    const localRoot = resolve("/tmp/godot-local");
    const remote = "file:///srv/godot/project";
    const fixture = await startFixture((message, socket) => {
      if (message.method !== "initialize") return;
      socket.write(encodeFrame({ jsonrpc: "2.0", id: message.id, result: { capabilities: { hoverProvider: true } } }));
      socket.write(
        encodeFrame({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: `${remote}/player.gd`, diagnostics: [] } }),
      );
    });
    try {
      const harness = startHarness(fixture.port, { localRoot, projectUri: remote });
      const localRootUri = pathToFileURL(localRoot).href;
      harness.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: localRootUri } }));
      const response = await waitFor(() => harness.outMessages.find((message) => message.id === 1));
      const capabilities = (response.result as { capabilities: { hoverProvider: boolean } }).capabilities;
      expect(capabilities.hoverProvider).toBe(true);
      const diagnostics = await waitFor(() =>
        harness.outMessages.find((message) => message.method === "textDocument/publishDiagnostics"),
      );
      expect((diagnostics.params as { uri: string }).uri).toBe(`${localRootUri}/player.gd`);
      const forwarded = fixture.received.find((message) => message.method === "initialize");
      expect((forwarded?.params as { rootUri: string }).rootUri).toBe(remote);
      harness.bridge.stop(0);
    } finally {
      await fixture.close();
    }
  });

  test("fails fast with actionable stderr when the editor is unavailable", async () => {
    const fixture = await startFixture();
    const port = fixture.port;
    await fixture.close();
    const harness = startHarness(port, { connectTimeoutMs: 2000 });
    const started = Date.now();
    const code = await waitFor(() => harness.exited(), 3000);
    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(harness.stderrText()).toContain(String(port));
    expect(harness.stderrText()).toMatch(/Godot|editor/i);
  });

  test("bounds the initial connect attempt by the configured timeout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrText = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    let exitCode: number | undefined;
    const config: GodotBridgeConfig = {
      host: "127.0.0.1",
      port: 9,
      localRoot: "/tmp/local-root",
      connectTimeoutMs: 120,
    };
    startGodotBridge({
      config,
      io: { stdin, stdout, stderr },
      connectFn: () => new Socket(),
      exit: (code) => {
        exitCode = code;
      },
    });
    const started = Date.now();
    const code = await waitFor(() => exitCode, 2000);
    const elapsed = Date.now() - started;
    expect(code).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1500);
    expect(stderrText).toMatch(/Timed out/);
  });

  test("bounds the pre-connect pending queue instead of buffering without limit", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrText = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    let exitCode: number | undefined;
    const config: GodotBridgeConfig = {
      host: "127.0.0.1",
      port: 9,
      localRoot: "/tmp/local-root",
      connectTimeoutMs: 30000,
    };
    startGodotBridge({
      config,
      io: { stdin, stdout, stderr },
      connectFn: () => new Socket(),
      exit: (code) => {
        exitCode = code;
      },
    });
    stdin.write(encodeFrame({ method: "textDocument/didChange", params: { pad: "a".repeat(MAX_PENDING_BYTES) } }));
    expect(await waitFor(() => exitCode, 3000)).toBe(1);
    expect(stderrText).toMatch(/buffer/i);
  });

  test("fails bounded when the editor sends an unparseable frame", async () => {
    const fixture = await startFixture(undefined, (socket) => {
      socket.write(Buffer.from("Content-Length: 99999999999999999999\r\n\r\n", "ascii"));
    });
    try {
      const harness = startHarness(fixture.port);
      expect(await waitFor(() => harness.exited(), 2000)).toBe(1);
      expect(harness.stderrText()).toMatch(/framing|Content-Length/i);
    } finally {
      await fixture.close();
    }
  });

  test("answers shutdown and exit locally so the editor never sees them", async () => {
    const fixture = await startFixture();
    try {
      const harness = startHarness(fixture.port);
      harness.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 7, method: "shutdown" }));
      const ack = await waitFor(() => harness.outMessages.find((message) => message.id === 7));
      expect(ack.result).toBeNull();
      expect(fixture.received.some((message) => message.method === "shutdown")).toBe(false);
      harness.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "exit" }));
      expect(await waitFor(() => harness.exited(), 2000)).toBe(0);
      expect(fixture.received.some((message) => message.method === "exit")).toBe(false);
      expect(fixture.server.listening).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  test("shuts down cleanly and releases the editor socket when client stdin ends", async () => {
    const fixture = await startFixture();
    try {
      const harness = startHarness(fixture.port);
      await waitFor(() => (fixture.sockets.length > 0 ? true : undefined));
      harness.stdin.end();
      expect(await waitFor(() => harness.exited(), 2000)).toBe(0);
      expect(fixture.server.listening).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  test("never spawns or kills the external editor process", async () => {
    const source = await readFile(new URL("../src/godot-bridge.ts", import.meta.url), "utf8");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain(".kill(");
    const fixture = await startFixture();
    try {
      const harness = startHarness(fixture.port);
      await waitFor(() => (fixture.sockets.length > 0 ? true : undefined));
      harness.bridge.stop(0);
      expect(await waitFor(() => harness.exited(), 2000)).toBe(0);
      expect(fixture.server.listening).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

describe("godot-bridge entry process", () => {
  test("proxies a real TCP roundtrip through the actual bridge child process", async () => {
    const localRoot = process.cwd();
    const remote = "file:///srv/godot/project";
    const fixture = await startFixture((message, socket) => {
      if (message.method !== "initialize") return;
      socket.write(encodeFrame({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } }));
    });
    const child = spawn(process.execPath, [resolve("src/godot-bridge.ts")], {
      cwd: localRoot,
      env: {
        ...process.env,
        OPENCODE_LSP_GODOT_HOST: "127.0.0.1",
        OPENCODE_LSP_GODOT_PORT: String(fixture.port),
        OPENCODE_LSP_GODOT_PROJECT_URI: remote,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const outMessages: LspMessage[] = [];
      const reader = new LspFrameReader((message) => outMessages.push(message), () => {});
      child.stdout.on("data", (chunk: Buffer) => reader.push(chunk));
      let childStderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        childStderr += chunk.toString("utf8");
      });
      const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));

      child.stdin.write(
        encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: pathToFileURL(localRoot).href } }),
      );
      const response = await waitFor(() => outMessages.find((message) => message.id === 1), 8000);
      const capabilities = (response.result as { capabilities: { definitionProvider: boolean } }).capabilities;
      expect(capabilities.definitionProvider).toBe(true);
      const forwarded = fixture.received.find((message) => message.method === "initialize");
      expect((forwarded?.params as { rootUri: string }).rootUri).toBe(remote);

      child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 2, method: "shutdown" }));
      expect((await waitFor(() => outMessages.find((message) => message.id === 2), 4000)).result).toBeNull();
      child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "exit" }));
      expect(await exited).toBe(0);
      expect(fixture.received.some((message) => message.method === "shutdown" || message.method === "exit")).toBe(false);
      expect(childStderr).not.toMatch(/Cannot connect|Timed out|error/i);
      expect(fixture.server.listening).toBe(true);
    } finally {
      child.kill();
      await fixture.close();
    }
  });
});

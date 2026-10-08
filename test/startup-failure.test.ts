import { afterEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  cleanupAllSandboxes,
  isRecord,
  newSandbox,
  startSession,
  writeProjectFile,
  writeUserConfig,
  type McpClient,
  type McpToolResult,
} from "./mcp-client";

afterEach(cleanupAllSandboxes);

async function boundaryProbe(mode: string): Promise<Record<string, unknown>> {
  const sandbox = await newSandbox();
  const fixture = fileURLToPath(new URL("./fixtures/startup-boundary.mjs", import.meta.url));
  const child = Bun.spawn(["node", fixture, mode, sandbox.project], {
    env: { ...process.env, ...sandbox.env }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const value: unknown = JSON.parse(stdout);
  if (!isRecord(value)) throw new Error("Invalid startup-boundary receipt");
  return value;
}

async function promptDiagnostics(client: McpClient, filePath: string): Promise<McpToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.call("diagnostics", { filePath }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Startup failure did not return within 5 seconds")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("language-server startup failures", () => {
  it("preserves a healthy server's JSON-RPC error mentioning EPIPE", async () => {
    const result = await boundaryProbe("remote-error");
    expect(result["name"]).toBe("JsonRpcError(-32603)");
    expect(result["message"]).toBe("Upstream socket write EPIPE; server remains healthy");
    expect(result["alive"]).toBe(true);
    expect(result["events"]).toEqual([]);
  });

  it("settles close-during-write promptly without unhandled promise or stream errors", async () => {
    const result = await boundaryProbe("close-write");
    expect(result["settledAfterClose"]).toBe(true);
    expect(result["events"]).toEqual([]);
    expect(result["writerErrorListeners"]).toBe(0);
  });

  it("reports a missing runtime behind an existing launcher without waiting for the RPC timeout", async () => {
    const sandbox = await newSandbox();
    await writeUserConfig(sandbox, {
      lsp: {
        "missing-runtime": {
          command: [process.execPath, "-e", 'process.stderr.write("Language-server dependency is not installed in this environment.\\n"); process.exit(127);'],
          extensions: [".testlang"],
        },
      },
    });
    const file = await writeProjectFile(sandbox, "missing.testlang", "content\n");
    const { client } = await startSession(sandbox);
    const result = await promptDiagnostics(client, file);
    const message = client.resultText(result);
    expect(result.isError).toBe(true);
    expect(message).toContain("missing-runtime");
    expect(message).toContain("dependency is not installed");
    expect(message).not.toMatch(/timed out|request timeout|No diagnostics found/i);
    await client.close();
  });

  it("reports an ordinary startup crash without claiming the server was not installed", async () => {
    const sandbox = await newSandbox();
    await writeUserConfig(sandbox, {
      lsp: {
        "crashing-server": {
          command: [process.execPath, "-e", 'process.stderr.write("Invalid fixture startup configuration.\\n"); process.exit(2);'],
          extensions: [".testlang"],
        },
      },
    });
    const file = await writeProjectFile(sandbox, "crashed.testlang", "content\n");
    const { client } = await startSession(sandbox);
    const result = await promptDiagnostics(client, file);
    const message = client.resultText(result);
    expect(result.isError).toBe(true);
    expect(message).toContain("crashing-server");
    expect(message).toContain("Invalid fixture startup configuration");
    expect(message).not.toMatch(/NOT INSTALLED|ASK THE USER|timed out|request timeout/i);
    await client.close();
  });
});

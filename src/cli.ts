import { configureRuntime, openCodeConfig } from "./config.js";
import { shutdownDaemon } from "./shutdown.js";
import { callToolViaDaemon, createStandaloneMcpRequestContext, daemonPaths, runDaemon, runMcpStdioProxy } from "./vendor-runtime.js";

async function main(): Promise<void> {
  const [command = "mcp", ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log("opencode-lsp [mcp | doctor | verify <file> | config v2|v1 | shutdown | --version]\n" +
      "mcp: stdio MCP (default). config: print configuration, never edit user files.\n" +
      "doctor: show language-server availability. verify: real diagnostics roundtrip.\n" +
      "shutdown: stop this user's/configuration's shared LSP daemon, not Godot.\n" +
      "OPENCODE_LSP_HOME/CONFIG/REFUSALS: optional absolute locations.");
    return;
  }
  if (command === "config") {
    if (args.length !== 1 || (args[0] !== "v1" && args[0] !== "v2")) throw new Error("Usage: opencode-lsp config v2|v1");
    console.log(JSON.stringify(openCodeConfig(args[0]), null, 2));
    return;
  }
  if (!["mcp", "daemon", "doctor", "verify", "shutdown", "--version"].includes(command)) {
    throw new Error(`Unknown command: ${command}. Use --help.`);
  }
  if ((command !== "verify" && args.length) || (command === "verify" && args.length !== 1)) {
    throw new Error("Usage: opencode-lsp verify <file>, or --help");
  }
  const config = configureRuntime();
  if (command === "--version") { console.log(config.version); return; }
  const paths = daemonPaths();
  if (command === "daemon") { await runDaemon(); return; }
  if (command === "shutdown") {
    console.log(await shutdownDaemon(paths) ? "LSP daemon stopped." : "LSP daemon was not running.");
    return;
  }
  const context = createStandaloneMcpRequestContext({ cwd: config.project });
  if (command === "mcp") { await runMcpStdioProxy({ context, paths }); return; }
  const result = await callToolViaDaemon(command === "doctor" ? "status" : "diagnostics",
    command === "doctor" ? {} : { filePath: args[0], severity: "all" },
    { paths, context, requestTimeoutMs: 90000, signal: AbortSignal.timeout(95000) });
  console.log(JSON.stringify(result, null, 2));
  if (result.isError || result.details?.errorKind || result.details?.transientError) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

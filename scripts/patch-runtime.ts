import ts from "typescript";

export function patchRuntime(original: string): string {
  let source = original;
  const replaceOnce = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error(`Vendor anchor drift: ${from.slice(0, 80)}`);
    source = source.replace(from, to);
  };
  const replaceFunction = (name: string, body: string) => {
    const ast = ts.createSourceFile("runtime.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const matches = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1) throw new Error(`Vendor function drift: ${name}`);
    const node = matches[0];
    source = source.slice(0, node.getStart(ast)) + body + source.slice(node.end);
  };
  const boot = source.lastIndexOf("main().catch((error) => {");
  if (boot < 0 || source.indexOf("main().catch((error) => {") !== boot) throw new Error("Vendor boot drift");
  source = source.slice(0, boot);
  replaceFunction("main", "");
  replaceFunction("formatNotInstalled", "function formatNotInstalled(result) { return missingServerGuidance(result, lspRequestContext().installDecisionsPath); }");
  replaceFunction("loadInstallDecision", "function loadInstallDecision(serverId) { return declinedServers(lspRequestContext().installDecisionsPath).includes(serverId) ? { decision: 'declined' } : undefined; }");
  replaceFunction("resolveReadablePathInsideContext", `function resolveReadablePathInsideContext(filePath) {
    const root = contextCwd();
    const target = canonicalizeExistingOrNearestAncestor(standaloneResolve(root, filePath));
    if (!standaloneIsAbsolute(filePath) && !isPathInside(root, target)) throw new LspInvalidPathError("Relative LSP paths must remain inside request cwd: " + filePath);
    return target;
  }`);
  replaceFunction("resolvePathInsideContext", "function resolvePathInsideContext(filePath) { return resolveReadablePathInsideContext(filePath); }");
  replaceFunction("findWorkspaceRoot", `function findWorkspaceRoot(filePath) {
    const target = resolveReadablePathInsideContext(filePath);
    const start = isDirectoryPath(target) ? target : standaloneDirname(target);
    const boundary = contextCwd();
    const confined = isPathInside(boundary, target);
    let cursor = start;
    while (!confined || isPathInside(boundary, cursor)) {
      if (WORKSPACE_MARKERS.some(marker => standaloneExists(standaloneJoin(cursor, marker)))) return cursor;
      const parent = standaloneDirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return start;
  }`);
  const toolsStart = source.indexOf("  {\n    name: \"format\",", source.indexOf("var LSP_MCP_TOOLS = ["));
  const toolsEnd = source.indexOf("\n];", toolsStart);
  if (toolsStart < 0 || toolsEnd < toolsStart) throw new Error("Vendor tool list drift");
  source = source.slice(0, toolsStart) + source.slice(toolsEnd);
  replaceOnce('var BUILTIN_SERVERS = {', 'var BUILTIN_SERVERS = {\n  gdscript: { command: [process.execPath, standaloneFilePath(new URL("./godot-bridge.js", import.meta.url))], extensions: [".gd"] },');
  replaceOnce('var PROJECT_WORKSPACE_MARKERS = [', 'var PROJECT_WORKSPACE_MARKERS = [\n  "project.godot",');
  replaceOnce('var MAX_RESIDENT_CLIENTS = 6;', 'var MAX_RESIDENT_CLIENTS = Number.POSITIVE_INFINITY;');
  replaceOnce('  async stopAll() {', '  stopAll() { return this.stopAllPromise ??= this.stopAllOnce(); }\n  async stopAllOnce() {');
  replaceOnce('    const state = server.disabled ? "disabled" : server.installed ? "installed" : "missing";', '    const state = server.disabled ? "disabled" : server.installed ? (server.id === "gdscript" ? "bridge-installed (Godot editor not probed)" : "installed") : "missing";');
  replaceOnce('`Configure a custom server in \'${firstProjectConfigPath}\' or \'${context.userConfigPath}\':`', '`Configure a custom server in the USER configuration \'${context.userConfigPath}\' (project files may only tune builtin servers):`');
  replaceOnce('  if (authenticated.method === "$/cancelRequest") {', '  if (authenticated.method === "opencode/shutdown") {\n    setImmediate(() => process.emit("SIGTERM", "SIGTERM"));\n    return Promise.resolve({ jsonrpc: "2.0", id: authenticated.id, result: { stopped: true } });\n  }\n  if (authenticated.method === "$/cancelRequest") {');
  source = source.replaceAll('installDecisionTool: true', 'installDecisionTool: false');
  source = source.replaceAll('OMO_LSP_DAEMON_', 'OPENCODE_LSP_DAEMON_');
  source = source.replaceAll('".omo", "lsp-daemon"', '".config", "opencode-lsp", "daemon"');
  source = source.replaceAll('omo-lsp-', 'opencode-lsp-');
  source = source.replaceAll('".codex", "lsp-client.json"', '".opencode", "lsp.json"');
  source = source.replaceAll('".codex/lsp-client.json"', '".config/opencode-lsp/lsp.json"');
  source = source.replaceAll('".codex/lsp-install-decisions.json"', '".config/opencode-lsp/refusals.json"');
  source = source.replaceAll('".codex", "lsp-install-decisions.json"', '".config", "opencode-lsp", "refusals.json"');
  const exports = "runMcpStdioProxy, runDaemon, daemonPaths, probeDaemon, pingDaemon, readAuthToken, authEnvelope, createStandaloneMcpRequestContext, callToolViaDaemon, LSP_MCP_TOOLS";
  return '// Adapted from the pinned MIT runtime; see NOTICE and vendor/provenance.json.\n' +
    'import { missingServerGuidance, declinedServers } from "./install-guidance.js";\n' +
    'import { fileURLToPath as standaloneFilePath } from "node:url";\n' +
    'import { resolve as standaloneResolve, isAbsolute as standaloneIsAbsolute, dirname as standaloneDirname, join as standaloneJoin } from "node:path";\n' +
    'import { existsSync as standaloneExists } from "node:fs";\n' +
    source.replace(/^#!.*\n/, "") + `\nexport { ${exports} };\n`;
}

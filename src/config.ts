import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface RuntimeManifest { version: string; fingerprint: string }

export function configureRuntime(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const root = absolute(env.OPENCODE_LSP_HOME, defaultHome(env));
  const project = realpathSync(cwd);
  const userConfig = absolute(env.OPENCODE_LSP_CONFIG, join(root, "lsp.json"));
  const refusals = absolute(env.OPENCODE_LSP_REFUSALS, join(root, "refusals.json"));
  const projectConfigs = env.OPENCODE_LSP_PROJECT_CONFIG ?? [
    join(project, ".opencode", "lsp.json"),
    join(project, ".omo", "lsp.json"),
    join(project, ".omo", "lsp-client.json"),
  ].join(delimiter);
  const manifest: RuntimeManifest = JSON.parse(readFileSync(new URL("./runtime-manifest.json", import.meta.url), "utf8"));
  const godotEndpoint = [env.OPENCODE_LSP_GODOT_HOST?.trim() || "127.0.0.1", Number(env.OPENCODE_LSP_GODOT_PORT?.trim() || "6005"), env.OPENCODE_LSP_GODOT_PROJECT_URI?.trim() || null];
  const configDomain = createHash("sha256").update(JSON.stringify([userConfig, refusals, process.execPath, env.PATH, godotEndpoint])).digest("hex").slice(0, 16);
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const runtimeEnv = {
    LSP_TOOLS_MCP_CWD: project,
    LSP_TOOLS_MCP_PROJECT_CONFIG: projectConfigs,
    LSP_TOOLS_MCP_USER_CONFIG: userConfig,
    LSP_TOOLS_MCP_INSTALL_DECISIONS: refusals,
    OPENCODE_LSP_DAEMON_DIR: join(root, "daemon", configDomain),
    OPENCODE_LSP_DAEMON_CLI: cli,
    OPENCODE_LSP_DAEMON_VERSION: `${manifest.version}-${manifest.fingerprint}`,
  };
  Object.assign(env, runtimeEnv);
  return { root, userConfig, refusals, project, runtimeEnv, version: manifest.version };
}

function absolute(value: string | undefined, fallback: string): string {
  if (value === undefined) return resolve(fallback);
  if (!isAbsolute(value)) throw new Error("OPENCODE_LSP paths must be absolute.");
  return resolve(value);
}

function defaultHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode-lsp");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode-lsp");
}

export function openCodeConfig(version: "v1" | "v2") {
  const command = [process.execPath, fileURLToPath(new URL("../bin/opencode-lsp.js", import.meta.url)), "mcp"];
  const skills = fileURLToPath(new URL("../skills", import.meta.url));
  return version === "v2"
    ? { skills: [skills], mcp: { servers: { lsp: { type: "local", command, codemode: false } } } }
    : { skills: { paths: [skills] }, mcp: { lsp: { type: "local", command, enabled: true } } };
}

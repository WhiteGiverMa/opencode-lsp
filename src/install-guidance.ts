import { readFileSync } from "node:fs";

export interface MissingServer {
  server: { id: string; command: string[]; extensions: string[] };
  installHint: string;
}

export function declinedServers(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid refusal JSON at ${path}. Preserve the file and ask the user to correct it.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid refusal configuration at ${path}: expected an object.`);
  }
  const ids = Reflect.get(value, "declined_servers");
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
    throw new Error(`Invalid declined_servers at ${path}: expected an array of server IDs. Do not overwrite it.`);
  }
  return ids;
}

export function missingServerGuidance(result: MissingServer, path: string): string {
  const { server, installHint } = result;
  const header = `LSP server '${server.id}' (${server.extensions.join(", ")}) is NOT INSTALLED.`;
  if (declinedServers(path).includes(server.id)) {
    return `${header} The user previously declined installation. Do not ask again; proceed without LSP unless the user explicitly requests installation.`;
  }
  return [
    header,
    `Command not found: ${server.command[0]}`,
    `Installation hint (verify it for this platform): ${installHint}`,
    "If LSP is needed, ASK THE USER for approval before installing. After explicit approval, install and retry this tool.",
    `If the user explicitly declines, read ${path} and append ${JSON.stringify(server.id)} to its declined_servers array, preserving all existing fields and entries. Create the file only if it does not exist.`,
    `Minimal example: ${JSON.stringify({ declined_servers: [server.id] })}`,
    "Do not record a refusal merely because the user has not answered. The MCP server never installs software or writes this decision file.",
  ].join("\n");
}

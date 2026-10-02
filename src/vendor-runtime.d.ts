export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}
export interface RequestContext {
  cwd: string;
  projectConfigPaths: string[];
  userConfigPath: string;
  installDecisionsPath: string;
  capabilities: { installDecisionTool: boolean };
}
export interface DaemonPaths {
  version: string;
  cliPath: string;
  dir: string;
  socket: string;
  lock: string;
  pid: string;
  auth: string;
  owner: string;
  endpoint: string;
  log: string;
}
export interface DaemonOwner {
  pid: number;
  nonce: string;
  startedAt: string;
  endpoint: { kind: string; path: string; dev?: number; ino?: number };
}
export const LSP_MCP_TOOLS: Array<{
  name: string;
  aliases: string[];
  description: string;
  inputSchema: Record<string, unknown>;
}>;
export function runMcpStdioProxy(options: { context: RequestContext; paths: DaemonPaths }): Promise<void>;
export function runDaemon(): Promise<void>;
export function daemonPaths(): DaemonPaths;
export function probeDaemon(paths: DaemonPaths, timeoutMs?: number): Promise<boolean>;
export function pingDaemon(paths: DaemonPaths, token: string, timeoutMs?: number): Promise<DaemonOwner | null>;
export function readAuthToken(paths: DaemonPaths): string | null;
export function authEnvelope(token: string): { protocolVersion: number; token: string };
export function createStandaloneMcpRequestContext(input?: { cwd?: string; env?: NodeJS.ProcessEnv }): RequestContext;
export function callToolViaDaemon(name: string, args: Record<string, unknown>, options: {
  paths: DaemonPaths;
  context: RequestContext;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}): Promise<ToolResult>;

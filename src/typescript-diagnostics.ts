import { parseTypeScriptDiagnostics, type TypeScriptDiagnostic } from "./typescript-diagnostic-response";

interface Snapshot { path: string; version: number; documentGeneration: number }
type SendRequest = (method: string, params: Record<string, unknown>, options: { timeoutMs: number; signal: AbortSignal }) => Promise<unknown>;
interface Flight {
  controller: AbortController;
  promise: Promise<TypeScriptDiagnostic[]>;
  waiters: number;
  done: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function supportsTypeScriptDiagnostics(capabilities: unknown): boolean {
  if (!record(capabilities) || !record(capabilities.executeCommandProvider)) return false;
  const commands = capabilities.executeCommandProvider.commands;
  return Array.isArray(commands) && commands.includes("typescript.tsserverRequest");
}
export class TypeScriptDiagnosticsTimeout extends Error {
  constructor() { super("TypeScript diagnostic freshness deadline expired"); }
}
export class TypeScriptDiagnosticsRequester {
  private readonly flights = new Map<string, Flight>();
  private readonly commands: string[];
  constructor(private readonly send: SendRequest, private readonly now: () => number, initialization: unknown) {
    const disableSuggestions = record(initialization) && record(initialization.preferences) && initialization.preferences.disableSuggestions === true;
    this.commands = ["syntacticDiagnosticsSync", "semanticDiagnosticsSync", ...disableSuggestions ? [] : ["suggestionDiagnosticsSync"]];
  }
  async query(snapshot: Snapshot, deadline: number, signal?: AbortSignal): Promise<TypeScriptDiagnostic[]> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.now() >= deadline) throw new TypeScriptDiagnosticsTimeout();
      const key = `${snapshot.path}\0${snapshot.version}\0${snapshot.documentGeneration}`;
      let flight = this.flights.get(key);
      if (!flight) {
        const controller = new AbortController();
        const created: Flight = { controller, waiters: 0, done: false,
          promise: this.fetch(snapshot.path, deadline, controller.signal).finally(() => {
            created.done = true;
            controller.abort();
            if (this.flights.get(key) === created) this.flights.delete(key);
          })
        };
        this.flights.set(key, created);
        flight = created;
      }
      try {
        return await this.waitForFlight(key, flight, deadline, signal);
      } catch (error) {
        signal?.throwIfAborted();
        const timedOut = error instanceof TypeScriptDiagnosticsTimeout || error instanceof Error && error.name === "LspRequestTimeoutError";
        if (!timedOut || this.now() >= deadline) throw error;
      }
    }
  }
  private waitForFlight(key: string, flight: Flight, deadline: number, signal?: AbortSignal): Promise<TypeScriptDiagnostic[]> {
    flight.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        flight.waiters -= 1;
        if (!flight.done && flight.waiters === 0) {
          if (this.flights.get(key) === flight) this.flights.delete(key);
          flight.controller.abort();
        }
      };
      const onAbort = () => {
        if (settled) return;
        release();
        reject(signal?.reason ?? new DOMException("LSP diagnostics cancelled", "AbortError"));
      };
      const onTimeout = () => {
        if (settled) return;
        release(); reject(new TypeScriptDiagnosticsTimeout());
      };
      const timer = setTimeout(onTimeout, Math.max(0, deadline - this.now()));
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(value => {
        if (settled) return;
        if (this.now() >= deadline) { onTimeout(); return; }
        release(); resolve(value);
      }, error => {
        if (settled) return;
        release(); reject(error);
      });
      if (signal?.aborted) onAbort();
    });
  }
  private async fetch(file: string, deadline: number, signal: AbortSignal): Promise<TypeScriptDiagnostic[]> {
    const results = await Promise.all(this.commands.map(async command => {
      signal.throwIfAborted();
      const timeoutMs = deadline - this.now();
      if (timeoutMs <= 0) throw new TypeScriptDiagnosticsTimeout();
      const reply = await this.send("workspace/executeCommand", {
        command: "typescript.tsserverRequest",
        arguments: [command, { file, includeLinePosition: true }, { executionTarget: 0, expectsResult: true, isAsync: false, lowPriority: false }],
      }, { timeoutMs, signal });
      return parseTypeScriptDiagnostics(reply, command);
    }));
    return results.flat();
  }
}

import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

const runtime: typeof import("../src/typescript-diagnostics") = process.env.LSP_TEST_DIAGNOSTIC_MODULE
  ? await import(pathToFileURL(process.env.LSP_TEST_DIAGNOSTIC_MODULE).href)
  : await import("../src/typescript-diagnostics");
const { TypeScriptDiagnosticsRequester, TypeScriptDiagnosticsTimeout } = runtime;

function requester(delay: number) {
  return new TypeScriptDiagnosticsRequester((_method, params, options) => new Promise((resolve, reject) => {
    let settled = false;
    const argumentsList = Array.isArray(params.arguments) ? params.arguments : [];
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(reply); clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ type: "response", success: true, command: argumentsList[0], body: [] });
    };
    const abort = () => finish(options.signal.reason);
    const reply = setTimeout(() => finish(), delay);
    const timeout = setTimeout(() => finish(new TypeScriptDiagnosticsTimeout()), options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
  }), Date.now, {});
}
const snapshot = { path: "/fixture.ts", version: 1, documentGeneration: 1 };
test("a shorter-budget waiter expires without cancelling the longer caller", async () => {
  const client = requester(250);
  const start = Date.now();
  const longer = client.query(snapshot, start + 1500);
  const shorter = client.query(snapshot, start + 80).catch(error => error);
  expect(await shorter).toBeInstanceOf(TypeScriptDiagnosticsTimeout);
  expect(Date.now() - start).toBeLessThan(220);
  expect(await longer).toEqual([]);
});
test("a longer-budget waiter retries an expired shared flight within its own deadline", async () => {
  const client = requester(250);
  const start = Date.now();
  const shorter = client.query(snapshot, start + 80).catch(error => error);
  const longer = client.query(snapshot, start + 1500);
  expect(await shorter).toBeInstanceOf(TypeScriptDiagnosticsTimeout);
  expect(await longer).toEqual([]);
  expect(Date.now() - start).toBeLessThan(1000);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declinedServers, missingServerGuidance } from "../src/install-guidance";

const roots: string[] = [];
const missing = { server: { id: "typescript", command: ["typescript-language-server", "--stdio"], extensions: [".ts"] }, installHint: "install the TypeScript server" };
function state() { const root = mkdtempSync(join(tmpdir(), "lsp-refusal-")); roots.push(root); return join(root, "refusals.json"); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("missing state produces approval and exact agent-edit guidance without writing", () => {
  const path = state();
  const text = missingServerGuidance(missing, path);
  expect(text).toContain("ASK THE USER");
  expect(text).toContain(path);
  expect(text).toContain('"declined_servers":["typescript"]');
  expect(text).not.toContain("lsp_install_decision");
  expect(declinedServers(path)).toEqual([]);
  expect(() => readFileSync(path)).toThrow();
});

test("agent-written refusal is reloaded and respected without modifying other fields", () => {
  const path = state();
  const original = '{"keep":{"value":42},"declined_servers":["typescript","rust"]}';
  writeFileSync(path, original);
  expect(missingServerGuidance(missing, path)).toContain("previously declined");
  expect(missingServerGuidance(missing, path)).not.toContain("ASK THE USER");
  expect(readFileSync(path, "utf8")).toBe(original);
  writeFileSync(path, '{"declined_servers":[]}');
  expect(missingServerGuidance(missing, path)).toContain("ASK THE USER");
});

test("malformed refusal file is never silently replaced or treated as consent", () => {
  const path = state();
  for (const input of ['{', '[]', '{"declined_servers":true}', '{"declined_servers":[42]}']) {
    writeFileSync(path, input);
    expect(() => missingServerGuidance(missing, path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(input);
  }
});

test("legacy allowed records cannot authorize an install", () => {
  const path = state();
  writeFileSync(path, '{"typescript":{"decision":"allowed"}}');
  expect(missingServerGuidance(missing, path)).toContain("ASK THE USER");
});

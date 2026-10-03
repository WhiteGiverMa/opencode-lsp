import { expect, test } from "bun:test";
import { parseTypeScriptDiagnostics } from "../src/typescript-diagnostic-response";

test("message-only related information does not discard the primary diagnostic", () => {
  const diagnostics = parseTypeScriptDiagnostics({ type: "response", success: true, command: "semanticDiagnosticsSync", body: [{
    message: "Type error", category: "error", code: 2322,
    startLocation: { line: 1, offset: 2 }, endLocation: { line: 1, offset: 5 },
    relatedInformation: [{ message: "Additional context without a file span" }],
  }] }, "semanticDiagnosticsSync");
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.range.start).toEqual({ line: 0, character: 1 });
  expect(diagnostics[0]?.code).toBe(2322);
  expect(diagnostics[0]?.relatedInformation).toEqual([]);
});

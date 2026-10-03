import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { cleanupAllSandboxes, mockServer, newSandbox, startSession, writeJsonFile, writeUserConfig } from "./mcp-client";

afterEach(cleanupAllSandboxes);
for (const mode of ["absolute", "relative-parent", "nested-launch"]) {
  test(`${mode} targets use their own workspace for all queries and rename`, async () => {
    const sandbox = await newSandbox();
    const root = join(sandbox.root, "outside workspace 外部");
    const a = join(root, "a.testlang"), b = join(root, "b.testlang");
    await writeJsonFile(join(root, "package.json"), { private: true });
    await writeJsonFile(join(root, "src", "marker.json"), {});
    await writeFile(a, "def alpha\nalpha\n");
    await writeFile(b, "alpha\n");
    await writeUserConfig(sandbox, { lsp: { mock: mockServer(sandbox) } });
    const cwd = mode === "nested-launch" ? join(root, "src") : sandbox.project;
    const path = (file: string) => mode === "absolute" ? file : relative(cwd, file);
    const { client } = await startSession(sandbox, { cwd });
    expect(client.resultText(await client.call("status"))).toMatch(/mock: installed/);
    expect(client.resultText(await client.call("diagnostics", { filePath: path(a) }))).toBe("No diagnostics found");
    expect(client.resultText(await client.call("goto_definition", { filePath: path(b), line: 1, character: 1 }))).toContain(a);
    const references = client.resultText(await client.call("find_references", { filePath: path(a), line: 2, character: 1 }));
    expect(references).toContain(a);
    expect(references).toContain(b);
    expect(client.resultText(await client.call("symbols", { filePath: path(a), scope: "document" }))).toContain("alpha");
    expect(client.resultText(await client.call("symbols", { filePath: path(a), scope: "workspace", query: "alpha" }))).toContain("alpha");
    expect(client.resultText(await client.call("prepare_rename", { filePath: path(a), line: 2, character: 1 }))).toMatch(/rename available/i);
    const renamed = await client.call("rename", { filePath: path(a), line: 2, character: 1, newName: "omega" });
    expect(renamed.isError).not.toBe(true);
    expect(await readFile(a, "utf8")).toBe("def omega\nomega\n");
    expect(await readFile(b, "utf8")).toBe("omega\n");
    for (const newName of ["OVERRIDE_OUTSIDE", "OVERRIDE_OVERLAP"]) {
      const rejected = await client.call("rename", { filePath: path(a), line: 2, character: 1, newName });
      expect(rejected.isError).toBe(true);
      expect(client.resultText(rejected)).toMatch(/outside workspace|overlapping edits/i);
      expect(await readFile(a, "utf8")).toBe("def omega\nomega\n");
      expect(await readFile(b, "utf8")).toBe("omega\n");
    }
    await client.close();
  });
}

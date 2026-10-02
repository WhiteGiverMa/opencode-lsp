import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(root, ".omo/evidence/20261002-feature09");
await mkdir(evidence, { recursive: true });
const results: Array<{ command: string[]; status: number | null }> = [];
for (const [label, args] of [
  ["build", ["run", "build"]],
  ["typecheck", ["run", "typecheck"]],
  ["tests", ["test", "--timeout", "60000"]],
  ["pack", ["pm", "pack", "--filename", "opencode-lsp-0.1.0.tgz"]],
] satisfies Array<[string, string[]]>) {
  const result = spawnSync("bun", args, { cwd: root, encoding: "utf8", timeout: 300000 });
  const output = result.stdout + result.stderr;
  await writeFile(join(evidence, `${label}.log`), output);
  console.log(`${label}: exit=${result.status}\n${output}`);
  results.push({ command: ["bun", ...args], status: result.status });
  if (result.status !== 0) throw new Error(`${label} failed; see evidence log`);
}
await writeFile(join(evidence, "verification.json"), JSON.stringify({ results }, null, 2));

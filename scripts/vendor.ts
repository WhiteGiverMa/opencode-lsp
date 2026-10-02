import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import provenance from "../vendor/provenance.json";

const root = new URL("../vendor/", import.meta.url);
const base = `https://raw.githubusercontent.com/code-yeongyu/lazycodex/${provenance.commit}/`;
const [runtime, license] = await Promise.all([download(provenance.path), download("LICENSE")]);
const hash = createHash("sha256").update(runtime).digest("hex");
if (hash !== provenance.sha256) throw new Error(`Upstream runtime hash mismatch: ${hash}`);
if (!license.includes("MIT License") || !license.includes("2026 Yeongyu Kim")) {
  throw new Error("Unexpected upstream license; refusing import");
}
await mkdir(root, { recursive: true });
await Promise.all([
  writeFile(new URL("runtime.js", root), runtime),
  writeFile(new URL("LICENSE", root), license),
]);
console.log(`Vendored ${provenance.commit}: ${hash}`);

async function download(path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Upstream ${path}: HTTP ${response.status}`);
  return response.text();
}

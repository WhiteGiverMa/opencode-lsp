import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import provenance from "../vendor/provenance.json";
import pkg from "../package.json";
import { patchRuntime } from "./patch-runtime";

const root = new URL("../", import.meta.url);
const original = await readFile(new URL("vendor/runtime.js", root), "utf8");
if (hash(original) !== provenance.sha256) throw new Error("Vendor SHA-256 mismatch; refusing build");
const runtime = patchRuntime(original);
await mkdir(new URL("dist/", root), { recursive: true });
await writeFile(new URL("dist/vendor-runtime.js", root), runtime);
const build = await Bun.build({
  entrypoints: ["src/cli.ts", "src/install-guidance.ts", "src/godot-bridge.ts"].map(path => fileURLToPath(new URL(path, root))),
  outdir: fileURLToPath(new URL("dist/", root)),
  target: "node",
  format: "esm",
  plugins: [{ name: "standalone-runtime", setup(builder) {
    builder.onResolve({ filter: /vendor-runtime\.js$/ }, () => ({ path: "./vendor-runtime.js", external: true }));
  } }],
});
if (!build.success) throw new AggregateError(build.logs, "Build failed");
const fingerprints = await Promise.all(["cli.js", "install-guidance.js", "godot-bridge.js"].map(path => readFile(new URL(`dist/${path}`, root), "utf8")));
await writeFile(new URL("dist/runtime-manifest.json", root), JSON.stringify({ version: pkg.version, fingerprint: hash([runtime, ...fingerprints].join("\n")).slice(0, 16), upstream: provenance.commit }, null, 2) + "\n");
console.log(`Built ${pkg.name}@${pkg.version} from ${provenance.commit}`);

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

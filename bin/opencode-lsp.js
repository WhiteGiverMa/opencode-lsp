#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error("opencode-lsp requires Node.js 24 or newer.");
}
await import("../dist/cli.js");

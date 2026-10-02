---
name: lsp-setup
description: Configure, diagnose, and verify standalone language-server tools. Use when a language server is missing, unavailable, misconfigured, or a project needs LSP definitions, references, diagnostics, symbols, or rename.
license: MIT
---

# Standalone LSP setup

The package root is two directories above this skill directory. Run its
`bin/opencode-lsp.js` with Node.js 24+, from the project being analyzed. Do not
look for OMO sources or install OMO.

## Detect and verify

1. Call `lsp_status` or run `node <package-root>/bin/opencode-lsp.js doctor`.
   The result lists builtin/custom servers, executable availability and active
   clients. It does not start language servers or prove they are reachable.
2. Call `lsp_diagnostics` with a real source file, or run
   `node <package-root>/bin/opencode-lsp.js verify <file>` for a real roundtrip.
   An empty diagnostic result means this checked scope is clean, not that the
   entire project builds or passes tests. Inspect the result's errors too.
3. Use project-native typecheck/lint/build/tests for final verification.

## Missing software and refusal records

Never install a language server without explicit user approval. A missing
server result includes its executable, installation hint and the exact refusal
JSON path. Verify commands for the OS and project package manager first.

If LSP is needed, ask the user. After approval, install the approved server,
verify its executable, and retry. If the user explicitly refuses, read the
given JSON, append that server ID to `declined_servers`, and preserve every
other field and entry. Create a missing file; do not overwrite malformed data.
Lack of an answer is not refusal. There is no `lsp_install_decision` tool.

An existing refusal suppresses another installation request, not the tools.
A subsequently installed server is usable without clearing the old record.

## Server configuration

The user config defaults to `~/.config/opencode-lsp/lsp.json` on Linux/macOS
(honoring XDG_CONFIG_HOME), or `%LOCALAPPDATA%/opencode-lsp/lsp.json` on Windows.
OPENCODE_LSP_HOME and OPENCODE_LSP_CONFIG can override it. Project configuration
uses `.opencode/lsp.json` (legacy `.omo/lsp.json` and `.omo/lsp-client.json` are
fallbacks). These are JSON files, not OpenCode's own native `lsp` field.

```json
{"lsp":{"typescript":{"priority":100,"initialization":{}}}}
```

Project entries may tune builtin extensions, priority, initialization and
disablement, but cannot supply commands or environment variables. Put fully
custom servers and executable/environment overrides in the user file:

```json
{"lsp":{"custom":{"command":["my-server","--stdio"],"extensions":[".custom"]}}}
```

The command must already exist. No servers are downloaded by the MCP. If a
server command or its initialization settings change while it is warm, close
its users and run `node <package-root>/bin/opencode-lsp.js shutdown` before retry.

## Godot

The builtin `gdscript` entry is a TCP bridge, not a Godot installation. Godot
must already have the intended project open. Do not launch, stop or restart the
editor. Configure the port/host in the USER server entry's `env` with
OPENCODE_LSP_GODOT_HOST and OPENCODE_LSP_GODOT_PORT. Default: 127.0.0.1:6005.
Multiple Godot projects must use explicit distinct ports; do not guess ports.
For WSL/Windows paths, OPENCODE_LSP_GODOT_PROJECT_URI can explicitly map the
local project to its editor-side file URI. Never infer a different project.

## Tool conventions

Lines are 1-based; character offsets are 0-based UTF-16 positions. Start rename
with `lsp_prepare_rename`, then `lsp_rename`; inspect its reported changed files
and actual diff. Partial I/O failure is not atomic rollback. If cancellation
arrives after commit begins, changes may have committed; inspect the result
instead of blindly retrying a mutation.

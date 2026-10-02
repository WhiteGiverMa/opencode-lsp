# Standalone LSP delivery

Goal: bare OpenCode v2.0.21 first, then v1.18.34, with current OMO LTS LSP
analysis/configuration/runtime behavior and no OMO runtime dependency.
Explicit exception: remove install_decision; guide agent-written refusal JSON.

## Changes in dependency order

1. Package metadata, MIT notices and immutable vendor/runtime.js with pinned
   provenance. Verify SHA-256 and Node-only runtime imports. Do not fetch on use.
2. scripts/build.ts and checked transformations generate dist/vendor-runtime.js.
   Remove extra tools and main boot side effect, preserve engine safeguards,
   isolate daemon namespace, export narrow runtime API. Reject anchor drift.
3. src/config.ts, install-guidance.ts, cli.ts, vendor-runtime.d.ts and bin entry.
   Explicit per-request paths; refusal reads only; config v1/v2 output; daemon
   identity includes generated-runtime and user-config identity. Node-only dist.
4. src/godot-bridge.ts plus tests. Bounded TCP attach; local handling of shutdown
   and exit, never kill external Godot; no automatic reconnect/replay; explicit
   bidirectional URI mapping, including workspace-edit keys. No port guessing.
5. Original black-box fixtures/tests for seven tools, config trust, missing and
   refusal cases, diagnostic freshness, stale edits, cancellation, shared
   process reuse and cleanup. Reference behavior without copying SUL fixtures.
6. Installed-artifact doctor/verify, original lsp-setup skill, README/parity docs.
   Package smoke must work outside source/OMO trees and without network/build.
7. QA scripts/evidence: real Node MCP + installed TypeScript server, isolated
   bare v2/v1 MCP connection/catalog/disable plus supported sessionless calls.
   No programmatic coding-session creation. If the host exposes no sessionless
   execution surface, report native execution as unverified rather than fake it.
8. Review and verify all changed source, typecheck/tests/build, packed smoke,
   process cleanup and host DB-count proof. No live config edits/service restart,
   commits, pushes or publication without explicit authorization.

## Oracle review corrections incorporated

- Spawned daemons inherit process.env; set independent paired CLI/version/state
  environment before startup, not only proxy options. Config identity must
  prevent two different user-config files sharing an incompatible warm client.
- Read refusal from each request context; invalid data is an explicit error,
  never overwrite or silently turn malformed state into permission to install.
- Godot is borrowed. LSP shutdown/exit are terminated at our bridge boundary.
- Version/hash identity prevents stale warm runtime reuse after a rebuild.
- Current LTS seven-tool behavior is the acceptance contract, not the newer
  vendor release number. Newer vendor differences must be documented/tested.
- CLI imports/Node version requirements need actual runtime verification.

## Done means

Seven stable tools with no removed alias executable, real behavior evidence,
consent-guidance contract, isolated shared lifecycle, working standalone package,
v2/v1 host evidence with exact gaps named, clean scoped checks and cleanup.

## Repository delivery and bilingual documentation

The user subsequently authorized creating the GitHub repository, committing
and pushing. Keep the repository private unless explicitly told otherwise.

1. Preserve the existing English README as README.en.md with a Chinese link.
   Write the default README.md in Chinese with a reciprocal English link,
   preserving setup, tool/configuration, refusal, Godot, safety and QA limits.
2. Clarify the independent stdio MCP software/package form, no automatic
   system-service installation, connection-owned proxy versus detached shared
   daemon, and the backend-versus-window lifecycle distinction in both READMEs.
3. Include both READMEs in package.json files. Validate local links and JSON,
   repack, and drive the unpacked package smoke. Runtime code is unchanged;
   preserve the earlier semantic/harness QA evidence without claiming new runs.
4. Review the staged file set and secret scan; exclude dependency directories,
   generated dist/archive, live configurations and temporary QA logs. Create
   WhiteGiverMa/opencode-lsp privately, commit intended source/documentation,
   push its main branch and compare the GitHub SHA with the local commit.
5. Explain source repository versus built package, MCP versus OpenCode plugin,
   Node/language-server requirements, and that live deployment is not performed.

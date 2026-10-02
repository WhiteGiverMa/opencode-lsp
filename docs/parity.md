# Behavior and provenance contract

Reference: OMO LTS `a997a730430b823d49e5ace9e87284402305b280`.
Runtime source: publicly MIT-licensed lazycodex distribution
`7e7902737a09ed3ccdd396d94b01fae9b4837550`, recorded in vendor/provenance.json.
The artifact is a generated adaptation of that pinned bundle, not a copy of
the SUL-only monorepo Core source. Vendor/runtime.js is byte-for-byte original.

## Preserved capabilities

- Seven LTS analysis/status schemas, aliases, coordinate conventions, severity
  filters, symbol/references limits and structured result details.
- Builtin/user/project language configuration and project command/env trust
  boundary; no language-server downloader or automatic installation.
- File and directory diagnostics, 50-file directory cap and 200-item display
  limits, push/pull support, document-version freshness and transient failures.
- Definition/reference/symbol navigation and prepare/execute rename.
- Workspace edit validation, root/symlink confinement, overlap checks, document
  versions, snapshots, single mutation lease, server applyEdit reconciliation,
  cancellation before commit and honest late-abort/partial-I/O reporting.
- Independent authenticated shared daemon, lazy client startup, 60-second
  initialization timeout, 5-minute client idle lifetime, 30-minute daemon idle
  lifetime, parent/stdio watchdogs, request cancellation and safe owned cleanup.
- Absolute paths may select another workspace; relative paths may not escape
  request cwd. Nearest workspace markers select the project boundary. The newer
  distribution's six-client admission cap is removed to match LTS behavior.

## Explicit user exception

`install_decision` and `lsp_install_decision` are not registered or callable.
The server does not record allowed/declined decisions. Missing-server output
instructs the agent to ask, install only after approval, or append the explicitly
declined server to an independent JSON `declined_servers` array. Existing
refusals are read, not mutated. Legacy allowed records do not authorize installs.

## Packaging adaptations and newer upstream differences

- Extra upstream `format`/`lsp_format` is not registered or callable.
- Configuration defaults are OpenCode/standalone rather than Codex; runtime
  state and socket names are independently namespaced and version-fingerprinted.
- Each user-config path/refusal-path/runtime/PATH/Godot-endpoint domain is isolated. Within a
  warm domain, configuration changes do not retroactively restart an existing
  client. That is documented, not silently treated as a hot reload.
- Godot is an additional attach-only builtin, with `project.godot` root marker,
  bounded TCP bridge and optional explicit URI mapping. This is not a claim that
  the original OMO LSP shipped a native GDScript server.
- Newer upstream fixes such as bounded dead-client respawn and repository-local
  executable discovery are retained. Thus this is capability parity, not an
  assertion of byte-identical messages/bugs or identical failure timing.
- Manager shutdown is single-flight: concurrent signal handlers await the same
  cleanup instead of letting daemon exit overtake language-server termination.
  The explicit shutdown CLI waits for its authenticated daemon to exit.
- The original setup skill is replaced by original documentation driving the
  installed artifact's doctor/verify commands; no OMO source walking is needed.
- OMO-wide output pruning, unrelated tool suppression, telemetry, other agents,
  Codex/Senpi automatic post-edit hooks and global process sweeping are not
  reproduced. The OpenCode OMO adapter did not add a post-edit MCP diagnostics
  hook; native host behavior is separate.

## Verification contract

Original MIT black-box fixtures drive actual Node MCP and LSP subprocesses,
not re-exported OMO source. Real TypeScript diagnostics/navigation/rename runs
use the installed language server in an isolated two-file project. Bare v2 and
v1 tests run real installed binaries in isolated HOME/XDG directories, capture
the host's MCP wire catalog, check connected/disconnected/disabled behavior,
discover the shipped setup skill, and assert zero sandbox coding sessions plus
unchanged real host session count.

The pinned hosts have no supported sessionless MCP tool execution API. No model
turn/coding session is created for testing. Host connection/catalog acceptance
and direct MCP tool execution are separate evidence, not a claim of an observed
agent-native tool call. Real Godot-editor behavior is not claimed from a TCP
fixture. Windows Node/named-pipe package checks are separate from Windows
OpenCode v2, which is not installed here. Exact results belong in the evidence
index; source inspection alone never counts as runtime QA.

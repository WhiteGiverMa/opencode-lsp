# opencode-lsp

[简体中文](README.md) | **English**

Independent MIT LSP tools for **OpenCode v2 and v1**. One local stdio MCP server,
seven analysis/status tools, lazy language-server startup, safe workspace edits,
and an isolated shared daemon. No OMO install, source checkout, private Core
packages, model provider, or runtime download is needed.

This is an independent project, not built by or affiliated with the OpenCode
team. The pinned upstream runtime and its MIT attribution are in `vendor/`.

The product is standalone local software exposing a **stdio MCP server**, not
an OpenCode plugin. Its `.tgz` package contains the built runtime, CLI, setup
skill and documentation. It does not install OpenCode, Node.js or individual
language servers, and installation does not register a systemd service or start
a background process.

## Install a built artifact

Requires Node.js **24 or newer**. Unpack the provided package archive into a
permanent directory, or install that local archive with your package manager.
There are no runtime npm dependencies. Do not register files from a temporary
directory you plan to delete.

Print the configuration for the installed location:

```sh
node /path/to/package/bin/opencode-lsp.js config v2
# or, for OpenCode v1:
node /path/to/package/bin/opencode-lsp.js config v1
```

Merge the printed `mcp` and `skills` entries into your OpenCode configuration,
preserving existing entries. These commands print JSON; they never edit your
configuration. Restart OpenCode yourself if its current instance has already
loaded configuration. The generated v2 configuration uses `mcp.servers.lsp` and
`codemode:false`; v1 uses `mcp.lsp`. Both expose `lsp_*` tools. The setup skill is
loaded from the installed package, not from OMO.

Example MCP-only configuration (replace the absolute paths):

```json
{
  "mcp": {
    "servers": {
      "lsp": {
        "type": "local",
        "command": ["node", "/path/to/package/bin/opencode-lsp.js", "mcp"],
        "codemode": false
      }
    }
  }
}
```

That example is native **v2**, not v1. Use `config v1` for its different shape.
Do not use `npx` or `bunx` for each language-server command when you want a strict
no-download runtime: those launchers can themselves fetch missing packages.

## Tools

| OpenCode tool | Behavior |
| --- | --- |
| `lsp_status` | Configured/installed servers and active clients; no language-server startup |
| `lsp_diagnostics` | File or directory diagnostics, severity filter |
| `lsp_goto_definition` | Semantic definition locations |
| `lsp_find_references` | Semantic references, optional declarations |
| `lsp_symbols` | Document or workspace symbols |
| `lsp_prepare_rename` | Check the rename target |
| `lsp_rename` | Apply server-provided workspace edits with validation and conflict checks |

`line` is 1-based and `character` is 0-based (UTF-16). MCP protocol names are
unprefixed; OpenCode prefixes the server name `lsp`. Legacy `lsp_*` aliases are
accepted directly by the MCP, but are not duplicated in `tools/list`.

There is deliberately **no `lsp_install_decision` or `lsp_format` tool**, including
their unprefixed names. The original seven analysis/status schemas are retained.

## Language servers and refusal records

Language servers are not bundled or auto-installed. Tools remain available when
a server is missing. The result reports its executable and an installation hint;
an agent must ask permission when installation is needed. After approval the
agent installs, checks the executable and retries.

If the user explicitly refuses, the output instructs the agent to read the
absolute refusal JSON path and append the server ID, preserving other fields:

```json
{"declined_servers":["typescript","rust"]}
```

The MCP reads this file on each missing-server result and never writes it. A
previous refusal suppresses repeat questions, not existing installed tools.
Malformed refusal data is reported and left unchanged. No answer is not refusal.

Default user directory:

- Linux/macOS: `$XDG_CONFIG_HOME/opencode-lsp`, or `~/.config/opencode-lsp`.
- Windows: `%LOCALAPPDATA%/opencode-lsp`.

Files inside it: `lsp.json`, `refusals.json`, and private daemon state. Overrides
must be absolute paths:

| Variable | Meaning |
| --- | --- |
| `OPENCODE_LSP_HOME` | Package configuration/state directory |
| `OPENCODE_LSP_CONFIG` | User language-server JSON file |
| `OPENCODE_LSP_REFUSALS` | Agent-managed refusal JSON file |
| `OPENCODE_LSP_PROJECT_CONFIG` | OS-delimiter-separated project config paths confined to the request directory |

Project sources, first existing valid JSON wins: `.opencode/lsp.json`, then
legacy `.omo/lsp.json`, `.omo/lsp-client.json`. No OMO or Codex configuration is
required. Server entries prefer project, then user, then builtin configuration.

```json
{"lsp":{"typescript":{"priority":100,"initialization":{}}}}
```

Project entries can tune **builtin** servers' extensions, priority,
initialization and disablement. They cannot supply arbitrary commands/env or
custom IDs. Put executable/environment overrides and custom servers in the
**user** config, for example:

```json
{"lsp":{"custom":{"command":["my-language-server","--stdio"],"extensions":[".custom"]}}}
```

## Godot

The builtin `gdscript` bridge connects to the editor's TCP LSP at
`127.0.0.1:6005`. Open the **intended project** in Godot first; the integration
never launches or terminates the editor. Connection failure is bounded, with
instructions to open/check the editor. `lsp_status` reports bridge installation,
not proof that Godot is running.

Use USER configuration for a different endpoint:

```json
{
  "lsp": {
    "gdscript": {
      "env": {
        "OPENCODE_LSP_GODOT_HOST": "127.0.0.1",
        "OPENCODE_LSP_GODOT_PORT": "6005"
      }
    }
  }
}
```

For Windows Godot accessed from WSL, configure the reachable host and optionally
`OPENCODE_LSP_GODOT_PROJECT_URI`, such as `file:///G:/dev/my-project`. It maps the
local workspace to that explicit editor-side root in both directions, including
WorkspaceEdit URI keys, without rewriting source text. Use distinct explicit
ports for multiple projects. There is no port guessing, editor launch,
automatic reconnect, or mutation replay. Shutdown/exit is handled by the bridge
locally, not sent to the borrowed editor service.

## Lifecycle, check and shutdown

```sh
node /path/to/package/bin/opencode-lsp.js doctor
node /path/to/package/bin/opencode-lsp.js verify src/example.ts
node /path/to/package/bin/opencode-lsp.js shutdown
```

`doctor` checks executable availability and active clients, not server health.
`verify` executes a real diagnostics request and prints its structured result;
exit 0 means the roundtrip succeeded, not necessarily zero code diagnostics.

Language servers start on the first analysis call, not on workspace scanning or
file edits. Requests share a client per workspace/server in an authenticated,
versioned per-user daemon. Idle clients expire after about 5 minutes; the daemon
expires after 30 minutes without connections or clients. Closing one MCP does
not terminate clients still available to another MCP. Runtime/config identity
is included in the private daemon domain so unrelated installations do not
reuse stale code. Changes to a warm server's command/env/initialization require
an explicit `shutdown` before retry; refusal records are read per request.

`shutdown` authenticates to this package's own endpoint and stops that daemon
and its owned language-server processes. It does not kill Godot or an OMO
daemon. Do not run shutdown while another client needs that shared instance.

The stdio MCP proxy follows OpenCode's backend MCP connection: normal disconnect
or backend exit closes the proxy. A detached shared daemon does not immediately
exit with one proxy; it retains warm clients until idle or explicit shutdown.
Closing a UI attached to a still-running `opencode serve` backend does not
necessarily close its MCP connection. Run `shutdown` with the same configuration
environment to stop the corresponding shared daemon.

## Disable, remove, or replace OMO

- v2: set `mcp.servers.lsp.disabled:true`.
- v1: set `mcp.lsp.enabled:false`.
- To fully remove, remove the MCP entry and this package's skill source, then
  shut down its daemon if no other client uses it. No shell startup/service unit
  is installed.
- In OMO, `disabled_mcps:["lsp"]` removes **all** merged MCPs named `lsp`, not
  just its builtin. Do not combine that flag with a same-name replacement.
  An explicit user `mcp.lsp` entry overrides OMO's builtin command without
  starting the old MCP. If `lsp` is already disabled, remove that actual entry
  from the OMO configuration layer before applying a same-name replacement.
  No migration or live configuration change is performed by this package.

## Build and evidence

```sh
bun install
bun run build
bun run typecheck
bun test
bun pm pack
```

The pinned vendor bytes ship in source control; normal builds are offline after
development dependencies are installed. `bun run vendor` is an explicit
maintainer-only download with SHA-256 verification, not an install hook.

Read [the parity contract](docs/parity.md) for preserved behavior, deliberate
differences and verification limits. Local QA evidence is under
`.omo/evidence/20261002-feature09/`. No claim is made that every language server
or every editor integration has been live-tested.

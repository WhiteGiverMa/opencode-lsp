# opencode-lsp

[简体中文](README.md) | **English**

Independent MIT LSP tools for **OpenCode v2 and v1**. One local stdio MCP server,
seven analysis/status tools, lazy language-server startup, safe workspace edits,
and an isolated shared daemon. No OMO install, source checkout, private Core
packages, or model provider is required to run the MCP. The pinned upstream
runtime and its MIT attribution are in `vendor/`.

## What you get

**This is standalone local MCP software, not an OpenCode plugin.** After
installing, point OpenCode's `mcp` configuration at the start command.

| Piece | Purpose |
| --- | --- |
| stdio MCP server | Brings diagnostics, definitions, references, symbols, and rename to OpenCode |
| CLI | Start the MCP, print config, check servers, verify diagnostics, shut down its daemon |
| `lsp-setup` skill | Guides an agent through server setup, install approval, and refusal records |
| `.tgz` package | Ships the built runtime, CLI, skill, docs, and license files |

The package does not bundle OpenCode, Node.js, or individual language servers.
When a server is missing, the tools stay visible and return an installation hint
with authorization guidance.

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
preserving existing entries. These commands print JSON and never edit your
configuration. Restart OpenCode yourself if its current instance has already
loaded configuration.

- v2 uses `mcp.servers.lsp` with `codemode:false`, exposing `lsp_*` tools.
- v1 uses `mcp.lsp`.
- The setup skill loads from the installed package, not from OMO.

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

v1 uses a different shape; run `config v1` for that.

If you want a strictly no-download runtime, do not configure language-server
commands as `npx` or `bunx`: those launchers can fetch missing packages
themselves.

## The seven tools

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

The tool set is deliberately small: there is no `lsp_install_decision` or
`lsp_format`.

### Target locations and diagnostic freshness

Existing targets can be outside the launch directory, including `../`, absolute
paths and `/mnt/` mounts. Relative paths resolve from the request cwd; the
nearest target workspace marker determines the language client and rename
boundary. Files require appropriate filesystem permissions and an available
language server. Server edits escaping that target workspace, symlink escapes
and overlapping edits remain rejected.

Push-only TS servers advertising `typescript.tsserverRequest` use correlated
syntax, semantic and suggestion diagnostic replies, so servers that suppress
repeated empty publications cannot stall a request. File snapshots are rechecked
before return, and shared queries preserve each caller's cancellation and
deadline. Missing, stale or malformed replies are surfaced as failures;
directory diagnostics list the files that failed.

## Language servers and refusal records

Language servers are not bundled or auto-installed. When a server is missing,
the tool output names the executable, gives an installation hint, and includes
the absolute path of the refusal record.

The flow:

1. When a task genuinely needs LSP, the agent asks the user for approval first.
2. On explicit approval, the agent runs the platform-appropriate install
   command, checks the executable, and retries the tool.
3. On explicit refusal, the agent reads the JSON file named in the output and
   appends the server ID to `declined_servers`, preserving other fields.

```json
{"declined_servers":["typescript","rust"]}
```

The MCP backend reads this file whenever it produces a missing-server hint and
never writes it. A recorded refusal suppresses repeat questions without
disabling servers that are already installed. Malformed refusal data is
reported and left unchanged.

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
`127.0.0.1:6005`. Open the **intended project** in Godot first; the bridge never
launches or terminates the editor.

Connection failure is bounded and tells you to check the editor and port.
`lsp_status` reports whether the bridge is available, not whether Godot is
running.

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
WorkspaceEdit URI keys, without rewriting source text.

Use distinct explicit ports for multiple projects. The bridge does no port
guessing, editor launch, or automatic reconnect. LSP `shutdown`/`exit` is
handled by the bridge locally and is not sent to the external editor service.

## Lifecycle, check and shutdown

```sh
node /path/to/package/bin/opencode-lsp.js doctor
node /path/to/package/bin/opencode-lsp.js verify src/example.ts
node /path/to/package/bin/opencode-lsp.js shutdown
```

`doctor` checks executable availability and active clients. `verify` executes a
real diagnostics request and prints its structured result; exit 0 means the
roundtrip succeeded, not necessarily zero code diagnostics.

Processes come in two layers, and **not all of them exit with OpenCode**:

- The **stdio MCP proxy** is started by OpenCode and follows its backend MCP
  connection: a normal disconnect or backend exit closes the proxy. Closing a
  window attached to a still-running `opencode serve` backend may not close
  the MCP connection.
- The **shared LSP daemon** keeps cached clients independently and does not stop
  just because one proxy exits. Other clients keep using it.

Language servers start on the first real analysis call, not on workspace
scanning or file edits. Requests for the same workspace and server share a
client. Idle clients are reclaimed after about 5 minutes; the daemon exits after
30 minutes with no connections and no clients.

Version, runtime fingerprint, and configuration identity all participate in
daemon isolation. Different builds live in different configuration domains, so
upgrades never reclaim backends still used by old clients. To change a running
server's command, environment, or initialization options, first close its users,
then `shutdown` in the same configuration environment and retry; refusal
records are read per request.

Running `shutdown` in the **same configuration environment** authenticates and
stops the corresponding daemon and the language-server processes it owns;
Godot and OMO daemons are unaffected. Do not run it while other clients still
need that shared instance.

## Disable, remove, or replace OMO

- v2: set `mcp.servers.lsp.disabled:true`.
- v1: set `mcp.lsp.enabled:false`.
- To fully remove, delete the MCP entry and this package's skill source; once no
  other client uses it, shut down the daemon. No shell startup entries or system
  services are installed.
- OMO's `disabled_mcps:["lsp"]` removes **every** merged MCP named `lsp`, not
  just its builtin. Do not combine that flag with a same-name replacement.
- An explicit user `mcp.lsp` entry overrides OMO's builtin command without
  starting the old MCP. If `lsp` is already disabled, remove that actual entry
  from the OMO configuration layer before applying a same-name replacement.
  This package never migrates or edits live configuration.

## Build and verification

```sh
bun install
bun run build
bun run typecheck
bun test
bun pm pack
```

The pinned vendor bytes ship in source control; `dist/` and `.tgz` are build
artifacts and are not committed. Installing a built package needs neither Bun,
development dependencies, nor the OMO repository.

Once development dependencies are installed, normal builds work offline.
`bun run vendor` is an explicit maintainer-only download with SHA-256
verification; it is not an install hook and never runs during normal use.

See [the parity contract](docs/parity.md) for preserved behavior, deliberate
differences, and verification limits.

Verified so far: MCP integration on stock OpenCode v2.0.21 / v1.18.34 with the
seven-tool surface, and real TypeScript operations through the standalone MCP.
The Godot bridge is verified against a TCP fixture and has not yet been
exercised with a real editor; on Windows only the Node package checks have been
run.

## License

MIT, see [LICENSE](LICENSE). OpenCode is an independent project; this project
is not affiliated with or endorsed by it.

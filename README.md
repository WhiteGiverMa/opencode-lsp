# opencode-lsp

**简体中文** | [English](README.en.md)

面向 **OpenCode v2 和 v1** 的独立 MIT LSP 工具。通过一个本地 stdio MCP 服务器，提供七个分析与状态工具、按需启动语言服务器、安全应用工作区修改，以及独立的共享 daemon。

不依赖 OMO 的安装、源码、私有 Core 包或代理配置，也不需要模型供应商才能运行 MCP。本项目独立于 OpenCode 官方团队；固定版本的上游运行时及 MIT 许可说明保留在 `vendor/`。

## 产物是什么

**这是独立的本地 MCP 软件，不是 OpenCode 插件。** 安装后，在 OpenCode 的 `mcp` 配置中指定启动命令即可接入。

| 部分 | 用途 |
| --- | --- |
| stdio MCP 服务器 | 把诊断、定义、引用、符号和重命名能力提供给 OpenCode |
| CLI | 启动 MCP、打印配置、检查服务器、验证诊断、关闭自身 daemon |
| `lsp-setup` 技能 | 指导 agent 配置语言服务器、申请安装批准及处理拒绝记录 |
| `.tgz` 安装包 | 打包已经构建好的运行时、CLI、技能、文档和许可文件 |

安装包**不安装 OpenCode、Node.js 或各语言服务器**，不注册 systemd 服务，安装动作本身也不会启动后台进程。语言服务器缺失时，工具仍可见，并返回安装提示和授权指导。

## 安装与接入

需要 **Node.js 24 或更新版本**。将提供的 `.tgz` 安装包解压到一个长期保留的目录，或者用包管理器安装这个本地归档。运行时没有 npm 包依赖。

不要把之后会删除的临时目录配置为正式安装位置。

从安装后的实际位置打印配置：

```sh
node /path/to/package/bin/opencode-lsp.js config v2
# OpenCode v1 使用：
node /path/to/package/bin/opencode-lsp.js config v1
```

把打印出的 `mcp` 和 `skills` 条目合并到 OpenCode 配置中，保留已有条目。以上命令只输出 JSON，**不会修改用户配置**。已经加载配置的 OpenCode 实例需要由用户重启后生效。

- v2 使用 `mcp.servers.lsp`，并设置 `codemode:false`，直接暴露 `lsp_*` 工具。
- v1 使用 `mcp.lsp`。
- 配套技能从安装包自己的目录加载，不需要 OMO 的技能系统。

下面是只接入 MCP 的 **v2** 配置示例，请替换绝对路径：

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

这不是 v1 配置。需要 v1 时，使用 `config v1` 生成对应格式。

如果要求运行时严格不下载软件，不要把每个语言服务器的命令配置成 `npx` 或 `bunx`：这些启动器本身可能下载缺失的包。

## 七个工具

| OpenCode 工具 | 行为 |
| --- | --- |
| `lsp_status` | 列出已配置、已安装的服务器及活动客户端；不启动语言服务器 |
| `lsp_diagnostics` | 检查文件或目录，支持按严重度筛选 |
| `lsp_goto_definition` | 查询符号的语义定义位置 |
| `lsp_find_references` | 查询语义引用，可选择包含声明 |
| `lsp_symbols` | 查询文件符号或搜索工作区符号 |
| `lsp_prepare_rename` | 检查目标是否可重命名 |
| `lsp_rename` | 校验并应用语言服务器返回的工作区修改 |

`line` 从 1 开始，`character` 从 0 开始，使用 UTF-16 位置。MCP 协议中的工具名没有 `lsp_` 前缀；OpenCode 根据服务器注册名 `lsp` 添加前缀。直接调用 MCP 时也接受旧的 `lsp_*` 别名，但不会在 `tools/list` 中重复列出。

按需求，**不提供 `lsp_install_decision` 或 `lsp_format`**，其无前缀名称和别名也不可调用。保留七个分析／状态工具的接口。

## 语言服务器与拒绝安装记录

各语言服务器不随包捆绑，也不会自动安装。缺失时，工具输出会指出可执行程序、安装提示，以及拒绝记录的完整路径。

处理流程：

1. agent 判断本次任务确实需要 LSP 时，先请求用户批准。
2. 用户明确批准后，agent 执行适合当前平台的安装命令，检查可执行程序，再重试工具。
3. 用户明确拒绝后，agent 读取输出指定的 JSON 文件，把服务器 ID 追加到 `declined_servers`，保留其他字段和记录。

```json
{"declined_servers":["typescript","rust"]}
```

MCP 后端在产生缺失提示时读取该文件，**从不写入这个决定文件**。已有拒绝记录会抑制重复询问，不会禁用已经安装的服务器。格式错误会明确报告并保留原文件。用户没有回答，不等于拒绝。

默认用户目录：

- Linux/macOS：`$XDG_CONFIG_HOME/opencode-lsp`，未设置时为 `~/.config/opencode-lsp`。
- Windows：`%LOCALAPPDATA%/opencode-lsp`。

目录内包括 `lsp.json`、`refusals.json` 和私有 daemon 状态。以下覆盖路径必须为绝对路径：

| 环境变量 | 含义 |
| --- | --- |
| `OPENCODE_LSP_HOME` | 本软件的配置与状态目录 |
| `OPENCODE_LSP_CONFIG` | 用户级语言服务器 JSON 配置 |
| `OPENCODE_LSP_REFUSALS` | 由 agent 管理的拒绝记录 JSON |
| `OPENCODE_LSP_PROJECT_CONFIG` | 使用系统路径分隔符连接的项目配置路径；必须位于请求目录内 |

项目配置按顺序选择第一个有效 JSON：`.opencode/lsp.json`，然后是兼容路径 `.omo/lsp.json`、`.omo/lsp-client.json`。不要求存在 OMO 或 Codex 配置。服务器条目的优先级为项目、用户、内置配置。

```json
{"lsp":{"typescript":{"priority":100,"initialization":{}}}}
```

项目配置只能调整**内置服务器**的后缀、优先级、初始化选项及禁用状态，不能提供任意命令、环境变量或自定义服务器 ID。可执行命令、环境变量覆盖和自定义服务器应放在**用户配置**中：

```json
{"lsp":{"custom":{"command":["my-language-server","--stdio"],"extensions":[".custom"]}}}
```

## Godot

内置的 `gdscript` 桥接程序连接编辑器的 TCP LSP，默认为 `127.0.0.1:6005`。请先在 Godot 中打开**正确的项目**。它不会启动或终止编辑器。

连接失败会在有限时间内返回，并提示检查编辑器及端口。`lsp_status` 只报告桥接程序是否可用，不能证明 Godot 正在运行。

修改端点时，请使用用户配置：

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

从 WSL 访问 Windows Godot 时，应配置可达的主机地址；必要时设置 `OPENCODE_LSP_GODOT_PROJECT_URI`，例如 `file:///G:/dev/my-project`。它在本地工作区和明确指定的编辑器项目根 URI 之间进行双向映射，包括 WorkspaceEdit 的 URI 键，但不改写源代码文本。

多个项目应使用明确、不同的端口。没有端口猜测、编辑器自动启动、自动重连或修改重放。LSP 的 `shutdown`／`exit` 在桥接边界本地处理，不会发送给外部编辑器服务。

## 启停、检查与清理

```sh
node /path/to/package/bin/opencode-lsp.js doctor
node /path/to/package/bin/opencode-lsp.js verify src/example.ts
node /path/to/package/bin/opencode-lsp.js shutdown
```

`doctor` 检查可执行程序的可用性和活动客户端，不是服务器健康探测。`verify` 发起真实诊断请求并输出结构化结果；退出码 0 表示请求成功，不一定表示代码没有诊断问题。

进程分为两层，**不是所有进程都与 OpenCode 同时退出**：

- **stdio MCP 代理**由 OpenCode 启动，跟随其后端的 MCP 连接。正常断开或后端退出时，代理退出。只关闭连接到仍在运行的 `opencode serve` 后端的窗口，不一定断开 MCP。
- **共享 LSP daemon**独立保留缓存客户端，不因一个代理退出就立即停止。其他客户端仍可继续使用。

语言服务器在第一次实际分析调用时启动，不因扫描工作区或读写文件而启动。相同工作区和服务器的请求复用客户端。空闲客户端约 5 分钟回收；daemon 在没有连接、没有客户端后持续空闲 30 分钟退出。

运行时和配置标识参与 daemon 隔离，避免不同安装位置或配置误用旧的缓存。已经启动的服务器若修改命令、环境或初始化选项，需要先 `shutdown` 再重试；拒绝记录则按请求读取。

在**同一配置环境**下运行 `shutdown`，会认证并关闭对应的 daemon 及其拥有的语言服务器进程，不会杀掉 Godot 或 OMO daemon。其他客户端仍需要该共享实例时，不要执行此命令。

## 禁用、移除与替换 OMO

- v2：设置 `mcp.servers.lsp.disabled:true`。
- v1：设置 `mcp.lsp.enabled:false`。
- 完全移除时，删除 MCP 配置条目及本包的技能来源；确认没有其他客户端使用后，再关闭 daemon。本包不安装 shell 启动项或系统服务。
- OMO 的 `disabled_mcps:["lsp"]` 会删除最终合并后的**所有同名 MCP**，不只删除其内置服务器。不要同时使用这个禁用项和一个同名的替代配置。
- 显式的用户 `mcp.lsp` 配置可以覆盖 OMO 内置命令而不启动旧 MCP。如果配置层已经禁用了 `lsp`，需要先移除实际的禁用条目，再接入同名替代。本包不会自动迁移或修改真实配置。

## 从源码构建与验收

```sh
bun install
bun run build
bun run typecheck
bun run test
bun pm pack
```

Git 仓库保存源码和固定的上游字节；`dist/` 与 `.tgz` 是构建产物，不提交到 Git。安装已经构建的包不需要 Bun、开发依赖或 OMO 仓库。

开发依赖安装完成后，正常构建无需联网。`bun run vendor` 是维护者显式执行的下载命令，带 SHA-256 校验，不是安装钩子，也不会在普通运行时执行。

保留的行为、明确差异和验证边界见[行为对齐说明](docs/parity.md)。本地验收证据位于 `.omo/evidence/20261002-feature09/`，不随 Git 提交。

已验证裸 OpenCode v2.0.21／v1.18.34 的 MCP 接入及七工具目录，以及独立 MCP 的真实 TypeScript 操作。宿主接入与直接 MCP 执行是两类证据，不冒称已观察到模型会话里的原生工具调用。Godot 使用 TCP fixture 验证，不能替代真实编辑器验收；Windows Node 的安装包检查也不等于 Windows OpenCode 完整验收。没有宣称所有语言服务器和编辑器版本都已实测。

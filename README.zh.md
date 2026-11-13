# dsh-subagent-agy

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供一次性 [Google Antigravity CLI](https://antigravity.google/docs/cli/reference)（`agy`）子代理。实现形态对齐 [`@deepseek-ai/dsh-subagent-codex`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-codex/README.md) 与 [`@deepseek-ai/dsh-subagent-claude-code`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-claude-code/README.md)：每次运行在父会话工作区启动一个全新的 agy 进程，提交一段自包含文本任务，只把最终回答通过共享 `dsh-subagent` 契约返回。

## 工作原理

`agy` 没有 app-server 握手，因此本插件用 CLI 无头模式的双向 `stream-json` 协议：

1. 在父会话 cwd 启动 `agy --print= --input-format stream-json --output-format stream-json ...`。
2. 向 stdin 写入一条 NDJSON 用户事件后关闭：
   ```json
   {"event":"user","message":{"content":"任务内容"}}
   ```
3. 读取 stdout 的 NDJSON 事件流（`init` → `step_update` → `result`）。
4. 仅接受 `result.status === "SUCCESS"` 且 `result.response` 非空、无 `error`/`print_timeout` 的结果；有 `denied_actions` 但回答为空时转为诊断错误，而不是静默空成功。
5. 把 `response` 作为运行输出；`dispose()` 终止整棵进程树并等待退出。

任务不进入 argv，因此长 prompt 和以 `-` 开头的 prompt 都安全。默认开启 `--disable-slash-commands`，任务文本不会触发 agy 的斜杠命令或技能。

## 安装

要求宿主机上有可用的 `agy`（在 `PATH` 上；否则 Linux 查 `~/.local/bin`，Windows 查 Antigravity 应用的 `%USERPROFILE%\.gemini\bin`，见 [Linux 说明](#linux-说明) 和 [Windows 说明](#windows-说明)）且已完成登录。已在 **agy 1.4.11**（Linux x86-64）上验证；Windows x86-64 上用 agy 1.5.8、dsh 0.2.2-rc.3 测试过（见 Windows 说明）。插件不安装 agy、不登录、不选模型、不创建或迁移 agy 的 `~/.gemini` 状态。

本包没有发布到 npm，请从 GitHub 安装。dsh 使用的 pnpm 默认会拦截 git 和 `file:` 来源的依赖构建脚本，所以先在 profile 的 `pnpm-workspace.yaml` 里放行本包（如 `~/.dsh/profiles/web/pnpm-workspace.yaml`，Windows 上是 `%USERPROFILE%\.dsh\profiles\<name>\pnpm-workspace.yaml`）：

```yaml
allowBuilds:
  dsh-subagent-agy: true
```

只写包名即可，对任何版本和来源都生效。不加的话 `add` 会报 `ERR_PNPM_IGNORED_BUILDS`，dsh 会回滚 profile。

然后作为 profile bundle 安装（`--profile` 要紧跟在 `plugin` 后面）：

```bash
dsh plugin --profile web add github:fzh365/dsh-subagent-agy
# 固定到某个 commit（或分支）：
dsh plugin --profile web add github:fzh365/dsh-subagent-agy#ac37733
# 本地目录（会复制进来，依赖也会装上）：
dsh plugin --profile web add file:/path/to/dsh-subagent-agy
```

不要直接写本地路径：pnpm 会把它变成 `link:` 软链接，不安装插件自己的依赖；本地目录里没有 `node_modules` 时，加载会报 `Cannot find package '@deepseek-ai/schemastery'`。出现 `Missing peer @deepseek-ai/*` 警告是正常的，这些包由 dsh 在运行时提供。

或手动加入 profile：

```bash
cd ~/.dsh/profiles/web
pnpm add github:fzh365/dsh-subagent-agy
```

然后把 `"dsh-subagent-agy"` 追加到 profile `package.json` 的 `dsh.profile.bundles`。bundle patch 会注册下面两行。

### 插件详情开关

包自带浏览器端。宿主加载后，打开 **插件** 面板并选中 `dsh-subagent-agy`。**完全权限** 卡片会出现在“包含的插件”上方，右侧是滑块和 **关闭**/**打开** 状态。开关会把 `dangerouslySkipPermissions` 写入 profile patch 的 `subagent-agy` 行，下一次 agy 运行即生效，无需重启。

开关是全有全无：开启后 agy 可以在 Session 工作区执行任意 shell 命令。只在可信工作区启用。如果 provider 行被禁用，卡片会提示插件当前未加载。

首次加入浏览器端需要重启一次宿主，因为客户端模块图会缓存包元数据；之后开关是实时生效的。

## 组合

`cordis.patch.yml` 自带默认组合：

```yaml
- insert:
    - id: subagent-agy
      name: dsh-subagent-agy
      config:
        disableSlashCommands: true
    - id: tool-subagent-agy
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: agy
        toolName: subagent_agy
        maxDepth: provider-managed
```

只想保留 provider、不暴露工具时，禁用 `tool-subagent-agy` 行。只读的 `agy_runs` 和委托说明跟这一行走：只有 `subagent_agy` 还在时才会注册。只想给特定 Agent Preset 使用时，复制 preset 并把工具行加到副本里。

## Linux 说明

- **可执行文件查找。** `command` 为裸命令名（默认 `agy`）时先在子进程 PATH 中查找；找不到时（dsh 以服务方式运行、PATH 不含 agy 默认安装目录 `~/.local/bin` 时很常见），回退到 `$HOME/.local/bin/agy`（HOME 优先取 `env.HOME`，否则取宿主的）。`command` 为绝对路径时按配置使用，不回退。都找不到时，运行失败，错误中会列出查过的 PATH 目录和回退路径。修复方法：把 `command` 设为绝对路径（以 agy 登录用户执行 `command -v agy` 查看），或把 `~/.local/bin` 加进服务的 PATH。
- **与 agy 登录使用同一用户/HOME。** agy 的 OAuth token 和设置都在 `~/.gemini` 下。dsh 必须以执行过 `agy` 登录的用户运行（或用 `env.HOME` 指向那个 home），否则无头运行会报 `authentication required`。
- **API key 会被剥离。** dsh 的子进程层会从继承的环境中去掉形似凭据的变量（`*KEY*`、`*TOKEN*`、`*SECRET*`、`*PASSWORD*`）。使用 `"modelProvider": "gemini"` 时，需要在本插件的 `env` 中显式设置 `GEMINI_API_KEY`。
- **权限。** 无头 agy 与交互式 agy 读取同一个 `~/.gemini/antigravity-cli/settings.json`。在隔离容器中，比较实用的做法是开启 `dangerouslySkipPermissions: true`，再在该文件里配一个 deny 列表。即使带 `--dangerously-skip-permissions`，deny 规则依然生效（已在 agy 1.4.11 上验证）：
  ```json
  { "permissions": { "deny": ["command(rm -rf)", "command(sudo)", "write_file(.git/)"] } }
  ```
- **会话文件会累积。** 每次运行（包括无头运行）都会在 `~/.gemini/antigravity-cli/conversations/<id>.db` 保存一个会话（另有 `brain/<id>/`），每个约 0.3–0.5 MB。agy 1.4.11 没有关闭它的选项。插件会在失败诊断和 `agy_runs` 中给出每次运行的会话 id，方便按需清理。

## Windows 说明

- **可执行文件查找。** `command` 为裸命令名（默认 `agy`）时先在子进程 PATH 中查找；agy 独立安装器（`%LOCALAPPDATA%\agy\bin`）安装时会自己加进 PATH，所以插件不额外查这个目录。PATH 中找不到时，回退到 Antigravity 应用自带的 `%USERPROFILE%\.gemini\bin\agy.exe`（USERPROFILE 优先取 `env.USERPROFILE`，否则取宿主的；不使用 `HOME`）。没装应用时这个文件不存在，运行失败，错误中列出查过的 PATH 目录和回退路径。`command` 含 `\`、`/` 或盘符（`.\agy.exe`、`bin\agy.exe`、`D:\tools\agy.exe`）时视为显式路径，不回退。可以用 agy 登录用户执行 `where.exe agy` 或 `Get-Command agy` 查看路径。
- **PATH 只在启动时读取。** 长时间运行的 dsh 沿用启动时的 PATH。dsh 启动后才安装 agy、又没有应用副本时，需要重启 dsh。
- **两份安装可能版本分叉。** 应用的 `.gemini\bin\agy.exe` 跟着应用更新，独立副本靠 `agy update` 更新。PATH 中排在前面的那份才会被运行，两者版本可能不同。在意版本时把 `command` 固定为某个绝对路径。
- **冷启动较慢。** Windows 上 agy 约 6 秒才发出 `init`，约 9 秒才有第一步。`maxRunMs` 要留足余量；在 `init` 之前触发上限时，诊断会注明“仍在启动”，而不是任务卡住。
- **平台标签不同。** shell 工具在 Windows 上叫 `Bash`，在 Linux 上叫 `RunCommand`，`deniedTools` 和诊断里都是如此。
- **进程树回收取决于 dsh。** 取消和上限都调用 `ctx.subprocess` 的 `terminate()`。用 `@deepseek-ai/dsh-subprocess-local` 0.2.2-rc.3（Windows Job runner）实测：shell 起了一个睡眠中的孙进程后取消运行，整棵树（agy、它的 shell、睡眠进程）在 20 秒内全部退出，运行以 `aborted` 结束并保留会话 id。这是宿主实现的功劳，换别的 subprocess 实现结果可能不同。smoke 用的是原生 `child.kill()`；`test/windows-extra.mjs` 走的是真实 subprocess 服务。
- **Windows 上另外验证过：** `dangerouslySkipPermissions` 能放行 shell 命令，不弹审批也不拒绝；`--add-dir` 让 `accept-edits` 能写到工作区之外；中文任务和多行中文输出均无乱码。
- **Windows 上尚未验证：** 设置卡片在应用里的实际显示。它写入的 patch（`dangerouslySkipPermissions: true`）是生效的。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `command` | `agy` | 可执行名或绝对路径，经 `ctx.subprocess` 解析。 |
| `env` | `{}` | 显式子进程环境，叠加在已清除凭据的父环境之上。 |
| `disposeGraceMs` | `3000` | 进程树终止各阶段的正有限宽限，上限 `MAX_TIMER_DELAY_MS`。 |
| `mode` | `""` | `""` 保留宿主机 agy 原生模式；也可选 `accept-edits`、`auto`（预览，需终端沙箱）、`plan`。 |
| `model` | `""` | 传给 `--model`；空则用宿主机 agy 原生模型。 |
| `effort` | `""` | 传给 `--effort`：`low`、`medium`、`high`、`xhigh`、`max`。 |
| `timeout` | `""` | 传给 `--print-timeout`，如 `10m`；空则一直等到本轮结束。超时会落为 `error`。 |
| `addDirs` | `[]` | 重复 `--add-dir` 追加工作区目录。 |
| `disableSlashCommands` | `true` | 传 `--disable-slash-commands`，任务文本不按斜杠命令/技能展开。 |
| `dangerouslySkipPermissions` | `false` | 传 `--dangerously-skip-permissions`，允许 agy 无人值守执行工具。 |
| `idleTimeoutMs` | `0` | 可选的静默看门狗：连续无 stdout 这么久则杀进程树。`0`（默认）关闭。agy 在工具运行期间不输出任何事件，任何固定值都可能误杀正常的长命令。 |
| `maxRunMs` | `7200000` | 单次运行的墙钟上限（默认 2 小时）；`0` 关闭。这是一个宽松的兜底，用来在无人值守时停止失控或死循环的子代理（死循环会持续输出事件，静默计时抓不到），也能覆盖卡死。到点后按取消的路径杀掉进程树，运行以 `error` 结束，诊断中写明上限、已运行时长、步数、最后/仍在运行的工具和会话 id。正常的停止应通过在对话中取消委派来完成。 |
| `avoidBrowser` | `true` | 每个任务末尾追加注解，要求 agy 不要用 `browser_*`（无头模式下会挂死）。 |

> **权限**：无头模式下 agy 无法弹窗，需要审批的工具会被自动拒绝。`accept-edits` 只放行工作区文件编辑，shell 等受限工具仍会失败。仅在隔离/可信环境把 `dangerouslySkipPermissions` 设为 `true`。

> **`plan` 模式**：agy 的 `plan` 本身是斜杠命令，与 `disableSlashCommands: true` 冲突；插件在加载时直接拒绝该组合。

指定模型并放开 shell 的示例：

```yaml
- id: subagent-agy
  name: dsh-subagent-agy
  config:
    mode: accept-edits
    model: claude-sonnet-4-6
    effort: high
    dangerouslySkipPermissions: true
    env:
      HOME: /root
```

## 能力与上下文

Provider 不声明任何可选启动能力（`NO_START_CAPABILITIES`），且 `inheritsParentContext: false`。子代理只拿到独立文本任务和父会话 cwd，不继承父对话、人设、工具过滤、深度策略或结构化输出契约。由于不支持 `depthLimit`，工具行必须写 `maxDepth: provider-managed`。

每次运行都有独立的 agy 进程与会话；agy 的 conversation id 仅保留在本次运行内，不写入父会话。没有续聊工具，也不写磁盘会话表。

## 查看运行状态

`agy` 子代理是**外部 run**，不是进程内 Agent：它们永远不会出现在 `list_agents`、`wait_agent`、`send_message` 里，对着这些工具轮询只会白耗回合。为此加了两样东西：

1. **委托上下文**：插件注册一段系统提示上下文，说明 `subagent_agy` 是 external run、调用后立即返回 id、结束时宿主会推送完成通知，模型应继续做别的工作而不是轮询或 sleep。
2. **`agy_runs` 工具**：只读工具，列出调用者自己的 agy run，含状态、已运行时长、步数、工具调用次数和最后一个工具：
   ```text
   3f2a1b9c [running] 审可靠性 · 4m12s · last tool run_command (8s ago) · 5 tool calls · step 12
   deadbeef [failed] (unlabeled) · 3s · last tool run_command (1s ago) · step 2 · denied: RunCommand · conversation 9481e97b-b638-497f-9aa8-df35ca50f8a1 · error: subagent-agy: agy produced no final answer (denied tools: RunCommand)
   ```
   已结束的 run 保留十分钟（最多 50 条），晚一点查也能看到结果；活跃 run 永远不会被容量上限挤掉。进度来自 agy 自己的 `step_update` 事件，不额外起进程、不耗额度。运行中的行还带一小段尾部文本预览，可以区分“卡住”和“正在产出”。

   行里显示的 id 是 provider 内部的 run id；委托工具返回的是宿主的 activation id，两者不同，请用 label 关联。

这只是可观测性：会话顶栏的血缘下拉仍会列出一条灰色、不可打开的「外部任务」条目，因为那条记录就是宿主对“这次委托”的账。除非改成阻塞式 caller delivery 工具，provider 无法消除它。

## 限制

- **每次运行一个全新进程**——不支持继续、恢复、池化或产品会话持久化；进度只能通过 `agy_runs` 轮询，不会流式写进父对话。
- **安装与账号状态由宿主机负责**——`agy` 缺失/不兼容、配置错误或认证失败会表现为启动/运行错误；不提供安装器或登录流程。
- **没有人机审批通道**——未开启 `dangerouslySkipPermissions` 时受限工具会被拒绝，需要交互输入的任务会失败。
- **只返回最终文本**——agy 的推理、工具流量、用量和工作区 diff 都留在产品侧。stderr 改为管道读取并转发到宿主 stderr，每次运行保留最后 8 KiB；失败时诊断信息包含退出码/信号、会话 id、步数、最后（或仍在运行）的工具、解析后的 `AGY_ERROR: {...}` 行以及 stderr 尾部。若成功结果带有 `denied_actions`，答案原样返回，并附加一条模型可见的说明列出被拒绝的工具。
- **墙钟边界**——`maxRunMs`（默认 2 小时）是插件的墙钟兜底；`timeout` 是 agy 自己的 `--print-timeout`；`idleTimeoutMs` 是可选的 stdout 静默看门狗（默认关闭，因为 agy 在工具运行期间不输出）。在对话中取消委派会立即停止运行。插件停止或热重载会杀掉所有在跑的 agy 进程树。
- **协议固定**——已在 `agy 1.4.11`（Linux）和 `agy 1.5.8`（Windows）上验证；其他版本未测试。agy 会静默自动更新，升级后请重新运行 `node test/smoke.mjs`。smoke 已兼容平台差异（shell 工具标签不同；Windows 冷启动慢，运行上限更长）。不支持没有 `--input-format stream-json` 的版本。

## 测试

```bash
node test/unit.mjs        # 纯契约测试，不消耗额度（行上限、未知 mode/effort 透传、addDirs / idleTimeoutMs / maxRunMs 加载校验）
node test/mock.mjs        # 子进程 mock：无 result、stdout 噪声、取消/dispose（含 spawn 后 abort）、孙进程持管、静默看门狗、行上限、disposeAll、run 注册表
node test/integration.mjs # 真实 Cordis：provider/工具/上下文注册、设置页抑制、ctx.plugin 生命周期
node test/client.mjs      # 浏览器端：bundle-config 卡片、滑块状态流转、拒绝写入、行绑定
node test/smoke.mjs       # 真实 agy（使用其默认模型）：回答、写文件、取消
node test/windows-extra.mjs  # 仅 Windows，走真实 dsh subprocess 服务：--add-dir、取消时回收进程树
```

smoke 测试会消耗模型额度，且要求 `PATH` 上有已登录的 `agy`；它不传 `--model`，使用 agy 自己的默认模型。

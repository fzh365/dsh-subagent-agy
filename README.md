# dsh-subagent-agy

English | [中文](README.zh.md)

A one-shot [Google Antigravity CLI](https://antigravity.google/docs/cli/reference) (`agy`) subagent provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It follows the same provider shape as [`@deepseek-ai/dsh-subagent-codex`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-codex/README.md) and [`@deepseek-ai/dsh-subagent-claude-code`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-claude-code/README.md): each accepted run starts one fresh product process in the delegating Session's workspace, submits one self-contained text task, and returns only the final answer through the shared `dsh-subagent` result contract.

## How it works

`agy` has no app-server handshake, so this provider uses the CLI's headless `stream-json` protocol in both directions:

1. Spawn `agy --print= --input-format stream-json --output-format stream-json ...` in the parent Session cwd.
2. Write exactly one NDJSON user event to stdin, then close it:
   ```json
   {"event":"user","message":{"content":"the task"}}
   ```
3. Consume the NDJSON event stream on stdout (`init` → `step_update` → `result`).
4. Accept only `result.status === "SUCCESS"` with a non-blank `result.response` and no `error`/`print_timeout`. `denied_actions` with a blank answer becomes a diagnostic instead of a silent empty success.
5. Return that `response` as the run output; `dispose()` terminates the whole process tree and waits for it to exit.

The task never enters argv, so long prompts and prompts starting with `-` are safe. `--disable-slash-commands` is on by default so task text cannot trigger agy slash commands or skills.

## Install

Requires a working `agy` (on `PATH`; otherwise `~/.local/bin` on Linux or the Antigravity app's `%USERPROFILE%\.gemini\bin` on Windows; see [Linux notes](#linux-notes) and [Windows notes](#windows-notes)), already authenticated on the host. Verified on **agy 1.4.11** (Linux x86-64); smoke-tested on Windows x86-64 with agy 1.5.8, with the gaps listed in the Windows notes. The plugin does not install agy, log in, pick a model, or create/migrate agy's `~/.gemini` state.

Install the package as a profile bundle:

```bash
dsh plugin --profile web add dsh-subagent-agy
# local checkout:
dsh plugin --profile web add /path/to/dsh-subagent-agy
```

Or add it to a profile manually:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-subagent-agy
```

and append `"dsh-subagent-agy"` to `dsh.profile.bundles` in the profile `package.json`. The bundle patch registers both rows below.

### Plugin-detail switch

The package ships a browser half. Once the host has loaded it, open the **Plugins** panel and select `dsh-subagent-agy`. A **Full permissions** card appears above the included-plugin rows, with a right-aligned slider and an **Off**/**On** label. The switch writes `dangerouslySkipPermissions` into the `subagent-agy` entry of the profile patch and takes effect on the next agy run without a restart.

The switch is all-or-nothing: enabling it lets agy run arbitrary shell commands in the Session workspace. Use it only in a trusted workspace. If the provider row is disabled, the card reports that the plugin is not loaded.

Adding the browser half for the first time requires one host restart, because the client module graph caches package metadata; after that, toggling is live.

## Composition

`cordis.patch.yml` ships this default composition:

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

To keep the provider but hide the tool, disable the `tool-subagent-agy` row. The read-only `agy_runs` tool and its delegation context follow that row: they are registered only while `subagent_agy` is present. To expose delegation only to selected Agent Presets, copy a preset and add the tool row there instead.

## Linux notes

- **Executable lookup.** A bare `command` (default `agy`) is looked up on the child PATH; if it is missing there — common for a dsh service whose PATH lacks `~/.local/bin`, agy's default install dir — the plugin falls back to `$HOME/.local/bin/agy` (HOME from `env.HOME`, else the host's). An absolute `command` is used as configured, with no fallback. If nothing is found, the run fails with the PATH dirs and fallback path it searched. Fix by setting `command` to the absolute path (`command -v agy` as the agy user) or adding `~/.local/bin` to the service PATH.
- **Same user/HOME as the agy login.** agy keeps its OAuth token and settings under `~/.gemini`. Run dsh as the user who ran `agy` to log in (or point `env.HOME` at that home); otherwise headless runs fail with `authentication required`.
- **API keys are stripped.** The dsh subprocess layer drops credential-shaped variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`) from the inherited environment. With `"modelProvider": "gemini"`, set `GEMINI_API_KEY` explicitly in this plugin's `env`.
- **Permissions.** Headless agy reads the same `~/.gemini/antigravity-cli/settings.json` as interactive agy. In an isolated container, a practical setup is `dangerouslySkipPermissions: true` plus a deny list in that file. Deny rules still apply under `--dangerously-skip-permissions` (verified on agy 1.4.11):
  ```json
  { "permissions": { "deny": ["command(rm -rf)", "command(sudo)", "write_file(.git/)"] } }
  ```
- **Conversation files accumulate.** Every run, headless included, saves a conversation under `~/.gemini/antigravity-cli/conversations/<id>.db` (plus `brain/<id>/`), roughly 0.3–0.5 MB each. agy 1.4.11 has no flag to disable this. The plugin reports each run's conversation id in failure diagnostics and `agy_runs`, so you can clean up selectively.

## Windows notes

- **Executable lookup.** A bare `command` (default `agy`) is looked up on the child PATH first; agy's standalone installer (`%LOCALAPPDATA%\agy\bin`) adds itself to PATH, so the plugin does not search that dir. If PATH misses, the plugin falls back to `%USERPROFILE%\.gemini\bin\agy.exe`, the copy the Antigravity app keeps (USERPROFILE from `env.USERPROFILE`, else the host's; `HOME` is not used). Without the app that file does not exist and the run fails with the PATH dirs and fallback it searched. A `command` with `\`, `/` or a drive letter (`.\agy.exe`, `bin\agy.exe`, `D:\tools\agy.exe`) is explicit and never falls back. Find the path with `where.exe agy` or `Get-Command agy` as the agy user.
- **PATH is read once.** A long-running dsh keeps the PATH it started with. If agy is installed after dsh started and the app copy is absent, restart dsh.
- **Two installs can drift.** The app's `.gemini\bin\agy.exe` is updated by the app; the standalone copy is updated by `agy update`. Whichever comes first on PATH is the one that runs, so the two can be different versions. Pin `command` to one absolute path if that matters.
- **Cold start is slow.** agy on Windows takes about 6 s to emit `init` and about 9 s to its first step. Keep `maxRunMs` well above that; a cap hit before `init` is reported as a startup stall rather than a stuck task.
- **Platform labels differ.** The shell tool is reported as `Bash` on Windows and `RunCommand` on Linux, in `deniedTools` and diagnostics alike.
- **Process-tree termination depends on dsh.** Cancellation and caps call `ctx.subprocess`'s `terminate()`; whether agy's grandchildren (shells, tools) are reaped on Windows depends on the dsh host (Job Object / `taskkill /T`). The smoke harness uses plain `child.kill()`, so it does not prove grandchild cleanup on Windows.
- **Not yet verified on Windows:** `dangerouslySkipPermissions` actually allowing shell, `--add-dir`, non-ASCII input (Chinese output decodes fine), long-run cancellation through the real subprocess service, and the settings card in the app.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `command` | `agy` | Executable name or absolute path resolved through `ctx.subprocess`. |
| `env` | `{}` | Explicit child environment layered over the credential-scrubbed parent environment. |
| `disposeGraceMs` | `3000` | Positive finite grace, at most `MAX_TIMER_DELAY_MS`, between process-tree termination tiers. |
| `mode` | `""` | `""` keeps the host's native agy mode; or `accept-edits`, `auto` (preview; needs the terminal sandbox), `plan`. |
| `model` | `""` | `--model` value; empty uses the host's native agy model. |
| `effort` | `""` | `--effort` value: `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeout` | `""` | `--print-timeout` value such as `10m`; empty waits for the turn. A timeout settles as `error`. |
| `addDirs` | `[]` | Repeated `--add-dir` workspace extras. |
| `disableSlashCommands` | `true` | Pass `--disable-slash-commands` so task text is not expanded as a slash command or skill. |
| `dangerouslySkipPermissions` | `false` | Pass `--dangerously-skip-permissions` so agy can run tools unattended. |
| `idleTimeoutMs` | `0` | Opt-in silence watchdog: kill the process tree after this many milliseconds with no stdout. `0` (default) disables it. agy emits nothing while a tool runs, so any fixed value also kills legitimately long commands. |
| `maxRunMs` | `7200000` | Wall-clock cap on one run (default 2 hours); `0` disables it. A loose backstop that stops a runaway or looping unattended run (a loop keeps emitting events, so no silence timer catches it) and covers hangs. On expiry the process tree is terminated like a cancel and the run settles as `error` with a diagnostic naming the cap, elapsed time, steps, last/running tool, and conversation id. Normal stops come from cancelling the delegation. |
| `avoidBrowser` | `true` | Append a note to every task telling agy not to use `browser_*` tools (they can hang headless runs). |

> **Permissions.** In headless mode agy cannot prompt, so any tool that needs approval is auto-denied. `accept-edits` allows workspace file edits; shell commands and other gated tools still fail. Set `dangerouslySkipPermissions: true` only in an isolated/trusted environment.

> **`plan` mode.** agy implements `plan` as a slash command, so it is incompatible with `disableSlashCommands: true`; the plugin rejects that combination at load time.

Example with a specific model and shell access:

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

## Capabilities and context

The provider advertises no optional start-time capabilities (`NO_START_CAPABILITIES`) and reports `inheritsParentContext: false`. The child receives only the standalone text task and the parent Session cwd; it does not receive the parent conversation, persona, tool filter, depth policy, or structured-output contract. Because `depthLimit` is unsupported, the tool row must use `maxDepth: provider-managed`.

Each run gets an independent `agy` process and conversation. agy's conversation id stays private to the run and is not persisted in the parent Session. There is no follow-up tool and no on-disk conversation registry.

## Watching a run

`agy` children are **external runs**, not in-process Agents. They never appear in `list_agents`, `wait_agent`, or `send_message`, so polling those for an agy child only wastes turns. Two additions make that explicit:

1. **Delegation context.** The plugin registers a system-prompt context stating that `subagent_agy` children are external, that a delegation returns its id immediately, and that the runtime delivers a completion notice — the model should continue other work instead of polling or sleeping.
2. **`agy_runs` tool.** A read-only tool that lists the caller's own agy runs with state, elapsed time, step count, tool-call count, and the last tool each run used:
   ```text
   3f2a1b9c [running] audit reliability · 4m12s · last tool run_command (8s ago) · 5 tool calls · step 12
   deadbeef [failed] (unlabeled) · 3s · last tool run_command (1s ago) · step 2 · denied: RunCommand · conversation 9481e97b-b638-497f-9aa8-df35ca50f8a1 · error: subagent-agy: agy produced no final answer (denied tools: RunCommand)
   ```
   Settled runs stay listed for ten minutes (capped at 50 records) so a late check still sees the outcome; live runs are never evicted to satisfy the cap. Progress comes from agy's own `step_update` events, so it costs no extra process or quota. Live rows also carry a trailing text preview, which distinguishes a stuck run from a productive one.

   The id a row shows is the provider-internal run id; the delegation tool returns the runtime's own activation id, so correlate rows by their label.

This is observability only: the session header's lineage dropdown still lists one grey, non-openable "External task" entry per delegation, because that entry is the host's own record of the delegation. The provider cannot suppress it without switching to a blocking caller-delivery tool.

## Limitations

- **One fresh process per run** — no continuation, resume, pooling, or product-session persistence; progress is polled through `agy_runs`, never streamed into the parent conversation.
- **Host-managed installation and account state** — a missing/incompatible `agy`, config error, or auth failure surfaces as a startup or run error. No installer or login flow.
- **No human approval path** — gated tools are denied unless `dangerouslySkipPermissions` is on; tasks needing interactive input fail.
- **Final text only** — agy reasoning, tool traffic, usage, and workspace diffs stay product-local. stderr is piped and forwarded to the host's stderr; the last 8 KiB is kept per run, and on failure the diagnostic carries the exit code/signal, conversation id, step count, last (or still-running) tool, the parsed `AGY_ERROR: {...}` line, and a stderr tail. A completed run whose `result` lists `denied_actions` keeps its exact answer and adds a model-visible note naming the denied tools.
- **Wall-clock bounds** — `maxRunMs` (default 2 hours) is the plugin's wall-clock backstop; `timeout` is agy's own `--print-timeout`; `idleTimeoutMs` is an opt-in stdout silence watchdog (off by default, because agy is silent while a tool runs). Cancelling the delegation stops a run immediately. Plugin stop or hot-reload terminates every in-flight agy process tree.
- **Protocol pinning** — verified on `agy 1.4.11`; 1.4.12 and 1.5.0 are untested. agy updates itself silently, so re-run `node test/smoke.mjs` after an upgrade. The smoke test allows for platform differences (shell tool label, a longer run cap on Windows for the slower cold start). Builds without `--input-format stream-json` are unsupported.

## Tests

```bash
node test/unit.mjs        # pure contract tests, no quota (line cap, unknown mode/effort pass-through, addDirs / idleTimeoutMs / maxRunMs load checks)
node test/mock.mjs        # subprocess mock: no result, stdout noise, abort/dispose (including abort-after-spawn), grandchild stdout, silence watchdog, line cap, disposeAll, run registry
node test/integration.mjs # real Cordis: provider/tool/context registration, settings suppression, ctx.plugin lifecycle
node test/client.mjs      # browser half: bundle-config card, slider state transitions, refused writes, row binding
node test/smoke.mjs       # real agy (its own default model): answer, file write, cancellation
```

The smoke test spends model quota and requires an authenticated `agy` on `PATH`; it passes no `--model`, so agy's own default model is used.

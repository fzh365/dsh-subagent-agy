/**
 * Fixed `agy` (Google Antigravity CLI) one-shot subagent provider.
 *
 * @module dsh-subagent-agy
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export declare const name = 'subagent-agy'
export declare const inject: string[]

/** Deployment-owned environment, CLI defaults, and process-release bound. */
export interface Config {
  /** Executable name or absolute path; a bare name falls back to `$HOME/.local/bin/<name>` when PATH misses. */
  command?: string
  /** Explicit environment entries layered over the subprocess seam's scrubbed parent environment. */
  env?: Record<string, string>
  /** Grace in milliseconds for agy process-tree termination. */
  disposeGraceMs?: number
  /** agy execution mode: `accept-edits`, `auto`, `plan`, or empty to keep the host's native agy mode. */
  mode?: string
  /** Model id passed to `--model`; empty keeps the host's native agy choice. */
  model?: string
  /** Reasoning effort passed to `--effort`; empty keeps the host's native agy choice. */
  effort?: string
  /** Optional `--print-timeout` value such as `10m`; empty waits for the turn. */
  timeout?: string
  /** Extra workspace directories passed as repeated `--add-dir`. */
  addDirs?: string[]
  /** Disable agy slash-command and skill expansion for the task text. */
  disableSlashCommands?: boolean
  /** Pass `--dangerously-skip-permissions` so agy can run tools unattended. */
  dangerouslySkipPermissions?: boolean
  /** Opt-in silence watchdog in ms; 0 (default) disables it. agy emits nothing while a tool runs. */
  idleTimeoutMs?: number
  /** Wall-clock cap on one run in ms (default 7_200_000 = 2 hours); 0 disables it. Backstop for runaway/looping runs. */
  maxRunMs?: number
  /** Append a browser-avoidance note to every task (headless browser tools hang). */
  avoidBrowser?: boolean
}

export declare const Config: z<Config>

/** Fully resolved inputs for one agy child run. */
export interface AgyRunSpec {
  /** Parent Session workspace. */
  readonly cwd: string
  /** Fixed argv; the task itself travels over stdin. */
  readonly argv: readonly string[]
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: 'error') => void
  /** Run registry that tracks live progress; defaults to the shared process registry. */
  readonly registry?: AgyRunRegistry
  /**
   * Terminate a run that has produced no stdout for this many milliseconds
   * (0 or omitted disables it).
   */
  readonly idleTimeoutMs?: number
  /**
   * Wall-clock cap in milliseconds (0 or omitted disables it). On expiry the
   * process tree is terminated like a cancel, but the run settles as `error`
   * with a cap diagnostic.
   */
  readonly maxRunMs?: number
  /** Note appended to every task text (e.g. the browser-avoidance warning). */
  readonly promptSuffix?: string
  /**
   * Longest single stdout line accepted before a force-split (bytes); the
   * default caps a runaway no-newline stream so memory stays bounded.
   */
  readonly lineByteCap?: number
  /**
   * Sink for agy stderr chunks; defaults to the host's own stderr. `false`
   * keeps stderr only in the bounded diagnostic tail.
   */
  readonly forwardStderr?: ((chunk: Buffer) => void) | false
}

/** Fields of one `AGY_ERROR: {...}` stderr line. */
export interface AgyErrorInfo {
  readonly shortError?: string
  readonly status?: string
  readonly reason?: string
  readonly retryable?: boolean
}

/** Bounded capture of one agy process's stderr. */
export interface AgyStderrCapture {
  push(chunk: Buffer | string): void
  end(): void
  tail(maxBytes?: number): string
  agyError(): AgyErrorInfo | undefined
}

/** Parse one `AGY_ERROR: {...}` stderr line. */
export declare function parseAgyErrorLine(line: string): AgyErrorInfo | undefined

/**
 * Capture stderr: forward each chunk, keep an 8 KiB tail, remember the last `AGY_ERROR:` line.
 * @param options - tail size and forwarding sink (`false` disables forwarding).
 */
export declare function createStderrCapture(options?: {
  tailBytes?: number
  forward?: ((chunk: Buffer) => void) | false
}): AgyStderrCapture

/**
 * Compose a failure message (no stderr) and model-facing diagnostic (with stderr tail).
 */
export declare function describeAgyFailure(parts: {
  headline: string
  outcome?: { exitCode?: number | null; signal?: string | null }
  record?: object
  now?: number
  agyError?: AgyErrorInfo
  stderrTail?: string
}): { message: string; diagnostic: string }

/**
 * Resolve the agy executable: an explicit path as configured; a bare name on
 * PATH, then `$HOME/.local/bin/<name>`; otherwise a diagnostic naming what was
 * searched and how to fix it. An aborted signal rejects before any lookup.
 */
export declare function resolveAgyExecutable(
  subprocess: { resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> },
  command: string,
  env?: Record<string, string>,
  signal?: AbortSignal,
  options?: { home?: string; path?: string; onFallback?: (resolved: string) => void },
): Promise<string>

/** Labels of the tool actions agy auto-denied, deduplicated. */
export declare function deniedActionLabels(result: unknown): string[]

/** Model-facing note for a completed run that still had denied tool actions. */
export declare function deniedActionsNote(labels: readonly string[]): string

/** Terminal or live state of one tracked agy run. */
export type AgyRunState = 'starting' | 'running' | 'done' | 'failed' | 'aborted'

/** One tracked agy run as the `agy_runs` tool reports it. */
export interface AgyRunStatusRow {
  readonly runId: string
  readonly label: string
  readonly state: AgyRunState
  readonly elapsedMs: number
  readonly lastTool: string
  /** Age of the last tool call, frozen against the settlement time once the run settles. */
  readonly lastToolAgoMs: number
  /** Trailing assistant-text preview (at most 160 chars) the run last streamed. */
  readonly lastText: string
  readonly toolCalls: number
  readonly steps: number
  /** agy conversation id from the event stream ('' until init arrives). */
  readonly conversationId: string
  /** Tool actions agy auto-denied (from the final result event). */
  readonly deniedTools: readonly string[]
  /** One-line failure headline ('' unless failed). */
  readonly error: string
}

/** In-memory registry of live and recently settled agy runs. */
export interface AgyRunRegistry {
  /** The registry's clock, so projections can use the same timebase. */
  now(): number
  /** Record one accepted run and return its mutable record. */
  begin(init: { runId: string; parentId?: string; label?: string; cwd?: string }): object
  /** Fold one parsed agy NDJSON event into a record. */
  observe(record: object, event: unknown): void
  /** Mark one run terminal. */
  settle(record: object, outcome: { stopReason?: string; diagnostic?: string }): object
  /** List one parent Agent's runs, newest first. */
  list(parentId: string): object[]
}

/**
 * Create an in-memory registry of live and recently settled agy runs.
 * @param options - clock, retention window, and record cap.
 */
export declare function createRunRegistry(options?: {
  now?: () => number
  retentionMs?: number
  maxEntries?: number
}): AgyRunRegistry

/** Render a duration in milliseconds as a compact human value. */
export declare function formatRunDuration(ms: number): string

/**
 * Project one internal record into the `agy_runs` canonical row.
 *
 * Callers that built their registry with a custom `now` clock must pass that
 * clock's current time as `now`; the default reads the wall clock.
 */
export declare function runStatusRow(record: object, now?: number): AgyRunStatusRow

/**
 * Build the read-only `agy_runs` tool bound to one run registry.
 * @param registry - registry listing the caller's own runs (tests inject a controlled one).
 */
export declare function defineAgyRunsTool(registry: AgyRunRegistry): ToolDefinition

/**
 * Enforce the single-line byte cap on a stdout stream: a runaway generation
 * with no newline is force-split so the readline buffer stays bounded.
 * @param cap - longest accepted line in bytes.
 */
export declare function createLineCapStream(cap?: number): import('node:stream').Transform

/** Render `agy_runs` rows as the model-facing listing. */
export declare function formatAgyRuns(rows: readonly AgyRunStatusRow[]): string

/**
 * Validate and flatten the one-shot task.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text blocks joined as one agy user message.
 */
export declare function textTask(prompt: readonly ContentBlock[]): string

/**
 * Build the fixed agy argv for one run.
 * @param config - resolved provider configuration.
 * @param executable - resolved executable path.
 * @returns argv with no task text in it.
 */
export declare function buildAgyArgv(config: Config, executable?: string): string[]

/**
 * Derive the only terminal answer a completed run may return.
 * @param result - the `result.result` payload of agy's NDJSON stream.
 * @returns the exact final response text.
 */
export declare function parseAgyResult(result: unknown): string

/**
 * Start one agy child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - argv, environment, process service, and diagnostic policy.
 * @returns the published run handle.
 */
export declare function startAgyRun(request: ResolvedSubagentStartRequest, spec: AgyRunSpec): Promise<SubagentRun>

/**
 * Register the fixed `agy` provider, its read-only `agy_runs` tool, and the
 * delegation guidance context.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - CLI defaults, explicit environment, and disposal grace.
 */
export declare function apply(ctx: Context, config: Config): void

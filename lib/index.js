/**
 * Fixed `agy` (Google Antigravity CLI) one-shot subagent provider.
 *
 * Each accepted run starts one fresh `agy --print` process in the delegating
 * Session's workspace, writes a single `user` event over the CLI's
 * `stream-json` stdin protocol, consumes the NDJSON event stream from stdout,
 * and returns only the final `result.response` through the shared
 * `dsh-subagent` result contract.
 *
 * @module dsh-subagent-agy
 */

import { randomUUID } from 'node:crypto'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { createInterface } from 'node:readline'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  NO_START_CAPABILITIES,
  assertPositiveFinite,
  assertUsableCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'

const PREFIX = 'subagent-agy'
/** Model-facing delegation tool name; must match `cordis.patch.yml` `toolName`. */
const DELEGATION_TOOL_NAME = 'subagent_agy'
const DEFAULT_DISPOSE_GRACE_MS = 3000
/** Default wall-clock cap on one run: 2 hours. */
const DEFAULT_MAX_RUN_MS = 2 * 60 * 60 * 1000
/** Modes the agy builds verified so far accept; unknown values pass through with a warning so a CLI upgrade never dead-ends the plugin. */
const KNOWN_MODES = new Set(['', 'accept-edits', 'auto', 'plan'])
/** Efforts agy documents today; same pass-through policy as KNOWN_MODES. */
const KNOWN_EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Cordis plugin name. */
export const name = 'subagent-agy'

/** Services this provider needs before it can register. */
export const inject = ['subagents', 'subprocess']

/** Deployment-owned environment, CLI defaults, and process-release bound. */
export const Config = z.object({
  /**
   * Executable name or absolute path resolved through `ctx.subprocess`. A
   * path is used as configured; a bare name falls back to
   * `$HOME/.local/bin/<name>` (agy's default install dir) when PATH misses.
   */
  command: z.string().default('agy'),
  /** Explicit environment entries layered over the subprocess seam's scrubbed parent environment. */
  env: z.dict(z.string()).default({}),
  /** Grace in milliseconds for agy process-tree termination. */
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  /** agy execution mode: `accept-edits`, `auto`, `plan`, or empty to keep the host's native agy mode. */
  mode: z.string().default(''),
  /** Model id passed to `--model`; empty keeps the host's native agy choice. */
  model: z.string().default(''),
  /** Reasoning effort passed to `--effort`; empty keeps the host's native agy choice. */
  effort: z.string().default(''),
  /** Optional `--print-timeout` value such as `10m`; empty waits for the turn. */
  timeout: z.string().default(''),
  /** Extra workspace directories passed as repeated `--add-dir`. */
  addDirs: z.array(z.string()).default([]),
  /**
   * Disable agy slash-command and skill expansion for the task text.
   * `plan` mode is itself a slash command, so it requires this to be false.
   */
  disableSlashCommands: z.boolean().default(true),
  /**
   * Pass `--dangerously-skip-permissions` so agy can run tools unattended.
   * Volatile so the plugin-detail toggle and the settings form can change it
   * without remounting the provider.
   */
  dangerouslySkipPermissions: z.boolean().default(false).volatile(),
  /**
   * Opt-in silence watchdog: terminate a run that has produced no stdout for
   * this many milliseconds. 0 (default) disables it: agy emits nothing while
   * a tool runs, so any fixed silence bound also kills legitimately long
   * commands.
   */
  idleTimeoutMs: z.number().default(0),
  /**
   * Wall-clock cap on one run in milliseconds (default 2 hours); 0 disables
   * it. A deliberately loose backstop that stops a runaway or looping
   * unattended subagent (a loop keeps emitting events, so no silence timer
   * can catch it) and covers hangs. Real stops come from cancelling the
   * delegation, which keeps working instantly.
   */
  maxRunMs: z.number().default(DEFAULT_MAX_RUN_MS),
  /**
   * Append a browser-avoidance note to every task: agy's headless `browser_*`
   * tools can hang indefinitely (launch/page load never completing), which
   * freezes the whole run with zero output. agy verifies pages by reading
   * files and running commands instead.
   */
  avoidBrowser: z.boolean().default(true),
})

/**
 * Validate and flatten the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text blocks joined as one agy user message.
 */
export function textTask(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new Error(`${PREFIX}: the one-shot task must contain only text blocks`)
  }
  const texts = []
  for (const block of prompt) {
    if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error(`${PREFIX}: the one-shot task must contain only text blocks`)
    }
    texts.push(block.text)
  }
  if (texts.every((text) => text.trim().length === 0)) {
    throw new Error(`${PREFIX}: the one-shot task must not be empty`)
  }
  return texts.join('\n\n')
}

/**
 * Read a config field that may be a cosmokit volatile reference.
 * @param value - plain value or volatile reference.
 * @returns the current plain value.
 */
function readVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** Settled runs stay queryable for this long before the registry prunes them. */
const RUN_RETENTION_MS = 10 * 60 * 1000
/** Hard cap on retained run records; the oldest settled entries are dropped first. */
const RUN_MAX_ENTRIES = 50
/** Longest assistant-text preview kept per run. */
const RUN_TEXT_PREVIEW = 160
/**
 * Grace for the stdout stream to drain after the agy process exits. A
 * tool-spawned grandchild can keep the pipe open indefinitely; a completed
 * turn must not wait on it.
 */
const STREAM_DRAIN_MS = 250
/** Cap on the buffered streamed transcript kept as fallback output. */
const STREAM_TEXT_CAP = 64 * 1024
/** Bytes of agy stderr kept per run (ring buffer) for failure diagnostics. */
const STDERR_TAIL_BYTES = 8 * 1024
/**
 * Bytes of that stderr tail copied into a failure diagnostic. The shared
 * subagent contract caps a diagnostic at 4 KiB, so the facts lines come first
 * and the tail takes only part of the budget.
 */
const DIAGNOSTIC_STDERR_BYTES = 1536
/** Longest partial stderr line held while scanning for `AGY_ERROR:` lines. */
const STDERR_LINE_CAP = 16 * 1024
/** agy prints one structured failure line on stderr: `AGY_ERROR: {json}`. */
const AGY_ERROR_LINE = /^\s*AGY_ERROR:\s*(\{.*\})\s*$/
/**
 * Longest single stdout line accepted before it is force-split. The agy
 * protocol is one NDJSON event per line; a pathological upstream (a runaway
 * generation with no newline) must not grow the readline buffer without
 * bound. A split line fails JSON parsing and is ignored like other noise.
 */
const LINE_BYTE_CAP = 4 * 1024 * 1024
/**
 * Appended to every task when `avoidBrowser` is on: agy's headless
 * `browser_*` tools can hang indefinitely (browser launch / page load never
 * completing) and freeze the run with no output.
 */
const AVOID_BROWSER_SUFFIX =
  '\n\n(Environment note: headless browser tools are unreliable in this environment and can hang the run indefinitely. Do NOT use browser_* tools, do NOT open URLs in a browser, and do NOT wait on page loads. Verify pages and UI by reading the source files and running commands instead.)'
/** Model-facing guidance registered beside the `agy_runs` tool. */
const AGY_RUNS_CONTEXT = '`subagent_agy` children are external one-shot runs, not in-process Agents: `list_agents`, `wait_agent`, and `send_message` never list or reach them, so never poll `list_agents` for an agy child and never sleep waiting on one. A delegation returns its id immediately; the runtime delivers a completion notice with the final answer (or a failure diagnostic) when the run settles, so continue with independent work meanwhile. To check live progress, call `agy_runs`: it reports elapsed time, step count, and the last tool each of your agy runs used.'

/** Render a duration in milliseconds as a compact human value. */
export function formatRunDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * Enforce the single-line byte cap on a stdout stream.
 *
 * The agy protocol is one NDJSON event per line, so the readline interface
 * buffers whatever the longest line holds. A pathological upstream — a
 * runaway generation emitting megabytes with no newline — would otherwise
 * grow that buffer until the host process runs out of memory. Oversized
 * lines are force-split: the truncated fragment fails JSON parsing and is
 * ignored like any other stdout noise.
 *
 * @param cap - longest accepted line in bytes.
 * @returns a Transform capping lines at `cap` bytes.
 */
export function createLineCapStream(cap = LINE_BYTE_CAP) {
  /** Bytes seen since the last line break in the current line. */
  let current = 0
  /** True while the remainder of an already-split line is being skipped. */
  let discarding = false
  return new Transform({
    transform(chunk, _enc, callback) {
      try {
        let offset = 0
        while (offset < chunk.length) {
          if (discarding) {
            const nl = chunk.indexOf(0x0a, offset)
            if (nl === -1) break
            discarding = false
            current = 0
            offset = nl + 1
            continue
          }
          const nl = chunk.indexOf(0x0a, offset)
          const end = nl === -1 ? chunk.length : nl + 1
          const segment = end - offset
          if (current + segment > cap) {
            const room = cap - current
            if (room > 0) this.push(chunk.subarray(offset, offset + room))
            this.push(Buffer.from('\n'))
            current = 0
            if (nl === -1) {
              discarding = true
              break
            }
            offset = end
            continue
          }
          this.push(chunk.subarray(offset, end))
          current = nl === -1 ? current + segment : 0
          offset = end
        }
        callback()
      } catch (error) {
        callback(error)
      }
    },
  })
}

/**
 * Drop leading UTF-8 continuation bytes so a byte-trimmed tail decodes cleanly.
 * @param bytes - tail bytes that may start mid-character.
 */
function utf8Tail(bytes) {
  let start = 0
  while (start < bytes.length && start < 4 && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1
  return bytes.subarray(start).toString('utf8')
}

/**
 * Parse one `AGY_ERROR: {...}` stderr line into its structured fields.
 * @param line - one stderr line.
 * @returns the parsed fields, or undefined when the line is not an agy error.
 */
export function parseAgyErrorLine(line) {
  const match = AGY_ERROR_LINE.exec(line)
  if (match === null) return undefined
  let value
  try {
    value = JSON.parse(match[1])
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const text = (key) => (typeof value[key] === 'string' && value[key].trim().length > 0 ? value[key].trim() : undefined)
  const parsed = {}
  if (text('short_error') !== undefined) parsed.shortError = text('short_error')
  if (text('status') !== undefined) parsed.status = text('status')
  if (text('reason') !== undefined) parsed.reason = text('reason')
  if (typeof value.retryable === 'boolean') parsed.retryable = value.retryable
  return Object.keys(parsed).length === 0 ? undefined : parsed
}

/** Forward agy stderr bytes to the host's own stderr, as the Codex provider does. */
function forwardToHostStderr(chunk) {
  try {
    writeFileSync(process.stderr.fd, chunk)
  } catch {
    // A closed or non-blocking host stderr must not break the run.
  }
}

/**
 * Capture one agy process's stderr: forward every chunk to the host, keep a
 * bounded tail for diagnostics, and remember the last `AGY_ERROR:` line.
 * @param options - tail size and forwarding sink (`false` disables forwarding).
 * @returns capture with `push(chunk)`, `end()`, `tail(maxBytes?)`, and `agyError()`.
 */
export function createStderrCapture(options = {}) {
  const tailBytes = options.tailBytes ?? STDERR_TAIL_BYTES
  const forward = options.forward === false ? undefined : options.forward ?? forwardToHostStderr
  let tail = Buffer.alloc(0)
  let partial = ''
  let agyError
  const scanLine = (line) => {
    const parsed = parseAgyErrorLine(line)
    if (parsed !== undefined) agyError = parsed
  }
  return {
    /** @param chunk - one stderr chunk (Buffer or string). */
    push(chunk) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (forward !== undefined) {
        try {
          forward(bytes)
        } catch {
          // Forwarding is best-effort observability.
        }
      }
      tail = tail.length + bytes.length <= tailBytes
        ? Buffer.concat([tail, bytes])
        : Buffer.concat([tail, bytes]).subarray(-tailBytes)
      const lines = (partial + bytes.toString('utf8')).split(/\r?\n/)
      partial = lines.pop() ?? ''
      if (partial.length > STDERR_LINE_CAP) partial = ''
      for (const line of lines) scanLine(line)
    },
    /** Flush a final unterminated line. */
    end() {
      if (partial.length > 0) scanLine(partial)
      partial = ''
    },
    /** @param maxBytes - longest tail returned. @returns trimmed stderr tail text. */
    tail(maxBytes = tailBytes) {
      return utf8Tail(tail.length > maxBytes ? tail.subarray(-maxBytes) : tail).trim()
    },
    /** @returns the last parsed `AGY_ERROR:` fields, if any. */
    agyError() {
      return agyError
    },
  }
}

/**
 * Compose the failure text for one run from its headline and observed facts.
 * @param parts - headline, process outcome, run record, clock, agy error, and stderr tail.
 * @returns `{ message, diagnostic }`: the message omits the stderr tail (the
 *   host already received stderr), the model-facing diagnostic includes it.
 */
export function describeAgyFailure(parts) {
  const facts = []
  const outcome = parts.outcome
  if (outcome !== undefined && outcome !== null) {
    if (outcome.exitCode !== null && outcome.exitCode !== undefined) facts.push(`exit code: ${String(outcome.exitCode)}`)
    if (outcome.signal !== null && outcome.signal !== undefined) facts.push(`signal: ${String(outcome.signal)}`)
  }
  const record = parts.record
  if (record !== undefined) {
    if (record.conversationId) facts.push(`conversation: ${record.conversationId}`)
    if (record.steps > 0) facts.push(`steps: ${String(record.steps)}`)
    if (record.activeTool) {
      const since = record.activeToolSince === undefined ? '' : ` (started ${formatRunDuration((parts.now ?? Date.now()) - record.activeToolSince)} before the failure)`
      facts.push(`tool still running: ${record.activeTool}${since}`)
    } else if (record.lastTool) {
      facts.push(`last tool: ${record.lastTool}`)
    }
    if (Array.isArray(record.deniedTools) && record.deniedTools.length > 0) facts.push(`denied tools: ${record.deniedTools.join(', ')}`)
  }
  const lines = [parts.headline]
  if (facts.length > 0) lines.push(`agy facts: ${facts.join('; ')}`)
  const agyError = parts.agyError
  if (agyError !== undefined) {
    const fields = []
    if (agyError.reason !== undefined) fields.push(`reason: ${agyError.reason}`)
    if (agyError.status !== undefined) fields.push(`status: ${agyError.status}`)
    if (agyError.retryable !== undefined) fields.push(`retryable: ${String(agyError.retryable)}`)
    const detail = agyError.shortError ?? 'structured error'
    lines.push(`agy error: ${detail}${fields.length > 0 ? ` (${fields.join('; ')})` : ''}`)
  }
  const message = lines.join('\n')
  const stderrTail = parts.stderrTail ?? ''
  const diagnostic = stderrTail.length > 0 ? `${message}\nagy stderr (tail):\n${stderrTail}` : message
  return { message, diagnostic }
}

/**
 * Create the in-memory registry of live and recently settled agy runs.
 * @param options - clock, retention window, and record cap (tests override them).
 * @returns registry with begin/observe/settle/list over one process's runs.
 */
export function createRunRegistry(options = {}) {
  const now = options.now ?? Date.now
  const retentionMs = options.retentionMs ?? RUN_RETENTION_MS
  const maxEntries = options.maxEntries ?? RUN_MAX_ENTRIES
  /** @type {Map<string, object>} */
  const records = new Map()

  const prune = () => {
    const cutoff = now() - retentionMs
    for (const [id, record] of records) {
      if (record.settledAt !== undefined && record.settledAt < cutoff) records.delete(id)
    }
    if (records.size <= maxEntries) return
    // Only settled records are evicted, oldest first: a live run must stay
    // trackable through `agy_runs` even when newer runs have already settled.
    const settled = [...records.values()]
      .filter((record) => record.settledAt !== undefined)
      .sort((left, right) => left.settledAt - right.settledAt)
    for (const record of settled.slice(0, records.size - maxEntries)) records.delete(record.runId)
  }

  return {
    /** The registry's clock, so projections can use the same timebase. */
    now,
    /**
     * Record one accepted run.
     * @param init - run identity, owning parent id, label, and workspace.
     * @returns the mutable record this run updates.
     */
    begin(init) {
      const record = {
        runId: init.runId,
        parentId: init.parentId ?? '',
        label: init.label ?? '',
        cwd: init.cwd ?? '',
        startedAt: now(),
        settledAt: undefined,
        state: 'starting',
        steps: 0,
        toolCalls: 0,
        lastTool: '',
        lastToolAt: undefined,
        lastText: '',
        permissionMode: '',
        conversationId: '',
        activeTool: '',
        activeToolSince: undefined,
        deniedTools: [],
        error: '',
      }
      records.set(record.runId, record)
      // Prune after insert: the cap holds at exactly `maxEntries`, and a
      // freshly published live run is never the record dropped for it.
      prune()
      return record
    },
    /**
     * Fold one parsed agy NDJSON event into a record.
     * @param record - the record returned by `begin`.
     * @param event - parsed agy event.
     */
    observe(record, event) {
      if (record.settledAt !== undefined) return
      if (record.conversationId === '') {
        const nested = event[event.event]
        const id = typeof event.conversation_id === 'string'
          ? event.conversation_id
          : nested !== null && typeof nested === 'object' && typeof nested.conversation_id === 'string' ? nested.conversation_id : ''
        if (id.length > 0) record.conversationId = id
      }
      if (event.event === 'init') {
        const init = event.init
        if (init !== null && typeof init === 'object' && typeof init.permission_mode === 'string') {
          record.permissionMode = init.permission_mode
        }
        if (record.state === 'starting') record.state = 'running'
        return
      }
      if (event.event === 'result') {
        record.deniedTools = deniedActionLabels(event.result)
        return
      }
      if (event.event !== 'step_update') return
      const update = event.step_update
      if (update === null || typeof update !== 'object') return
      if (record.state === 'starting') record.state = 'running'
      if (typeof update.step_index === 'number' && update.step_index > record.steps) {
        record.steps = update.step_index
      }
      if (update.step_type === 'tool') {
        const info = update.tool_info
        const toolName = info !== null && typeof info === 'object' && typeof info.name === 'string' ? info.name : ''
        if (toolName.length > 0) {
          record.lastTool = toolName
          record.lastToolAt = now()
          if (update.state === 'ACTIVE') {
            if (record.activeTool !== toolName) record.activeToolSince = now()
            record.activeTool = toolName
          } else {
            record.activeTool = ''
            record.activeToolSince = undefined
          }
          if (update.state === 'DONE') record.toolCalls += 1
        }
        return
      }
      if (update.step_type === 'agent_response' && typeof update.text_delta === 'string' && update.text_delta.length > 0) {
        const combined = record.lastText + update.text_delta
        record.lastText = combined.length > RUN_TEXT_PREVIEW ? combined.slice(-RUN_TEXT_PREVIEW) : combined
      }
    },
    /**
     * Mark one run terminal.
     * @param record - the record returned by `begin`.
     * @param outcome - settled stop reason and optional diagnostic.
     */
    settle(record, outcome) {
      if (record.settledAt !== undefined) return record
      record.settledAt = now()
      const stopReason = outcome === null || typeof outcome !== 'object' ? undefined : outcome.stopReason
      record.state = stopReason === 'completed' ? 'done' : stopReason === 'aborted' ? 'aborted' : 'failed'
      if (record.state === 'failed') {
        const diagnostic = outcome !== null && typeof outcome === 'object' && typeof outcome.diagnostic === 'string' ? outcome.diagnostic.trim() : ''
        // The listing is one line per run: keep the headline, not the facts/stderr block.
        const headline = diagnostic.split('\n', 1)[0].trim()
        record.error = headline.length > 0 ? headline : 'agy run failed'
      }
      return record
    },
    /**
     * List one parent's runs, newest first.
     * @param parentId - delegating Agent id.
     */
    list(parentId) {
      prune()
      return [...records.values()]
        .filter((record) => record.parentId === parentId)
        .sort((left, right) => right.startedAt - left.startedAt)
    },
  }
}

/** Process-wide registry shared by every provider instance and the `agy_runs` tool. */
const defaultRunRegistry = createRunRegistry()

/**
 * Build the read-only `agy_runs` tool bound to one run registry.
 * @param registry - registry listing the caller's own runs (tests inject a controlled one).
 * @returns the complete tool definition ready for `ctx.tools.register`.
 */
export function defineAgyRunsTool(registry) {
  return defineTool({
    name: 'agy_runs',
    description:
      'List your own `subagent_agy` runs (live and recently settled) with elapsed time, step count, the last tool each used, and a trailing text preview for live runs. agy runs are external: they never appear in `list_agents`, cannot be messaged, and settle with a completion notice. Use this instead of polling or sleeping; do not call it for local in-process subagents.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'string', required: true },
            label: { type: 'string', required: true },
            state: {
              type: 'string',
              required: true,
              enum: ['starting', 'running', 'done', 'failed', 'aborted'],
            },
            elapsedMs: { type: 'number', required: true },
            lastTool: { type: 'string', required: true },
            lastToolAgoMs: { type: 'number', required: true },
            lastText: { type: 'string', required: true },
            toolCalls: { type: 'number', required: true },
            steps: { type: 'number', required: true },
            conversationId: { type: 'string', required: true },
            deniedTools: { type: 'array', items: { type: 'string' }, required: true },
            error: { type: 'string', required: true },
          },
        },
      },
      render: (_args, rows) => [{ type: 'text', text: formatAgyRuns(rows) }],
    },
    execute(_args, exec) {
      const now = registry.now()
      const rows = registry.list(exec.agent?.id ?? '').map((record) => runStatusRow(record, now))
      return Promise.resolve(rows)
    },
  })
}

/**
 * Project one registry record into the `agy_runs` tool's canonical row.
 * @param record - internal record.
 * @param now - current epoch milliseconds.
 */
export function runStatusRow(record, now = Date.now()) {
  return {
    runId: record.runId,
    label: record.label,
    state: record.state,
    elapsedMs: Math.max(0, (record.settledAt ?? now) - record.startedAt),
    lastTool: record.lastTool,
    // Settled runs freeze the age against their settlement time; a finished
    // row must not report a tool that keeps receding into the past.
    lastToolAgoMs: record.lastToolAt === undefined ? 0 : Math.max(0, (record.settledAt ?? now) - record.lastToolAt),
    lastText: record.lastText ?? '',
    toolCalls: record.toolCalls,
    steps: record.steps,
    conversationId: record.conversationId ?? '',
    deniedTools: Array.isArray(record.deniedTools) ? [...record.deniedTools] : [],
    error: record.error,
  }
}

/**
 * Render `agy_runs` rows as the model-facing listing.
 * @param rows - canonical rows from `runStatusRow`.
 * @returns one line per run, or a placeholder when the list is empty.
 */
export function formatAgyRuns(rows) {
  if (rows.length === 0) return '(no agy runs)'
  return rows
    .map((row) => {
      const parts = [
        `${String(row.runId).slice(0, 8)} [${row.state}] ${row.label.length > 0 ? row.label : '(unlabeled)'}`,
        formatRunDuration(row.elapsedMs),
      ]
      if (row.lastTool.length > 0) parts.push(`last tool ${row.lastTool} (${formatRunDuration(row.lastToolAgoMs)} ago)`)
      if (row.lastText.length > 0 && (row.state === 'starting' || row.state === 'running')) {
        parts.push(`text …${row.lastText.slice(-40)}`)
      }
      if (row.toolCalls > 0) parts.push(`${row.toolCalls} tool calls`)
      if (row.steps > 0) parts.push(`step ${row.steps}`)
      if (row.deniedTools?.length > 0) parts.push(`denied: ${row.deniedTools.join(', ')}`)
      if (row.conversationId?.length > 0) parts.push(`conversation ${row.conversationId}`)
      if (row.error.length > 0) parts.push(`error: ${row.error}`)
      return parts.join(' · ')
    })
    .join('\n')
}

/**
 * Build the fixed agy argv for one run.
 * @param config - resolved provider configuration.
 * @param executable - resolved executable path (defaults to the configured command).
 * @returns argv with no task text in it; the task travels over stdin.
 */
export function buildAgyArgv(config, executable = config.command) {
  const argv = [
    executable,
    '--print=',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ]
  if (config.disableSlashCommands) argv.push('--disable-slash-commands')
  if (config.mode) argv.push('--mode', config.mode)
  if (config.model) argv.push('--model', config.model)
  if (config.effort) argv.push('--effort', config.effort)
  if (config.timeout) argv.push('--print-timeout', config.timeout)
  if (readVolatile(config.dangerouslySkipPermissions)) argv.push('--dangerously-skip-permissions')
  for (const dir of config.addDirs ?? []) argv.push('--add-dir', dir)
  return argv
}

/**
 * Derive the only terminal answer a completed run may return.
 * @param result - the `result.result` payload of agy's NDJSON stream.
 * @returns the exact final response text.
 */
export function parseAgyResult(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${PREFIX}: agy returned an invalid result event`)
  }
  if (typeof result.error === 'string' && result.error.trim().length > 0) {
    throw new Error(`${PREFIX}: agy failed: ${result.error.trim()}`)
  }
  if (result.finished_reason === 'print_timeout') {
    throw new Error(`${PREFIX}: agy print timeout expired before the turn completed`)
  }
  if (typeof result.finished_reason === 'string' && result.finished_reason.length > 0 && result.finished_reason !== 'completed') {
    throw new Error(`${PREFIX}: agy turn ended early (${result.finished_reason})`)
  }
  if (result.status !== 'SUCCESS') {
    throw new Error(`${PREFIX}: agy ended with status ${String(result.status)}`)
  }
  if (typeof result.response === 'string' && result.response.trim().length > 0) {
    return result.response
  }
  const denied = deniedActionLabels(result)
  const detail = denied.length > 0 ? ` (denied tools: ${denied.join(', ')})` : ''
  throw new Error(`${PREFIX}: agy produced no final answer${detail}`)
}

/**
 * Labels of the tool actions agy auto-denied during a run.
 * @param result - the `result.result` payload (any shape).
 * @returns display names (or action kinds), deduplicated in first-seen order.
 */
export function deniedActionLabels(result) {
  if (result === null || typeof result !== 'object' || !Array.isArray(result.denied_actions)) return []
  const labels = result.denied_actions
    .map((action) => (typeof action === 'string'
      ? action
      : action && typeof action === 'object'
        ? action.display_name ?? action.action
        : undefined))
    .filter((label) => typeof label === 'string' && label.length > 0)
  return [...new Set(labels)]
}

/**
 * Model-facing note for a completed run that still had tool actions denied.
 * @param labels - denied action labels.
 */
export function deniedActionsNote(labels) {
  return `${PREFIX}: note: agy auto-denied ${String(labels.length)} tool action(s) during this run (${labels.join(', ')}); the answer may be incomplete. Headless agy cannot ask for approval: enable dangerouslySkipPermissions or add permissions.allow rules to agy's settings to permit them.`
}

/** Normalize an unknown thrown value. */
function toError(value) {
  return value instanceof Error ? value : new Error(String(value))
}

/** Promise-based delay for the post-exit stream drain window. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * End stdin, terminate the managed process tree, and wait for it to be gone.
 * @param child - shared-service handle that owns the process tree.
 */
async function disposeAgyChild(child) {
  try {
    child.stdin?.end()
  } catch {
    // stdin may already be closed; teardown continues.
  }
  child.terminate()
  try {
    await child.waitForExit()
  } catch {
    // The outcome promise below remains the authoritative exit observation.
  }
  try {
    await child.done
  } catch {
    // A failed spawn has no live tree left to release.
  }
}

/**
 * Start one agy child and publish its one-shot run.
 * @param request - resolved shared subagent request (absolute cwd, text prompt, signal).
 * @param spec - argv, environment, process service, and diagnostic policy.
 * @returns the published run handle.
 */
export async function startAgyRun(request, spec) {
  const prompt = textTask(request.prompt) + (spec.promptSuffix ?? '')
  const cwd = assertUsableCwd(PREFIX, 'child working directory', request.cwd ?? spec.cwd)
  const registry = spec.registry ?? defaultRunRegistry
  const runId = SessionId(randomUUID())
  if (request.signal.aborted) {
    throw new Error(`${PREFIX}: request was aborted before agy startup`)
  }

  const child = spec.spawn({
    argv: spec.argv,
    cwd,
    stdio: {
      stdin: 'pipe',
      stdout: 'pipe',
      // Piped, not inherited: agy explains most failures only on stderr
      // (permission hints, `AGY_ERROR: {...}`), while its exit code stays 0.
      // Every chunk is still forwarded to the host's stderr.
      stderr: 'pipe',
    },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })
  if (child.stdin === undefined || child.stdout === undefined) {
    child.terminate()
    throw new Error(`${PREFIX}: agy process did not expose piped stdio`)
  }

  const record = registry.begin({
    runId,
    parentId: request.parent?.id ?? '',
    label: typeof request.label === 'string' ? request.label : '',
    cwd,
  })

  // A child that exits before draining stdin (for example, a bad --model)
  // surfaces EPIPE here; the exit/result path remains the authoritative cause.
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})

  const stderr = createStderrCapture({ forward: spec.forwardStderr })
  /** Resolves once stderr ended (or immediately when the host gave no stderr pipe). */
  let stderrClosed = Promise.resolve()
  if (child.stderr !== undefined && child.stderr !== null) {
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.stderr.on('error', () => {})
    stderrClosed = new Promise((resolve) => {
      child.stderr.once('end', resolve)
      child.stderr.once('close', resolve)
    })
  }

  const state = {
    /** @type {unknown} */
    result: undefined,
    streamed: '',
    diagnostic: undefined,
    /** Parsed NDJSON events seen so far. */
    events: 0,
  }

  // Cap single lines before the readline interface buffers them: a runaway
  // generation with no newline must not grow memory without bound.
  const capped = child.stdout.pipe(createLineCapStream(spec.lineByteCap))
  capped.on('error', () => {})
  const lines = createInterface({ input: capped, crlfDelay: Infinity })
  let linesClosed = false
  const streamClosed = new Promise((resolve) => {
    lines.once('close', () => {
      linesClosed = true
      resolve()
    })
  })

  // Silence watchdog: agy can hang with zero output (network stall, auth
  // wait, a wedged headless browser tool) while ignoring its own
  // `--print-timeout`; the local timer terminates the tree so the run can
  // settle with a clear diagnostic instead of waiting forever.
  const idleTimeoutMs = spec.idleTimeoutMs ?? 0
  let idleTimedOut = false
  let silenceTimer
  const disarmSilence = () => {
    if (silenceTimer !== undefined) {
      clearTimeout(silenceTimer)
      silenceTimer = undefined
    }
  }
  const armSilence = () => {
    if (!(idleTimeoutMs > 0)) return
    disarmSilence()
    silenceTimer = setTimeout(() => {
      idleTimedOut = true
      child.terminate()
    }, idleTimeoutMs)
  }

  // Wall-clock cap: a loose backstop for a runaway or looping unattended run.
  // It kills the tree exactly like a cancel, but the run settles as `error`
  // (runAbort stays untouched) with a cap diagnostic.
  const maxRunMs = spec.maxRunMs ?? 0
  let capHit = false
  let capTimer
  const disarmCap = () => {
    if (capTimer !== undefined) {
      clearTimeout(capTimer)
      capTimer = undefined
    }
  }
  const disarmTimers = () => {
    disarmSilence()
    disarmCap()
  }

  // The stream observer exists before any abort wiring, so `requestCancel` can
  // always cut it — even for an abort landing between listener registration
  // and this point.
  const runAbort = new AbortController()
  const requestCancel = () => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error(`${PREFIX}: run cancelled locally`))
    disarmTimers()
    if (!linesClosed) lines.close()
    child.terminate()
  }
  const onAbort = () => {
    requestCancel()
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  // An already-aborted signal never fires `abort` again; cover the race
  // between the pre-spawn check and listener registration.
  if (request.signal.aborted) requestCancel()

  if (maxRunMs > 0 && !runAbort.signal.aborted) {
    capTimer = setTimeout(() => {
      capTimer = undefined
      if (runAbort.signal.aborted) return
      capHit = true
      disarmSilence()
      if (!linesClosed) lines.close()
      child.terminate()
    }, maxRunMs)
  }
  armSilence()
  lines.on('line', (line) => {
    armSilence()
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      // agy diagnostics are not JSON; stderr is inherited and stdout noise is ignored.
      return
    }
    if (event === null || typeof event !== 'object') return
    state.events += 1
    registry.observe(record, event)
    if (event.event === 'step_update') {
      const update = event.step_update
      if (update !== null && typeof update === 'object' && update.step_type === 'agent_response' && typeof update.text_delta === 'string') {
        // Fallback output for aborted/error runs: keep only the tail so a
        // long transcript cannot grow the record without bound.
        state.streamed = (state.streamed + update.text_delta).slice(-STREAM_TEXT_CAP)
      }
      return
    }
    if (event.event === 'result') state.result = event.result
  })

  if (!runAbort.signal.aborted) {
    try {
      child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`)
    } catch (error) {
      request.signal.removeEventListener('abort', onAbort)
      disarmTimers()
      registry.settle(record, { stopReason: 'error', diagnostic: toError(error).message })
      if (!linesClosed) lines.close()
      await disposeAgyChild(child)
      throw toError(error)
    }
  }

  /** @type {{ exitCode?: number | null, signal?: string | null } | undefined} */
  let outcome
  /** Headline for a run that ended without any result event. */
  const missingResultHeadline = () => {
    if (capHit) {
      const cap = maxRunMs % 60_000 === 0 ? `${String(maxRunMs / 60_000)}-minute` : `${String(maxRunMs)}ms`
      return `${PREFIX}: agy run hit the ${cap} run cap (maxRunMs) after ${formatRunDuration(registry.now() - record.startedAt)}; the process tree was terminated. The cap is a backstop for runaway or looping runs: raise maxRunMs (0 disables it) if the task legitimately needs longer.`
    }
    if (idleTimedOut) {
      if (state.events === 0) {
        return `${PREFIX}: agy produced no output for ${String(idleTimeoutMs)}ms (idle timeout); the process tree was terminated. Likely causes: an authentication wait, a network stall, or a startup hang.`
      }
      if (record.activeTool) {
        const browser = /browser/i.test(record.activeTool)
        return `${PREFIX}: agy went silent for ${String(idleTimeoutMs)}ms while tool ${record.activeTool} was still running (idle timeout); the process tree was terminated. ${browser
          ? 'Headless browser tools are a known hang (config avoidBrowser).'
          : 'agy emits nothing while a tool runs, so a legitimately long command also trips this watchdog (raise idleTimeoutMs, or set it to 0).'}`
      }
      return `${PREFIX}: agy went silent for ${String(idleTimeoutMs)}ms after ${String(state.events)} event(s) with no tool running (idle timeout); the process tree was terminated. Likely causes: a network stall or a model backend hang.`
    }
    return `${PREFIX}: agy exited without a result event. Likely causes: agy rejected a startup flag or config value, an authentication or network failure, the process was killed, or a crash; see the agy error and stderr tail.`
  }

  const attempt = async () => {
    try {
      outcome = await child.done
      // A tool-spawned grandchild can keep stdout open after agy exits; the
      // turn's completion must not wait on it. Drain the streams briefly, then
      // cut them and judge whatever was parsed.
      const drains = [Promise.race([stderrClosed, delay(STREAM_DRAIN_MS)])]
      if (!linesClosed) {
        drains.push((async () => {
          await Promise.race([streamClosed, delay(STREAM_DRAIN_MS)])
          if (!linesClosed) lines.close()
          await streamClosed
        })())
      }
      await Promise.all(drains)
      stderr.end()
      if (state.result === undefined) throw new Error(missingResultHeadline())
      const text = parseAgyResult(state.result)
      const denied = deniedActionLabels(state.result)
      return {
        output: [{ type: 'text', text }],
        stopReason: 'completed',
        // Model-visible even on success: a partly denied run must not look clean.
        ...denied.length > 0 ? { diagnostic: deniedActionsNote(denied) } : {},
      }
    } catch (error) {
      stderr.end()
      const cause = toError(error)
      const failure = describeAgyFailure({
        headline: cause.message,
        outcome,
        record,
        now: registry.now(),
        agyError: stderr.agyError(),
        stderrTail: stderr.tail(DIAGNOSTIC_STDERR_BYTES),
      })
      state.diagnostic = failure.diagnostic
      throw new Error(failure.message, { cause })
    }
  }

  const result = settleRunResult({
    attempt,
    collectOutput: () => (state.streamed.trim().length === 0 ? [] : [{ type: 'text', text: state.streamed }]),
    collectDiagnostic: () => state.diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })
  // Track settlement without consuming the result the runtime also awaits.
  // The record is best-effort observability: its settlement must never surface
  // as an unhandled rejection if the registry itself ever throws.
  result.then(
    (outcome) => {
      disarmTimers()
      registry.settle(record, outcome)
    },
    (error) => {
      disarmTimers()
      registry.settle(record, { stopReason: 'error', diagnostic: toError(error).message })
    },
  ).catch(() => {})

  return subprocessRunHandle({
    id: runId,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => {
      disarmTimers()
      // Unblock the stream observer first: a grandchild holding stdout open
      // must not keep `attempt()` — and thus settlement — waiting past disposal.
      if (!linesClosed) lines.close()
      // Disposal is terminal from the caller's side. The idempotent settle
      // guard keeps an already-correct terminal state (done/failed/aborted)
      // intact; only a still-live record flips to `aborted`.
      registry.settle(record, { stopReason: 'aborted' })
      return disposeAgyChild(child)
    },
  })
}

/** Whether a resolution failure means "no such executable" (vs. a provider failure). */
function isExecutableNotFound(error) {
  return error !== null && typeof error === 'object' && error.name === 'SubprocessExecutableNotFoundError'
}

/** Compact `PATH` summary for a diagnostic: first few dirs plus a count. */
function summarizePath(pathValue) {
  const dirs = typeof pathValue === 'string' ? pathValue.split(delimiter).filter((dir) => dir.length > 0) : []
  if (dirs.length === 0) return 'PATH is empty or unset'
  const shown = dirs.slice(0, 6).join(', ')
  return `PATH (${String(dirs.length)} dirs: ${shown}${dirs.length > 6 ? `, +${String(dirs.length - 6)} more` : ''})`
}

/**
 * Resolve the agy executable. An explicit path in `command` (absolute, or
 * containing a slash) is used as configured. A bare name is looked up on the
 * child's PATH first; when that misses — typical for a dsh service whose PATH
 * lacks `~/.local/bin`, agy's default install dir — `$HOME/.local/bin/<name>`
 * is tried. Both lookups go through the subprocess service, so existence and
 * the executable bit are checked in the execution world that will spawn it.
 * @param subprocess - the `ctx.subprocess` service.
 * @param command - configured `command`.
 * @param env - configured child environment (its `HOME`/`PATH` win over the host's).
 * @param signal - request cancellation; an aborted request never resolves.
 * @param options - `home`/`path` overrides (tests) and an `onFallback` hook.
 * @returns the resolved executable path.
 */
export async function resolveAgyExecutable(subprocess, command, env = {}, signal = undefined, options = {}) {
  const aborted = () => new Error(`${PREFIX}: request was aborted before agy startup`)
  if (signal?.aborted) throw aborted()
  const explicit = isAbsolute(command) || command.includes('/')
  let primaryError
  try {
    return await subprocess.resolveExecutable(command, env, signal)
  } catch (error) {
    if (signal?.aborted) throw aborted()
    if (!isExecutableNotFound(error)) throw error
    primaryError = error
  }
  const fix = 'Fix: set the plugin config `command` to the absolute path of agy (run `command -v agy` as the user who logged in to agy), or add ~/.local/bin to the dsh service PATH. dsh must run as the same user/HOME as the agy login, because the OAuth token lives in ~/.gemini.'
  if (explicit) {
    throw new Error(`${PREFIX}: configured agy executable ${JSON.stringify(command)} does not exist or is not executable. ${fix}`, { cause: primaryError })
  }
  const home = env.HOME ?? options.home ?? process.env.HOME
  const fallback = typeof home === 'string' && home.length > 0 ? join(home, '.local', 'bin', basename(command)) : undefined
  if (fallback !== undefined) {
    try {
      const resolved = await subprocess.resolveExecutable(fallback, env, signal)
      options.onFallback?.(resolved)
      return resolved
    } catch (error) {
      if (signal?.aborted) throw aborted()
      if (!isExecutableNotFound(error)) throw error
    }
  }
  const searched = [
    `command ${JSON.stringify(command)} on ${summarizePath(env.PATH ?? options.path ?? process.env.PATH)}`,
    fallback === undefined ? 'no $HOME fallback (HOME is unset)' : `the fallback ${fallback}`,
  ]
  throw new Error(`${PREFIX}: agy executable not found. Searched: ${searched.join('; then ')}. ${fix}`, { cause: primaryError })
}

/** Fixed one-shot `agy` provider registered under the name `agy`. */
class AgyProvider {
  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {z.infer<typeof Config>} config */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.name = 'agy'
    this.capabilities = NO_START_CAPABILITIES
    this.inheritsParentContext = false
    /** @type {Set<object>} live runs the plugin unloads on dispose. */
    this.active = new Set()
  }

  /** @param {import('@deepseek-ai/dsh-subagent').ResolvedSubagentStartRequest} request */
  async start(request) {
    // An already-cancelled request short-circuits before any lookup or spawn.
    const executable = await resolveAgyExecutable(this.ctx.subprocess, this.config.command, this.config.env, request.signal, {
      onFallback: (resolved) => {
        if (this.reportedFallback === resolved) return
        this.reportedFallback = resolved
        this.ctx.logger?.info?.(`${PREFIX}: "${this.config.command}" is not on PATH; using ${resolved}`)
      },
    })
    const run = await startAgyRun(request, {
      cwd: request.cwd,
      argv: buildAgyArgv(this.config, executable),
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      maxRunMs: this.config.maxRunMs,
      promptSuffix: this.config.avoidBrowser ? AVOID_BROWSER_SUFFIX : '',
      spawn: (spawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`${PREFIX}: child run failed (${stopReason}): ${error.message}`)
      },
    })
    this.active.add(run)
    run.result.then(() => this.active.delete(run), () => this.active.delete(run))
    return run
  }

  /**
   * Terminate every in-flight agy process tree. Plugin stop/update calls this
   * through an effect cleanup; otherwise running children would leak as
   * orphans no other component can manage.
   * @returns how many live runs were terminated.
   */
  disposeAll() {
    const count = this.active.size
    for (const run of this.active) {
      try {
        void run.dispose()
      } catch {
        // Teardown failures must not mask the remaining terminations.
      }
    }
    this.active.clear()
    return count
  }
}

/**
 * Register the fixed `agy` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - CLI defaults, explicit environment, and disposal grace.
 */
export function apply(ctx, config) {
  const resolved = config
  assertPositiveFinite(PREFIX, 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${PREFIX}: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (resolved.idleTimeoutMs !== 0) {
    assertPositiveFinite(PREFIX, 'idleTimeoutMs', resolved.idleTimeoutMs)
    if (resolved.idleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`${PREFIX}: idleTimeoutMs must be 0 (disabled) or no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }
  if (resolved.maxRunMs !== 0) {
    assertPositiveFinite(PREFIX, 'maxRunMs', resolved.maxRunMs)
    if (resolved.maxRunMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`${PREFIX}: maxRunMs must be 0 (disabled) or no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }
  // Unknown mode/effort values are handed to agy as configured with a warning:
  // a CLI upgrade that adds enum values must never dead-end the plugin at load
  // time. agy itself reports an unsupported value on the run.
  const warnUnknown = (field, value, known) => {
    if (!known.has(value)) {
      ctx.logger?.warn?.(`${PREFIX}: config ${field} ${JSON.stringify(value)} is not one this plugin knows (${[...known].map((mode) => JSON.stringify(mode)).join(', ')}); passing it through to agy unchanged`)
    }
  }
  warnUnknown('mode', resolved.mode, KNOWN_MODES)
  warnUnknown('effort', resolved.effort, KNOWN_EFFORTS)
  if (resolved.mode === 'plan' && resolved.disableSlashCommands) {
    throw new Error(`${PREFIX}: mode "plan" is implemented by agy as a slash command; set disableSlashCommands: false to use it`)
  }
  if (resolved.command.trim().length === 0) {
    throw new Error(`${PREFIX}: command must not be empty`)
  }
  // Fail on a wrong addDirs entry at load time: a bad path would otherwise
  // cost every run a full silent hang instead of an immediate clear error.
  for (const dir of resolved.addDirs) {
    if (!isAbsolute(dir)) {
      throw new Error(`${PREFIX}: addDirs must be absolute paths (got "${dir}")`)
    }
    if (!existsSync(dir)) {
      throw new Error(`${PREFIX}: addDirs entry does not exist: ${dir}`)
    }
    if (!statSync(dir).isDirectory()) {
      throw new Error(`${PREFIX}: addDirs entry is not a directory: ${dir}`)
    }
  }
  // The switch lives on the plugin-detail page, not the automatic Settings
  // page. Keep the field volatile (the browser form writes it) but suppress
  // the auto-generated settings section when the host offers that policy.
  const provider = new AgyProvider(ctx, resolved)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (sctx) => {
      if (typeof sctx.settings?.configure !== 'function') return
      // The owner must be THIS plugin's fiber, not the inject child fiber:
      // the auto-page lookup is keyed by the entry fiber, and every host
      // plugin passes ctx.fiber explicitly for the same reason.
      sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), 'subagent-agy: hide automatic settings page')
    })
    // Progress tool and delegation guidance follow `subagent_agy`: they exist
    // only while the `tool-subagent-agy` row (or an equivalent registration of
    // that name) is loaded. The provider plugin loads first in the default
    // patch, so this waits on `tools/change` rather than registering up front.
    ctx.inject(['tools', 'systemPrompt'], (tctx) => {
      const definition = defineAgyRunsTool(defaultRunRegistry)
      tctx.effect(() => {
        let disposeTool = () => {}
        let disposeContext = () => {}
        let attached = false
        const detach = () => {
          if (!attached) return
          attached = false
          disposeTool()
          disposeContext()
          disposeTool = () => {}
          disposeContext = () => {}
        }
        const attach = () => {
          if (attached) return
          attached = true
          try {
            disposeTool = tctx.tools.register(definition)
            disposeContext = tctx.systemPrompt.context({
              name: 'tool:agy_runs',
              order: tctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
              text: (context) => {
                if (tctx.tools.get(DELEGATION_TOOL_NAME, context.scope) === undefined) return ''
                return tctx.tools.get('agy_runs', context.scope) === definition ? AGY_RUNS_CONTEXT : ''
              },
            })
          } catch (error) {
            detach()
            throw error
          }
        }
        const sync = () => {
          if (tctx.tools.get(DELEGATION_TOOL_NAME) !== undefined) attach()
          else detach()
        }
        sync()
        const stopListen = typeof tctx.on === 'function' ? tctx.on('tools/change', sync) : undefined
        return () => {
          if (typeof stopListen === 'function') stopListen()
          detach()
        }
      }, 'subagent-agy: agy_runs follows subagent_agy')
    })
  }
  ctx.subagents.registerProvider(provider)
  // Terminate every in-flight agy process when the plugin stops or updates:
  // the children would otherwise leak as orphans no other component manages.
  ctx.effect(() => () => {
    try {
      const stopped = provider.disposeAll()
      if (stopped > 0) ctx.logger?.warn?.(`${PREFIX}: terminated ${stopped} active agy run(s) on plugin dispose`)
    } catch (error) {
      ctx.logger?.warn?.(`${PREFIX}: failed to terminate active agy runs on plugin dispose: ${toError(error).message}`)
    }
  }, 'subagent-agy: terminate active runs on dispose')
}

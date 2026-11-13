/**
 * Deterministic subprocess-mock tests for startAgyRun and the provider glue.
 * No agy process, model quota, or network access.
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { Config, apply, createRunRegistry, resolveAgyExecutable, runStatusRow, startAgyRun } from '../lib/index.js'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/**
 * Build a child handle that emits fixed stdout lines and then exits.
 * @param {string[]} lines
 * @param {number} exitCode
 * @param {{ holdOpen?: boolean, holdStdoutOpen?: boolean }} options - `holdOpen`
 *   keeps the child alive until `terminate()`; `holdStdoutOpen` resolves `done`
 *   but never ends stdout, modelling a grandchild that outlives the direct
 *   child while holding the pipe.
 */
function fakeChild(lines, exitCode = 0, options = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  // `stderrLines` gives the child a piped stderr that emits these lines and
  // ends just before the child exits; without it the host exposes no stderr.
  const stderr = options.stderrLines === undefined ? undefined : new PassThrough()
  const emitStderr = () => {
    if (stderr === undefined) return
    for (const line of options.stderrLines) stderr.write(`${line}\n`)
    stderr.end()
  }
  /** Every chunk written to the child's stdin, in order. */
  const stdinData = []
  stdin.on('data', (chunk) => stdinData.push(chunk))
  const done = Promise.withResolvers()
  const emit = () => {
    for (const line of lines) stdout.write(`${line}\n`)
  }
  if (options.holdStdoutOpen) {
    setImmediate(() => {
      emit()
      done.resolve({ exitCode, signal: null })
      // No stdout.end(): EOF never arrives unless terminate() runs.
    })
  } else if (options.holdOpen) {
    if (lines.length > 0) setImmediate(emit)
  } else {
    setImmediate(() => {
      emit()
      emitStderr()
      stdout.end()
      done.resolve({ exitCode, signal: null })
    })
  }
  return {
    stdin,
    stdout,
    stdinData,
    stderr,
    control: undefined,
    collected: {},
    done: done.promise,
    terminate() {
      done.resolve({ exitCode: null, signal: 'SIGTERM' })
      stdout.end()
      if (stderr !== undefined && !stderr.writableEnded) emitStderr()
    },
    async waitForExit() {
      await done.promise
      return true
    },
  }
}

function runSpec(child, overrides = {}) {
  return {
    cwd: '/tmp',
    argv: ['agy', '--print='],
    env: {},
    disposeGraceMs: 3000,
    spawn: () => child,
    ...overrides,
  }
}

function request(text, signal = new AbortController().signal) {
  return { cwd: '/tmp', prompt: [{ type: 'text', text }], signal }
}

await test('a child that exits without a result event settles as error', async () => {
  const run = await startAgyRun(request('task'), runSpec(fakeChild(['warning: no json here'], 2)))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic, /without a result event/)
  } finally {
    await run.dispose()
  }
})

await test('non-JSON stdout noise does not hide a later result event', async () => {
  const resultEvent = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK\n' } })
  const run = await startAgyRun(request('task'), runSpec(fakeChild(['warning: --mode auto is not available', resultEvent])))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed', JSON.stringify(result))
    assert.deepEqual(result.output, [{ type: 'text', text: 'OK\n' }])
  } finally {
    await run.dispose()
  }
})

await test('an already-aborted request rejects before spawning', async () => {
  const controller = new AbortController()
  controller.abort(new Error('already gone'))
  let spawned = 0
  await assert.rejects(
    startAgyRun(request('task', controller.signal), runSpec(fakeChild([]), { spawn: () => { spawned += 1; return fakeChild([]) } })),
    /aborted before agy startup/,
  )
  assert.equal(spawned, 0)
})

await test('provider.start resolves the executable and publishes a completed run', async () => {
  let provider
  let captured
  const ctx = {
    subagents: { registerProvider: (value) => { provider = value } },
    subprocess: {
      resolveExecutable: async (command) => `/resolved/${command}`,
      spawn: (spec) => {
        captured = spec
        return fakeChild([JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'GLUED' } })])
      },
    },
    logger: { warn: () => {} },
    effect: () => () => {},
  }
  apply(ctx, Config({}))
  assert.equal(provider.name, 'agy')
  const run = await provider.start(request('task'))
  try {
    assert.equal(captured.argv[0], '/resolved/agy')
    assert.deepEqual(captured.argv, [
      '/resolved/agy',
      '--print=',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
    ])
    assert.equal(captured.cwd, '/tmp')
    assert.equal(captured.stdio.stdin, 'pipe')
    assert.equal(captured.stdio.stdout, 'pipe')
    const result = await run.result
    assert.equal(result.stopReason, 'completed', JSON.stringify(result))
    assert.deepEqual(result.output, [{ type: 'text', text: 'GLUED' }])
  } finally {
    await run.dispose()
  }
})

await test('the run registry records steps, tools, and the completed settlement', async () => {
  const registry = createRunRegistry({ now: () => 1000 })
  const lines = [
    JSON.stringify({ event: 'init', init: { cwd: '/tmp', permission_mode: 'request-review' } }),
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command' } },
    }),
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command' } },
    }),
    JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'DONE' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'DONE' } }),
  ]
  const child = fakeChild(lines)
  const run = await startAgyRun(request('task'), runSpec(child, { registry }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed')
    const [record] = registry.list('')
    assert.equal(record.state, 'done')
    assert.equal(record.permissionMode, 'request-review')
    assert.equal(record.lastTool, 'run_command')
    assert.equal(record.toolCalls, 1)
    assert.equal(record.steps, 3)
    assert.equal(record.lastText, 'DONE')
    assert.equal(record.settledAt, 1000, 'settlement reads the injected clock')
    const row = runStatusRow(record, 1000)
    assert.equal(row.state, 'done')
    assert.equal(row.error, '')
  } finally {
    await run.dispose()
  }
})

await test('the run registry keeps the denial diagnostic on a failed run', async () => {
  const registry = createRunRegistry({ now: () => 1000 })
  const lines = [
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } }),
  ]
  const run = await startAgyRun(request('task'), runSpec(fakeChild(lines), { registry }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    const [record] = registry.list('')
    assert.equal(record.state, 'failed')
    assert.match(record.error, /denied tools: RunCommand/)
  } finally {
    await run.dispose()
  }
})

await test('the run registry lists only the calling parent and prunes settled runs', async () => {
  let clock = 0
  const registry = createRunRegistry({ now: () => clock, retentionMs: 100 })
  const first = registry.begin({ runId: 'run-1', parentId: 'parent-a', label: 'first' })
  registry.settle(first, { stopReason: 'completed' })
  // A second settlement is ignored: the idempotent guard keeps the first terminal state.
  registry.settle(first, { stopReason: 'error', diagnostic: 'late' })
  assert.equal(first.state, 'done')
  assert.equal(first.error, '')
  clock = 10
  const second = registry.begin({ runId: 'run-2', parentId: 'parent-a', label: 'second' })
  const other = registry.begin({ runId: 'run-3', parentId: 'parent-b', label: 'other' })
  clock = 20
  assert.deepEqual(registry.list('parent-a').map((record) => record.runId), ['run-2', 'run-1'])
  assert.deepEqual(registry.list('parent-b').map((record) => record.runId), ['run-3'])
  clock = 200
  assert.deepEqual(registry.list('parent-a').map((record) => record.runId), ['run-2'])
  assert.deepEqual(registry.list('parent-b').map((record) => record.runId), ['run-3'])
  registry.settle(second, { stopReason: 'aborted' })
  registry.settle(other, { stopReason: 'completed' })
  assert.equal(second.state, 'aborted')
  clock = 400
  assert.deepEqual(registry.list('parent-a'), [])
})

await test('the run registry caps retained records, dropping the oldest first', async () => {
  let clock = 0
  const registry = createRunRegistry({ now: () => clock, maxEntries: 2 })
  const one = registry.begin({ runId: 'run-1', parentId: 'p', label: 'one' })
  clock = 1
  registry.settle(one, { stopReason: 'completed' })
  const two = registry.begin({ runId: 'run-2', parentId: 'p', label: 'two' })
  clock = 2
  registry.settle(two, { stopReason: 'completed' })
  const three = registry.begin({ runId: 'run-3', parentId: 'p', label: 'three' })
  clock = 3
  registry.settle(three, { stopReason: 'completed' })
  assert.deepEqual(registry.list('p').map((record) => record.runId), ['run-3', 'run-2'])
})

await test('the run registry never evicts a live run to satisfy the entry cap', async () => {
  let clock = 0
  const registry = createRunRegistry({ now: () => clock, retentionMs: 1e9, maxEntries: 2 })
  const live = registry.begin({ runId: 'live', parentId: 'p', label: 'long-running' })
  clock = 10
  const early = registry.begin({ runId: 'early', parentId: 'p', label: 'early' })
  clock = 20
  registry.settle(early, { stopReason: 'completed' })
  clock = 30
  const late = registry.begin({ runId: 'late', parentId: 'p', label: 'late' })
  clock = 40
  registry.settle(late, { stopReason: 'completed' })
  const rows = registry.list('p').map((record) => record.runId)
  assert.deepEqual(rows, ['late', 'live'], 'the oldest settled run is evicted first and the live run survives')
  assert.equal(live.state, 'starting')
})

await test('the one-shot task reaches stdin as exactly one NDJSON user event', async () => {
  const child = fakeChild([JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } })])
  const run = await startAgyRun(request('one line task'), runSpec(child))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed')
    const expected = `${JSON.stringify({ event: 'user', message: { content: 'one line task' } })}\n`
    assert.equal(child.stdinData.join(''), expected)
  } finally {
    await run.dispose()
  }
})

await test('an in-flight abort settles the run and its registry record as aborted', async () => {
  const controller = new AbortController()
  const registry = createRunRegistry()
  const child = fakeChild([], 0, { holdOpen: true })
  const run = await startAgyRun(request('slow task', controller.signal), runSpec(child, { registry }))
  // Abort on the next tick: the run is already started but has produced nothing.
  setImmediate(() => controller.abort(new Error('mid-flight cancellation')))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'aborted', JSON.stringify(result))
    const [record] = registry.list('')
    assert.equal(record.state, 'aborted')
    assert.equal(typeof record.settledAt, 'number')
    assert.ok(record.settledAt > 0, `settledAt is a real timestamp, saw ${record.settledAt}`)
  } finally {
    await run.dispose()
  }
})

await test('disposing a live run directly settles it and its registry record as aborted', async () => {
  const registry = createRunRegistry()
  const child = fakeChild([], 0, { holdOpen: true })
  const run = await startAgyRun(request('slow task'), runSpec(child, { registry }))
  // Dispose while the run is still live: no signal involved.
  await run.dispose()
  const result = await run.result
  assert.equal(result.stopReason, 'aborted', JSON.stringify(result))
  const [record] = registry.list('')
  assert.equal(record.state, 'aborted')
  assert.equal(typeof record.settledAt, 'number')
})

await test('an aborted run keeps its streamed text as fallback output', async () => {
  const controller = new AbortController()
  const registry = createRunRegistry()
  const delta = JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'partial stream' },
  })
  const child = fakeChild([delta], 0, { holdOpen: true })
  const run = await startAgyRun(request('slow task', controller.signal), runSpec(child, { registry }))
  // Abort only after the text delta has actually been folded in.
  for (let i = 0; i < 100 && registry.list('')[0]?.lastText !== 'partial stream'; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(registry.list('')[0]?.lastText, 'partial stream', 'the delta arrived before the abort')
  controller.abort(new Error('cancel'))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'aborted', JSON.stringify(result))
    assert.deepEqual(result.output, [{ type: 'text', text: 'partial stream' }])
  } finally {
    await run.dispose()
  }
})

await test('a grandchild holding stdout open cannot hold a completed run hostage', async () => {
  const resultEvent = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'LATE EOF' } })
  const child = fakeChild([resultEvent], 0, { holdStdoutOpen: true })
  const startedAt = Date.now()
  const run = await startAgyRun(request('task'), runSpec(child))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed', JSON.stringify(result))
    assert.deepEqual(result.output, [{ type: 'text', text: 'LATE EOF' }])
    // The run settles through the drain window, not through an EOF that never comes.
    assert.ok(Date.now() - startedAt < 2000, `settled within the drain window, took ${Date.now() - startedAt}ms`)
  } finally {
    await run.dispose()
  }
})

await test('the silence watchdog terminates a hung run with a clear diagnostic', async () => {
  const registry = createRunRegistry()
  const child = fakeChild([], 0, { holdOpen: true })
  const run = await startAgyRun(request('slow task'), runSpec(child, { registry, idleTimeoutMs: 80 }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error', JSON.stringify(result))
    assert.match(result.diagnostic, /no output for 80ms \(idle timeout\)/)
    const [record] = registry.list('')
    assert.equal(record.state, 'failed')
    assert.match(record.error, /idle timeout/)
  } finally {
    await run.dispose()
  }
})

await test('the silence watchdog never fires once events keep flowing', async () => {
  const resultEvent = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'KEPT GOING' } })
  const child = fakeChild([resultEvent], 0, { holdStdoutOpen: true })
  const run = await startAgyRun(request('task'), runSpec(child, { idleTimeoutMs: 50 }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed', JSON.stringify(result))
  } finally {
    await run.dispose()
  }
})

await test('an oversized no-newline line is split away and cannot hide a later result', async () => {
  const resultEvent = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'AFTER NOISE' } })
  const child = fakeChild(['x'.repeat(5000), resultEvent], 0)
  const run = await startAgyRun(request('task'), runSpec(child, { lineByteCap: 1024 }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed', JSON.stringify(result))
    assert.deepEqual(result.output, [{ type: 'text', text: 'AFTER NOISE' }])
  } finally {
    await run.dispose()
  }
})

await test('a child that exits without a result includes known-cause diagnostics', async () => {
  const run = await startAgyRun(request('task'), runSpec(fakeChild(['warning: no json here'], 2)))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic, /without a result event/)
    assert.match(result.diagnostic, /Likely causes/)
    assert.match(result.diagnostic, /exit code: 2/)
    // A denial never blocks startup (agy still emits a result), so the old
    // permission-prompt hint must not reappear here.
    assert.doesNotMatch(result.diagnostic, /permission prompt|dangerouslySkipPermissions/)
  } finally {
    await run.dispose()
  }
})

await test('promptSuffix is appended to the stdin user event', async () => {
  const child = fakeChild([JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } })])
  const run = await startAgyRun(request('one line task'), runSpec(child, { promptSuffix: '\n\n(do not browse)' }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed')
    const expected = `${JSON.stringify({ event: 'user', message: { content: 'one line task\n\n(do not browse)' } })}\n`
    assert.equal(child.stdinData.join(''), expected)
  } finally {
    await run.dispose()
  }
})

await test('an abort that lands after spawn still terminates the run', async () => {
  const controller = new AbortController()
  const registry = createRunRegistry()
  let spawned = 0
  const child = fakeChild([], 0, { holdOpen: true })
  const run = await startAgyRun(
    request('task', controller.signal),
    runSpec(child, {
      registry,
      spawn: () => {
        spawned += 1
        controller.abort(new Error('abort during spawn'))
        return child
      },
    }),
  )
  try {
    assert.equal(spawned, 1)
    const result = await run.result
    assert.equal(result.stopReason, 'aborted', JSON.stringify(result))
    const [record] = registry.list('')
    assert.equal(record.state, 'aborted')
  } finally {
    await run.dispose()
  }
})

await test('disposing the provider terminates every live run', async () => {
  const providerCtx = {
    subagents: { registerProvider: (value) => { providerCtx.provider = value } },
    subprocess: {
      resolveExecutable: async (command) => `/resolved/${command}`,
      spawn: () => fakeChild([], 0, { holdOpen: true }),
    },
    logger: { warn: () => {} },
    effect: () => () => {},
  }
  apply(providerCtx, Config({}))
  const first = await providerCtx.provider.start(request('one'))
  const second = await providerCtx.provider.start(request('two'))
  assert.equal(providerCtx.provider.disposeAll(), 2)
  const [firstResult, secondResult] = await Promise.all([first.result, second.result])
  assert.equal(firstResult.stopReason, 'aborted')
  assert.equal(secondResult.stopReason, 'aborted')
  assert.equal(providerCtx.provider.disposeAll(), 0, 'a second dispose finds nothing left')
})

const INIT = (id = 'conv-1234') => JSON.stringify({ event: 'init', conversation_id: id, init: { permission_mode: 'request-review' } })
const TOOL = (name, state) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1234', step_index: 2, state, step_type: 'tool', tool_name: name, tool_info: { name } } })

await test('agy stderr is piped, forwarded to the host, and its AGY_ERROR line lands in the diagnostic', async () => {
  const forwarded = []
  const registry = createRunRegistry()
  const resultEvent = JSON.stringify({ event: 'result', result: { conversation_id: 'conv-1234', status: 'SUCCESS', response: 'partial', finished_reason: 'print_timeout' } })
  const child = fakeChild([INIT(), resultEvent], 0, {
    stderrLines: [
      '[agy] print timeout after 3s with turn in progress; returning partial output',
      'AGY_ERROR: {"short_error":"print timeout after 3s","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}',
    ],
  })
  let spawnSpec
  const run = await startAgyRun(request('task'), runSpec(child, {
    registry,
    forwardStderr: (chunk) => forwarded.push(Buffer.from(chunk).toString('utf8')),
    spawn: (value) => { spawnSpec = value; return child },
  }))
  try {
    const result = await run.result
    assert.equal(spawnSpec.stdio.stderr, 'pipe')
    assert.equal(result.stopReason, 'error')
    assert.match(forwarded.join(''), /print timeout after 3s with turn in progress/)
    assert.match(result.diagnostic, /print timeout expired/)
    assert.match(result.diagnostic, /agy error: print timeout after 3s \(reason: print_timeout; status: DEADLINE_EXCEEDED; retryable: false\)/)
    assert.match(result.diagnostic, /exit code: 0/)
    assert.match(result.diagnostic, /conversation: conv-1234/)
    assert.match(result.diagnostic, /agy stderr \(tail\):\n\[agy\] print timeout/)
    const [record] = registry.list('')
    assert.equal(record.error.includes('\n'), false, 'the agy_runs error stays one line')
    assert.match(record.error, /print timeout expired/)
  } finally {
    await run.dispose()
  }
})

await test('a no-result exit reports the signal, conversation, and stderr tail', async () => {
  const child = fakeChild([INIT('conv-dead')], 0, { holdOpen: true, stderrLines: ['fatal: unknown flag --bogus'] })
  const run = await startAgyRun(request('task'), runSpec(child, { forwardStderr: false }))
  setTimeout(() => child.terminate(), 20)
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic, /without a result event/)
    assert.match(result.diagnostic, /signal: SIGTERM/)
    assert.match(result.diagnostic, /conversation: conv-dead/)
    assert.match(result.diagnostic, /fatal: unknown flag --bogus/)
  } finally {
    await run.dispose()
  }
})

await test('the idle diagnostic names a tool that was still running', async () => {
  const child = fakeChild([INIT(), TOOL('run_command', 'ACTIVE')], 0, { holdOpen: true })
  const run = await startAgyRun(request('task'), runSpec(child, { idleTimeoutMs: 80 }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic, /went silent for 80ms while tool run_command was still running/)
    assert.match(result.diagnostic, /raise idleTimeoutMs/)
    assert.match(result.diagnostic, /tool still running: run_command/)
    assert.doesNotMatch(result.diagnostic, /produced no output/)
  } finally {
    await run.dispose()
  }
})

await test('the idle diagnostic blames a hung browser tool only when one is running', async () => {
  const child = fakeChild([INIT(), TOOL('browser_get_dom', 'ACTIVE')], 0, { holdOpen: true })
  const run = await startAgyRun(request('task'), runSpec(child, { idleTimeoutMs: 80 }))
  try {
    const result = await run.result
    assert.match(result.diagnostic, /while tool browser_get_dom was still running/)
    assert.match(result.diagnostic, /avoidBrowser/)
  } finally {
    await run.dispose()
  }
})

await test('the idle diagnostic after a finished tool reports no running tool', async () => {
  const child = fakeChild([INIT(), TOOL('run_command', 'ACTIVE'), TOOL('run_command', 'DONE')], 0, { holdOpen: true })
  const run = await startAgyRun(request('task'), runSpec(child, { idleTimeoutMs: 80 }))
  try {
    const result = await run.result
    assert.match(result.diagnostic, /went silent for 80ms after 3 event\(s\) with no tool running/)
    assert.match(result.diagnostic, /last tool: run_command/)
  } finally {
    await run.dispose()
  }
})

await test('a completed run with denied actions keeps its exact answer and adds a note', async () => {
  const registry = createRunRegistry()
  const resultEvent = JSON.stringify({
    event: 'result',
    result: { conversation_id: 'conv-1234', status: 'SUCCESS', response: 'Done, but I could not run the tests.', denied_actions: [{ action: 'command', display_name: 'RunCommand' }, { action: 'command', display_name: 'RunCommand' }] },
  })
  const run = await startAgyRun(request('task'), runSpec(fakeChild([INIT(), resultEvent]), { registry }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed')
    assert.deepEqual(result.output, [{ type: 'text', text: 'Done, but I could not run the tests.' }])
    assert.match(result.diagnostic, /note: agy auto-denied 1 tool action\(s\) during this run \(RunCommand\)/)
    const row = runStatusRow(registry.list('')[0])
    assert.equal(row.state, 'done')
    assert.deepEqual(row.deniedTools, ['RunCommand'])
    assert.equal(row.conversationId, 'conv-1234')
  } finally {
    await run.dispose()
  }
})

await test('a clean completed run carries no diagnostic', async () => {
  const resultEvent = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK', denied_actions: [] } })
  const run = await startAgyRun(request('task'), runSpec(fakeChild([resultEvent], 0, { stderrLines: ['some agy log line'] }), { forwardStderr: false }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.diagnostic, undefined)
  } finally {
    await run.dispose()
  }
})

await test('a denied-only run fails with the denial, conversation, and stderr hint', async () => {
  const resultEvent = JSON.stringify({ event: 'result', result: { conversation_id: 'conv-1234', status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } })
  const child = fakeChild([INIT(), resultEvent], 0, { stderrLines: ['jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for'] })
  const run = await startAgyRun(request('task'), runSpec(child, { forwardStderr: false }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error')
    assert.match(result.diagnostic, /no final answer \(denied tools: RunCommand\)/)
    assert.match(result.diagnostic, /conversation: conv-1234/)
    assert.match(result.diagnostic, /jetski: no output produced/)
  } finally {
    await run.dispose()
  }
})

/**
 * A child that never finishes and keeps emitting step events every `everyMs`
 * (a looping agent): only a wall-clock bound can stop it.
 */
function loopingChild(everyMs = 10) {
  const child = fakeChild([INIT('conv-loop'), TOOL('run_command', 'ACTIVE')], 0, { holdOpen: true })
  let step = 3
  const timer = setInterval(() => {
    child.stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-loop', step_index: step++, state: 'ACTIVE', step_type: 'agent_response', text_delta: '.' } })}\n`)
  }, everyMs)
  const terminate = child.terminate
  child.terminated = 0
  child.terminate = () => {
    child.terminated += 1
    clearInterval(timer)
    terminate()
  }
  return child
}

/** Whether `promise` is still pending after `ms`. */
async function pendingAfter(promise, ms) {
  const marker = Symbol('pending')
  return (await Promise.race([promise, delay(ms).then(() => marker)])) === marker
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

await test('the wall-clock cap stops a run that keeps emitting events, as an error with run facts', async () => {
  const registry = createRunRegistry()
  const child = loopingChild()
  const startedAt = Date.now()
  // idleTimeoutMs stays 0: a looping run is never silent, so only the cap can stop it.
  const run = await startAgyRun(request('loop forever'), runSpec(child, { registry, maxRunMs: 150 }))
  try {
    const result = await run.result
    assert.equal(result.stopReason, 'error', JSON.stringify(result))
    assert.ok(Date.now() - startedAt >= 140, 'the cap fired at its deadline, not earlier')
    assert.equal(child.terminated, 1, 'the cap terminated the process tree once')
    assert.match(result.diagnostic, /agy run hit the 150ms run cap \(maxRunMs\) after 0s; the process tree was terminated/)
    assert.match(result.diagnostic, /raise maxRunMs \(0 disables it\)/)
    assert.match(result.diagnostic, /signal: SIGTERM/)
    assert.match(result.diagnostic, /conversation: conv-loop/)
    assert.match(result.diagnostic, /steps: \d+/)
    assert.match(result.diagnostic, /tool still running: run_command/)
    assert.doesNotMatch(result.diagnostic, /idle timeout/)
    const [record] = registry.list('')
    assert.equal(record.state, 'failed')
    assert.match(record.error, /hit the 150ms run cap/)
    assert.ok(record.steps > 3, `events kept flowing until the cap (steps ${record.steps})`)
  } finally {
    await run.dispose()
  }
})

await test('maxRunMs 0 disables the cap', async () => {
  const child = loopingChild()
  const run = await startAgyRun(request('loop'), runSpec(child, { maxRunMs: 0 }))
  assert.equal(await pendingAfter(run.result, 250), true, 'no cap: the run is still live')
  assert.equal(child.terminated, 0)
  await run.dispose()
  assert.equal((await run.result).stopReason, 'aborted')
})

await test('cancelling stops a capped run instantly as aborted and the cap never fires afterwards', async () => {
  const controller = new AbortController()
  const registry = createRunRegistry()
  const child = loopingChild()
  const run = await startAgyRun(request('loop', controller.signal), runSpec(child, { registry, maxRunMs: 150 }))
  await delay(30)
  const cancelledAt = Date.now()
  controller.abort(new Error('user stop'))
  const result = await run.result
  assert.ok(Date.now() - cancelledAt < 100, `cancel settled in ${Date.now() - cancelledAt}ms`)
  assert.equal(result.stopReason, 'aborted', JSON.stringify(result))
  assert.equal(result.diagnostic, undefined)
  await delay(200)
  assert.equal(child.terminated, 1, 'the expired cap did not terminate again')
  assert.equal(registry.list('')[0].state, 'aborted')
  await run.dispose()
})

await test('a run that completes before the cap clears it', async () => {
  const resultEvent = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'QUICK' } })
  const child = fakeChild([resultEvent])
  let terminated = 0
  const terminate = child.terminate
  child.terminate = () => { terminated += 1; terminate() }
  const run = await startAgyRun(request('task'), runSpec(child, { maxRunMs: 100 }))
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  await delay(150)
  assert.equal(terminated, 0, 'a settled run is never terminated by its cap')
  await run.dispose()
})

/** Minimal provider host for config-driven tests. */
function providerHost(spawn) {
  const host = {
    subagents: { registerProvider: (value) => { host.provider = value } },
    subprocess: { resolveExecutable: async (command) => `/resolved/${command}`, spawn },
    logger: { warn: () => {} },
    effect: () => () => {},
  }
  return host
}

await test('the silence watchdog is off by default: a silent provider run stays live', async () => {
  const host = providerHost(() => fakeChild([], 0, { holdOpen: true }))
  apply(host, Config({}))
  const run = await host.provider.start(request('silent'))
  assert.equal(await pendingAfter(run.result, 250), true, 'no default idle timeout')
  host.provider.disposeAll()
  assert.equal((await run.result).stopReason, 'aborted')
})

await test('idleTimeoutMs still terminates a silent run when a deployment sets it', async () => {
  const host = providerHost(() => fakeChild([], 0, { holdOpen: true }))
  apply(host, Config({ idleTimeoutMs: 80 }))
  const run = await host.provider.start(request('silent'))
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /no output for 80ms \(idle timeout\)/)
  await run.dispose()
})

await test('the provider forwards maxRunMs from config', async () => {
  const host = providerHost(() => loopingChild())
  apply(host, Config({ maxRunMs: 120 }))
  const run = await host.provider.start(request('loop'))
  const result = await run.result
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /hit the 120ms run cap/)
  await run.dispose()
})

/** A subprocess service whose PATH lookup only knows the given absolute paths. */
function lookupService(known, failure) {
  const calls = []
  return {
    calls,
    async resolveExecutable(command) {
      calls.push(command)
      if (failure !== undefined) throw failure
      if (known.includes(command)) return command
      const error = new Error(`executable not found: ${command}`)
      error.name = 'SubprocessExecutableNotFoundError'
      throw error
    },
  }
}

await test('a bare command missing from PATH falls back to $HOME/.local/bin', async () => {
  const service = lookupService(['/home/fan/.local/bin/agy'])
  const fallbacks = []
  const resolved = await resolveAgyExecutable(service, 'agy', { HOME: '/home/fan' }, undefined, { onFallback: (value) => fallbacks.push(value) })
  assert.equal(resolved, '/home/fan/.local/bin/agy')
  assert.deepEqual(service.calls, ['agy', '/home/fan/.local/bin/agy'], 'PATH first, then the fallback')
  assert.deepEqual(fallbacks, ['/home/fan/.local/bin/agy'])
})

await test('a command found on PATH never touches the fallback', async () => {
  const service = lookupService(['agy'])
  assert.equal(await resolveAgyExecutable(service, 'agy', { HOME: '/home/fan' }), 'agy')
  assert.deepEqual(service.calls, ['agy'])
})

await test('when neither PATH nor the fallback has agy, the error names what was searched and how to fix it', async () => {
  const service = lookupService([])
  await assert.rejects(
    resolveAgyExecutable(service, 'agy', {}, undefined, { home: '/home/fan', path: '/usr/local/bin:/usr/bin:/bin' }),
    (error) => {
      assert.match(error.message, /agy executable not found/)
      assert.match(error.message, /command "agy" on PATH \(3 dirs: \/usr\/local\/bin, \/usr\/bin, \/bin\)/)
      assert.match(error.message, /the fallback \/home\/fan\/\.local\/bin\/agy/)
      assert.match(error.message, /set the plugin config `command` to the absolute path/)
      assert.match(error.message, /add ~\/\.local\/bin to the dsh service PATH/)
      assert.match(error.message, /same user\/HOME as the agy login/)
      assert.equal(error.cause?.name, 'SubprocessExecutableNotFoundError')
      return true
    },
  )
  assert.deepEqual(service.calls, ['agy', '/home/fan/.local/bin/agy'])
})

await test('an explicit executable path wins and is never replaced by the fallback', async () => {
  const found = lookupService(['/opt/agy/bin/agy', '/home/fan/.local/bin/agy'])
  assert.equal(await resolveAgyExecutable(found, '/opt/agy/bin/agy', { HOME: '/home/fan' }), '/opt/agy/bin/agy')
  assert.deepEqual(found.calls, ['/opt/agy/bin/agy'])
  const missing = lookupService(['/home/fan/.local/bin/agy'])
  await assert.rejects(
    resolveAgyExecutable(missing, '/opt/agy/bin/agy', { HOME: '/home/fan' }),
    /configured agy executable "\/opt\/agy\/bin\/agy" does not exist or is not executable/,
  )
  assert.deepEqual(missing.calls, ['/opt/agy/bin/agy'], 'no fallback for an explicit path')
})

await test('a provider failure other than not-found propagates without a fallback', async () => {
  const service = lookupService([], new Error('provider offline'))
  await assert.rejects(resolveAgyExecutable(service, 'agy', { HOME: '/home/fan' }), /provider offline/)
  assert.deepEqual(service.calls, ['agy'])
})

await test('an already-cancelled request short-circuits before executable resolution and spawn', async () => {
  const controller = new AbortController()
  controller.abort()
  let spawned = 0
  const service = lookupService(['agy'])
  const host = providerHost(() => { spawned += 1; return fakeChild([]) })
  host.subprocess.resolveExecutable = service.resolveExecutable
  apply(host, Config({}))
  await assert.rejects(host.provider.start(request('task', controller.signal)), /request was aborted before agy startup/)
  assert.deepEqual(service.calls, [], 'no lookup for a cancelled request')
  assert.equal(spawned, 0)
})

await test('the provider spawns the fallback executable and logs it once', async () => {
  const service = lookupService(['/home/fan/.local/bin/agy'])
  const argv = []
  const infos = []
  const resultEvent = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } })
  const host = providerHost((spec) => { argv.push(spec.argv[0]); return fakeChild([resultEvent]) })
  host.subprocess.resolveExecutable = service.resolveExecutable
  host.logger.info = (message) => infos.push(message)
  apply(host, Config({ env: { HOME: '/home/fan' } }))
  for (let i = 0; i < 2; i += 1) {
    const run = await host.provider.start(request('task'))
    assert.equal((await run.result).stopReason, 'completed')
    await run.dispose()
  }
  assert.deepEqual(argv, ['/home/fan/.local/bin/agy', '/home/fan/.local/bin/agy'])
  assert.equal(infos.length, 1)
  assert.match(infos[0], /"agy" is not on PATH; using \/home\/fan\/\.local\/bin\/agy/)
})

console.log(`\n${passed} mock tests passed`)
/**
 * Pure contract tests for the agy provider. No process or network access.
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Config, apply, buildAgyArgv, createLineCapStream, createRunRegistry, createStderrCapture, defineAgyRunsTool, deniedActionLabels, describeAgyFailure, formatAgyRuns, formatRunDuration, parseAgyErrorLine, parseAgyResult, runStatusRow, textTask } from '../lib/index.js'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

await test('textTask joins text blocks and rejects empty tasks', () => {
  assert.equal(textTask([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb')
  assert.throws(() => textTask([]), /only text blocks/)
  assert.throws(() => textTask([{ type: 'image', text: 'x' }]), /only text blocks/)
  assert.throws(() => textTask([{ type: 'text', text: '   ' }]), /must not be empty/)
})

await test('buildAgyArgv keeps the task out of argv and forwards CLI options', () => {
  const argv = buildAgyArgv({
    command: 'agy',
    mode: 'accept-edits',
    model: 'gemini-3.8-flash-low',
    effort: 'low',
    timeout: '10m',
    addDirs: ['/tmp/extra'],
    disableSlashCommands: true,
    dangerouslySkipPermissions: true,
  })
  assert.deepEqual(argv, [
    'agy',
    '--print=',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--mode',
    'accept-edits',
    '--model',
    'gemini-3.8-flash-low',
    '--effort',
    'low',
    '--print-timeout',
    '10m',
    '--dangerously-skip-permissions',
    '--add-dir',
    '/tmp/extra',
  ])
})

await test('buildAgyArgv reads a volatile permission reference', () => {
  const on = buildAgyArgv({ command: 'agy', disableSlashCommands: false, dangerouslySkipPermissions: { get: () => true } })
  assert.ok(on.includes('--dangerously-skip-permissions'))
  const off = buildAgyArgv({ command: 'agy', disableSlashCommands: false, dangerouslySkipPermissions: { get: () => false } })
  assert.ok(!off.includes('--dangerously-skip-permissions'))
})

await test('createLineCapStream passes normal lines and splits oversized ones', async () => {
  const { PassThrough } = await import('node:stream')
  const cap = createLineCapStream(16)
  const sink = new PassThrough()
  const chunks = []
  sink.on('data', (c) => chunks.push(c))
  cap.pipe(sink)
  cap.write('short line\n')
  cap.write(`x${'y'.repeat(39)}\n`)
  cap.write('tail line\n')
  await new Promise((resolve) => setImmediate(resolve))
  cap.end()
  const text = Buffer.concat(chunks).toString('utf8')
  assert.equal(text, 'short line\n' + 'x' + 'y'.repeat(15) + '\n' + 'tail line\n', JSON.stringify(text))
})

await test('parseAgyResult returns the exact success response', () => {
  assert.equal(parseAgyResult({ status: 'SUCCESS', response: 'hello\n' }), 'hello\n')
})

await test('parseAgyResult rejects CLI errors, timeouts, denials, and blank answers', () => {
  assert.throws(() => parseAgyResult({ status: 'ERROR', error: 'bad model' }), /agy failed: bad model/)
  assert.throws(() => parseAgyResult({ status: 'SUCCESS', response: '', finished_reason: 'print_timeout' }), /print timeout/)
  assert.throws(
    () => parseAgyResult({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] }),
    /denied tools: RunCommand/,
  )
  assert.throws(() => parseAgyResult({ status: 'SUCCESS', response: '' }), /no final answer/)
  assert.throws(() => parseAgyResult(null), /invalid result/)
})

await test('parseAgyResult rejects early finish reasons and non-SUCCESS statuses on their own', () => {
  // Without an `error` field, the status check is what fires.
  assert.throws(() => parseAgyResult({ status: 'ERROR' }), /ended with status ERROR/)
  assert.throws(() => parseAgyResult({ status: 'CANCELLED' }), /ended with status CANCELLED/)
  // A non-completed finish reason is terminal even with a non-empty response.
  assert.throws(
    () => parseAgyResult({ status: 'SUCCESS', response: 'partial', finished_reason: 'interrupted' }),
    /turn ended early \(interrupted\)/,
  )
})

await test('Config fills deployment defaults and apply registers the agy provider', () => {
  const resolved = Config({})
  assert.equal(resolved.command, 'agy')
  assert.equal(resolved.mode, '')
  assert.equal(resolved.disableSlashCommands, true)
  const permissionFlag = resolved.dangerouslySkipPermissions
  assert.equal(typeof permissionFlag?.get === 'function' ? permissionFlag.get() : permissionFlag, false)
  assert.equal(resolved.disposeGraceMs, 3000)
  assert.deepEqual(resolved.addDirs, [])
  assert.equal(resolved.idleTimeoutMs, 0, 'the silence watchdog is opt-in')
  assert.equal(resolved.maxRunMs, 7_200_000, 'the wall-clock cap defaults to 2 hours')
  assert.equal(resolved.avoidBrowser, true)

  const registered = []
  const ctx = {
    subagents: { registerProvider: (provider) => registered.push(provider) },
    subprocess: { resolveExecutable: async () => '/usr/local/bin/agy', spawn: () => { throw new Error('unused') } },
    logger: { warn: () => {} },
    effect: () => () => {},
  }
  apply(ctx, resolved)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'agy')
  assert.deepEqual(registered[0].capabilities, {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  })
  assert.equal(registered[0].inheritsParentContext, false)
})

await test('apply rejects plan mode without slash expansion, bad timers, and bad addDirs', () => {
  const ctx = {
    subagents: { registerProvider: () => {} },
    subprocess: {},
    logger: { warn: () => {} },
    effect: () => () => {},
  }
  assert.throws(() => apply(ctx, Config({ mode: 'plan' })), /mode "plan" is implemented by agy as a slash command/)
  assert.throws(() => apply(ctx, Config({ disposeGraceMs: 0 })), /disposeGraceMs must be a positive finite number/)
  assert.throws(() => apply(ctx, Config({ idleTimeoutMs: -5 })), /idleTimeoutMs must be a positive finite number/)
  assert.throws(() => apply(ctx, Config({ addDirs: ['relative/path'] })), /addDirs must be absolute paths/)
  assert.throws(() => apply(ctx, Config({ addDirs: ['/definitely/not/here-xyz'] })), /addDirs entry does not exist/)
  assert.throws(() => apply(ctx, Config({ addDirs: [fileURLToPath(import.meta.url)] })), /addDirs entry is not a directory/)
  assert.throws(() => apply(ctx, Config({ maxRunMs: -1 })), /maxRunMs must be a positive finite number/)
  assert.throws(() => apply(ctx, Config({ maxRunMs: Number.POSITIVE_INFINITY })), /maxRunMs must be a positive finite number/)
  assert.throws(() => apply(ctx, Config({ maxRunMs: 2 ** 31 })), /maxRunMs must be 0 \(disabled\) or no greater than/)
  assert.doesNotThrow(() => apply(ctx, Config({ idleTimeoutMs: 0 })))
  assert.doesNotThrow(() => apply(ctx, Config({ maxRunMs: 0 })))
  assert.doesNotThrow(() => apply(ctx, Config({ mode: 'plan', disableSlashCommands: false })))
})

await test('apply passes unknown mode and effort values through with a warning', () => {
  const warnings = []
  const ctx = {
    subagents: { registerProvider: () => {} },
    subprocess: {},
    logger: { warn: (message) => warnings.push(message) },
    effect: () => () => {},
  }
  // A CLI upgrade may add enum values; the plugin must not dead-end at load.
  assert.doesNotThrow(() => apply(ctx, Config({ mode: 'ultra' })))
  assert.doesNotThrow(() => apply(ctx, Config({ effort: 'ultra' })))
  assert.ok(warnings.some((message) => /config mode "ultra"/.test(message)), warnings.join(' | '))
  assert.ok(warnings.some((message) => /config effort "ultra"/.test(message)), warnings.join(' | '))
})

await test('formatRunDuration renders compact elapsed values', () => {
  assert.equal(formatRunDuration(0), '0s')
  assert.equal(formatRunDuration(12_400), '12s')
  assert.equal(formatRunDuration(252_000), '4m12s')
  assert.equal(formatRunDuration(3_780_000), '1h03m')
})

await test('runStatusRow projects a live record with elapsed and tool age', () => {
  const record = {
    runId: 'abcdef12-3456',
    label: 'audit',
    state: 'running',
    startedAt: 1_000,
    settledAt: undefined,
    lastTool: 'search_web',
    lastToolAt: 9_000,
    lastText: 'partial answer',
    toolCalls: 2,
    steps: 5,
    error: '',
  }
  const row = runStatusRow(record, 10_000)
  assert.equal(row.elapsedMs, 9_000)
  assert.equal(row.lastToolAgoMs, 1_000)
  assert.equal(row.state, 'running')
  assert.equal(row.lastText, 'partial answer')
  // Once settled, the tool age freezes against the settlement time.
  const settled = runStatusRow({ ...record, state: 'done', settledAt: 13_000 }, 100_000)
  assert.equal(settled.elapsedMs, 12_000)
  assert.equal(settled.lastToolAgoMs, 4_000)
})

await test('formatAgyRuns renders one line per run and a placeholder when empty', () => {
  assert.equal(formatAgyRuns([]), '(no agy runs)')
  const lines = formatAgyRuns([
    {
      runId: 'abcdef12-3456',
      label: 'audit',
      state: 'running',
      elapsedMs: 252_000,
      lastTool: 'search_web',
      lastToolAgoMs: 8_000,
      lastText: 'The latest LTS version is v26.13.0, released last week and',
      toolCalls: 2,
      steps: 7,
      error: '',
    },
    {
      runId: 'deadbeef-0000',
      label: '',
      state: 'failed',
      elapsedMs: 3_000,
      lastTool: '',
      lastToolAgoMs: 0,
      lastText: '',
      toolCalls: 0,
      steps: 0,
      error: 'agy produced no final answer (denied tools: RunCommand)',
    },
  ]).split('\n')
  assert.equal(lines.length, 2)
  assert.match(
    lines[0],
    /^abcdef12 \[running\] audit · 4m12s · last tool search_web \(8s ago\) · text …sion is v26\.13\.0, released last week and · 2 tool calls · step 7$/,
  )
  assert.match(lines[1], /^deadbeef \[failed\] \(unlabeled\) · 3s · error: agy produced no final answer \(denied tools: RunCommand\)$/)
})

await test('agy_runs follows the subagent_agy delegation tool', async () => {
  const definitions = new Map()
  const contexts = []
  const changeListeners = []
  const tctx = {
    effect: (run) => {
      run()
      return () => {}
    },
    on: (event, listener) => {
      assert.equal(event, 'tools/change')
      changeListeners.push(listener)
      return () => {
        const at = changeListeners.indexOf(listener)
        if (at >= 0) changeListeners.splice(at, 1)
      }
    },
    tools: {
      register: (definition) => {
        definitions.set(definition.name, definition)
        return () => {
          definitions.delete(definition.name)
        }
      },
      get: (name) => definitions.get(name),
    },
    systemPrompt: {
      getContextOrder: (name) => {
        assert.equal(name, 'SUBAGENT_DELEGATION')
        return 120
      },
      context: (context) => {
        contexts.push(context)
        return () => {
          const at = contexts.indexOf(context)
          if (at >= 0) contexts.splice(at, 1)
        }
      },
    },
  }
  const ctx = {
    subagents: { registerProvider: () => {} },
    subprocess: {},
    logger: { warn: () => {} },
    effect: () => () => {},
    inject: (deps, callback) => {
      if (deps.includes('tools')) callback(tctx)
    },
  }
  apply(ctx, Config({}))
  assert.equal(definitions.size, 0, 'agy_runs stays off until subagent_agy exists')
  assert.equal(contexts.length, 0)
  assert.equal(changeListeners.length, 1)

  const disposeDelegation = tctx.tools.register({ name: 'subagent_agy' })
  for (const listener of [...changeListeners]) listener()
  const tool = definitions.get('agy_runs')
  assert.ok(tool, 'agy_runs registers once subagent_agy is present')
  assert.match(tool.description, /never appear in `list_agents`/)
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} })
  const rows = await tool.execute({}, { agent: { id: 'someone-else' } })
  assert.deepEqual(rows, [])
  assert.equal(tool.output.render({}, rows)[0].text, '(no agy runs)')
  assert.equal(contexts.length, 1)
  assert.equal(contexts[0].name, 'tool:agy_runs')
  assert.equal(contexts[0].order, 120)
  assert.match(contexts[0].text({ scope: 'any' }), /never poll `list_agents`/)

  for (const listener of [...changeListeners]) listener()
  assert.equal(definitions.get('agy_runs'), tool, 'a second change does not re-register')
  assert.equal(contexts.length, 1)

  disposeDelegation()
  for (const listener of [...changeListeners]) listener()
  assert.equal(definitions.has('agy_runs'), false, 'agy_runs unregisters when subagent_agy leaves')
  assert.equal(contexts.length, 0)
})

await test('defineAgyRunsTool projects a seeded registry for its calling agent only', async () => {
  const registry = createRunRegistry({ now: () => 1000 })
  const record = registry.begin({ runId: 'seed-run-0001', parentId: 'agent-a', label: 'seeded audit' })
  registry.observe(
    record,
    JSON.parse(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 3, state: 'DONE', step_type: 'tool', tool_info: { name: 'search_web' } },
      }),
    ),
  )
  registry.observe(
    record,
    JSON.parse(
      JSON.stringify({
        event: 'step_update',
        step_update: { step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: ' found v1.4.12' },
      }),
    ),
  )

  const tool = defineAgyRunsTool(registry)
  assert.equal(tool.name, 'agy_runs')
  const rows = await tool.execute({}, { agent: { id: 'agent-a' } })
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0].runId, 'seed-run-0001')
  assert.equal(rows[0].state, 'running')
  assert.equal(rows[0].steps, 4)
  assert.equal(rows[0].toolCalls, 1)
  assert.equal(rows[0].lastTool, 'search_web')
  assert.equal(rows[0].lastText, ' found v1.4.12')
  const rendered = tool.output.render({}, rows)[0].text
  assert.match(rendered, /seed-run \[running\] seeded audit/)
  assert.match(rendered, /text … found v1\.4\.12/)

  // Another agent sees nothing of someone else's runs.
  assert.deepEqual(await tool.execute({}, { agent: { id: 'agent-b' } }), [])
  assert.deepEqual(await tool.execute({}, {}), [])
})

await test('parseAgyErrorLine reads agy structured stderr errors and ignores everything else', () => {
  assert.deepEqual(
    parseAgyErrorLine('AGY_ERROR: {"short_error":"print timeout after 3s","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}'),
    { shortError: 'print timeout after 3s', status: 'DEADLINE_EXCEEDED', reason: 'print_timeout', retryable: false },
  )
  assert.equal(parseAgyErrorLine('error: print timeout'), undefined)
  assert.equal(parseAgyErrorLine('AGY_ERROR: not json'), undefined)
  assert.equal(parseAgyErrorLine('AGY_ERROR: {}'), undefined)
})

await test('createStderrCapture keeps a bounded UTF-8 tail and parses AGY_ERROR split across chunks', () => {
  const forwarded = []
  const capture = createStderrCapture({ tailBytes: 64, forward: (chunk) => forwarded.push(chunk) })
  capture.push(Buffer.from('x'.repeat(200) + '\n'))
  capture.push('AGY_ERROR: {"short_error":"boom",')
  capture.push('"reason":"internal"}\n中文结尾')
  capture.end()
  assert.equal(forwarded.length, 3, 'every chunk is forwarded')
  assert.ok(Buffer.byteLength(capture.tail()) <= 64)
  assert.match(capture.tail(), /中文结尾$/)
  assert.doesNotMatch(capture.tail(), /\uFFFD/, 'a byte-trimmed tail never starts mid-character')
  assert.deepEqual(capture.agyError(), { shortError: 'boom', reason: 'internal' })
  const silent = createStderrCapture({ forward: false })
  silent.push('AGY_ERROR: {"reason":"last"}')
  silent.end()
  assert.deepEqual(silent.agyError(), { reason: 'last' }, 'an unterminated final line is still scanned')
})

await test('describeAgyFailure keeps stderr out of the message and in the diagnostic', () => {
  const failure = describeAgyFailure({
    headline: 'subagent-agy: boom',
    outcome: { exitCode: null, signal: 'SIGTERM' },
    record: { conversationId: 'c-1', steps: 4, activeTool: '', lastTool: 'view_file', deniedTools: ['RunCommand'] },
    agyError: { shortError: 'bad', reason: 'r' },
    stderrTail: 'tail line',
  })
  assert.equal(failure.message, 'subagent-agy: boom\nagy facts: signal: SIGTERM; conversation: c-1; steps: 4; last tool: view_file; denied tools: RunCommand\nagy error: bad (reason: r)')
  assert.equal(failure.diagnostic, `${failure.message}\nagy stderr (tail):\ntail line`)
  assert.equal(describeAgyFailure({ headline: 'h' }).diagnostic, 'h')
})

await test('deniedActionLabels deduplicates labels and tolerates odd shapes', () => {
  assert.deepEqual(deniedActionLabels({ denied_actions: [{ action: 'command', display_name: 'RunCommand' }, 'Browser', { action: 'edit' }, { display_name: 'RunCommand' }, null] }), ['RunCommand', 'Browser', 'edit'])
  assert.deepEqual(deniedActionLabels(undefined), [])
})

await test('the run registry records conversation id and in-flight tools', () => {
  let clock = 0
  const registry = createRunRegistry({ now: () => clock })
  const record = registry.begin({ runId: 'r1' })
  registry.observe(record, { event: 'init', conversation_id: 'conv-9', init: {} })
  clock = 1000
  registry.observe(record, { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'run_command' } } })
  assert.equal(record.activeTool, 'run_command')
  assert.equal(record.activeToolSince, 1000)
  registry.observe(record, { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_info: { name: 'run_command' } } })
  assert.equal(record.activeTool, '')
  registry.observe(record, { event: 'result', result: { denied_actions: [{ display_name: 'RunCommand' }] } })
  const row = runStatusRow(record, 2000)
  assert.equal(row.conversationId, 'conv-9')
  assert.deepEqual(row.deniedTools, ['RunCommand'])
  const line = formatAgyRuns([row])
  assert.match(line, /conversation conv-9/)
  assert.match(line, /denied: RunCommand/)
})

console.log(`\n${passed} unit tests passed`)

/**
 * End-to-end smoke tests against the real local `agy` CLI.
 *
 * These tests spend model quota. Run `node test/smoke.mjs` explicitly.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgyArgv, createRunRegistry, startAgyRun } from '../lib/index.js'
import { localSpawn } from './harness.mjs'

const config = {
  command: 'agy',
  env: {},
  disposeGraceMs: 3000,
  mode: 'accept-edits',
  // Intentionally empty: the plugin never overrides agy's own model choice,
  // so the smoke survives model renames and host account changes.
  model: '',
  effort: 'low',
  timeout: '',
  addDirs: [],
  disableSlashCommands: true,
  dangerouslySkipPermissions: false,
  idleTimeoutMs: 0,
  avoidBrowser: true,
}

function spec(cwd) {
  return {
    cwd,
    argv: buildAgyArgv(config, 'agy'),
    env: {},
    disposeGraceMs: config.disposeGraceMs,
    spawn: localSpawn,
    onError: (error) => console.error('provider diagnostic:', error.message),
  }
}

async function start(cwd, text, signal = new AbortController().signal) {
  return startAgyRun({ cwd, prompt: [{ type: 'text', text }], signal }, spec(cwd))
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const workspace = await mkdtemp(join(tmpdir(), 'agy-subagent-smoke-'))
try {
  await test('returns the final answer for a text task', async () => {
    const run = await start(workspace, 'Reply with exactly: AGY_PLUGIN_OK')
    try {
      const result = await run.result
      assert.equal(result.stopReason, 'completed', JSON.stringify(result))
      const text = result.output.map((block) => block.text).join('')
      assert.match(text, /AGY_PLUGIN_OK/)
    } finally {
      await run.dispose()
    }
  })

  await test('writes a workspace file under accept-edits', async () => {
    const run = await start(workspace, 'Create a file named proof.txt containing exactly: PLUGIN_WROTE_THIS')
    try {
      const result = await run.result
      assert.equal(result.stopReason, 'completed', JSON.stringify(result))
      assert.equal((await readFile(join(workspace, 'proof.txt'), 'utf8')).trim(), 'PLUGIN_WROTE_THIS')
    } finally {
      await run.dispose()
    }
  })

  await test('settles as aborted when the request signal fires', async () => {
    const controller = new AbortController()
    const run = await start(workspace, 'Count slowly from 1 to 500, one number per line.', controller.signal)
    setTimeout(() => controller.abort(new Error('test cancellation')), 1500)
    try {
      const result = await run.result
      assert.equal(result.stopReason, 'aborted', JSON.stringify(result))
    } finally {
      await run.dispose()
    }
  })

  await test('tracks a live run in the registry until it settles', async () => {
    const registry = createRunRegistry()
    const parent = { id: 'smoke-parent' }
    const run = await startAgyRun(
      {
        cwd: workspace,
        parent,
        label: 'smoke-progress',
        prompt: [{ type: 'text', text: 'Search the web for the latest Node.js LTS version, then reply with it in one short line.' }],
        signal: new AbortController().signal,
      },
      { ...spec(workspace), registry },
    )
    try {
      const seen = registry.list(parent.id)
      assert.equal(seen.length, 1, 'the run is visible while it is live')
      assert.equal(seen[0].label, 'smoke-progress')
      const result = await run.result
      assert.equal(result.stopReason, 'completed', JSON.stringify(result))
      const [record] = registry.list(parent.id)
      assert.equal(record.state, 'done')
      assert.ok(record.steps >= 1, `expected at least one step, saw ${record.steps}`)
      assert.ok(record.lastTool.length > 0, `expected a recorded tool name, saw ${JSON.stringify(record.lastTool)}`)
    } finally {
      await run.dispose()
    }
  })
  await test('a denied shell command surfaces the denial, conversation id, and agy stderr hint', async () => {
    const registry = createRunRegistry()
    const parent = { id: 'smoke-denied' }
    const run = await startAgyRun(
      { cwd: workspace, parent, prompt: [{ type: 'text', text: 'Use the run_command tool to run exactly: echo SMOKE_SHELL . Then report its output.' }], signal: new AbortController().signal },
      { ...spec(workspace), registry, forwardStderr: false },
    )
    try {
      const result = await run.result
      const [record] = registry.list(parent.id)
      assert.ok(record.conversationId.length > 0, 'conversation id recorded')
      assert.deepEqual(record.deniedTools, ['RunCommand'], JSON.stringify(record))
      assert.ok(typeof result.diagnostic === 'string', JSON.stringify(result))
      if (result.stopReason === 'completed') {
        assert.match(result.diagnostic, /auto-denied .*RunCommand/)
      } else {
        assert.equal(result.stopReason, 'error', JSON.stringify(result))
        assert.match(result.diagnostic, /denied tools: RunCommand/)
        assert.match(result.diagnostic, new RegExp(`conversation: ${record.conversationId}`))
        assert.match(result.diagnostic, /agy stderr \(tail\)/)
      }
    } finally {
      await run.dispose()
    }
  })

  await test('a print timeout carries the parsed AGY_ERROR into the diagnostic', async () => {
    const timed = { ...config, timeout: '2s' }
    const run = await startAgyRun(
      { cwd: workspace, prompt: [{ type: 'text', text: 'Write a 1500 word essay about rivers.' }], signal: new AbortController().signal },
      { ...spec(workspace), argv: buildAgyArgv(timed, 'agy'), forwardStderr: false },
    )
    try {
      const result = await run.result
      assert.equal(result.stopReason, 'error', JSON.stringify(result))
      assert.match(result.diagnostic, /print timeout expired/)
      assert.match(result.diagnostic, /agy error: .*reason: print_timeout/)
      assert.match(result.diagnostic, /exit code: 0/)
    } finally {
      await run.dispose()
    }
  })
  await test('the wall-clock cap terminates a real run as an error with run facts', async () => {
    const run = await startAgyRun(
      { cwd: workspace, prompt: [{ type: 'text', text: 'Write a 3000 word essay about rivers.' }], signal: new AbortController().signal },
      { ...spec(workspace), maxRunMs: 4000, forwardStderr: false },
    )
    try {
      const result = await run.result
      assert.equal(result.stopReason, 'error', JSON.stringify(result))
      assert.match(result.diagnostic, /hit the 4000ms run cap \(maxRunMs\)/)
      assert.match(result.diagnostic, /conversation: [0-9a-f-]{36}/)
    } finally {
      await run.dispose()
    }
  })
} finally {
  await rm(workspace, { recursive: true, force: true })
}

console.log(`\n${passed} smoke tests passed`)

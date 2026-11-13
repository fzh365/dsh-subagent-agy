/**
 * Windows extras that the shipped smoke does not cover, driven through the
 * REAL subprocess seam (@deepseek-ai/dsh-subprocess-local) instead of the
 * test harness's raw child_process:
 *
 *  1. addDirs: accept-edits may write into an --add-dir outside the workspace.
 *  2. cancel through the managed range: a blocked tool run is aborted and the
 *     whole tree (agy → shell → grandchild sleeper) is gone, not orphaned.
 *
 * Windows only. Spends agy quota (2 agy sessions). Needs the real subprocess
 * service once: npm i --no-save @deepseek-ai/dsh-subprocess-local@0.2.2-rc.3
 * Run explicitly: node test/windows-extra.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgyArgv, createRunRegistry, startAgyRun } from '../lib/index.js'

if (process.platform !== 'win32') {
  console.log('windows-extra: skipped (Windows only)')
  process.exit(0)
}

// Loaded after the platform guard so other platforms skip without these installed.
const { Context } = await import('@deepseek-ai/cordis')
const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')

const ctx = new Context()
const fiber = await ctx.plugin(LocalSubprocessRuntime)
await fiber

const baseConfig = {
  command: 'agy',
  env: {},
  disposeGraceMs: 3000,
  mode: '',
  model: '',
  effort: 'low',
  timeout: '',
  addDirs: [],
  disableSlashCommands: true,
  dangerouslySkipPermissions: false,
  idleTimeoutMs: 0,
  avoidBrowser: true,
}

const executable = await ctx.subprocess.resolveExecutable('agy', {}, undefined)
console.log(`agy executable: ${executable}`)

async function startRun(cwd, text, config, signal, registry) {
  const run = await startAgyRun(
    { cwd, parent: { id: 'windows-extra' }, prompt: [{ type: 'text', text }], signal },
    {
      cwd,
      argv: buildAgyArgv(config, executable),
      env: {},
      disposeGraceMs: config.disposeGraceMs,
      idleTimeoutMs: config.idleTimeoutMs,
      registry,
      forwardStderr: false,
      spawn: (spec) => ctx.subprocess.spawn(spec),
      onError: (error) => console.error('provider diagnostic:', error.message),
    },
  )
  return run
}

/** agy.exe processes currently alive (other apps included, so compare deltas). */
function agyProcessCount() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process agy -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8' })
  return Number.parseInt(out.trim(), 10) || 0
}

const workspace = await mkdtemp(join(tmpdir(), 'agy-win-extra-'))
const extraDir = await mkdtemp(join(tmpdir(), 'agy-win-extra-added-'))
const marker = 'AGY_TREE_MARKER_9f3c'
const sleeper = join(workspace, 'sleeper.ps1')
const queryScript = join(workspace, 'query-marker.ps1')
await writeFile(sleeper, 'param([string]$Marker)\nStart-Sleep -Seconds 120\nWrite-Output "slept $Marker"\n')
// Query from a script file, so the query process's own command line never
// contains the marker it searches for.
await writeFile(
  queryScript,
  `$m = '${marker}'\nGet-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) -and $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }\n`,
)

/** Live processes whose command line contains the marker. */
function markerProcesses() {
  const out = execFileSync('powershell', ['-NoProfile', '-File', queryScript], { encoding: 'utf8' })
  return out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

try {
  await test('addDirs lets accept-edits write outside the session workspace', async () => {
    const config = { ...baseConfig, mode: 'accept-edits', addDirs: [extraDir] }
    const run = await startRun(
      workspace,
      `Create a file named extra-proof.txt in the directory ${extraDir} containing exactly: EXTRA_DIR_OK`,
      config,
      new AbortController().signal,
    )
    try {
      const result = await run.result
      assert.equal(result.stopReason, 'completed', JSON.stringify(result))
      assert.equal((await readFile(join(extraDir, 'extra-proof.txt'), 'utf8')).trim(), 'EXTRA_DIR_OK')
    } finally {
      await run.dispose()
    }
  })

  await test('cancelling a blocked run through the managed range reaps the grandchild', async () => {
    const config = { ...baseConfig, dangerouslySkipPermissions: true }
    const registry = createRunRegistry()
    const controller = new AbortController()
    const before = agyProcessCount()
    const run = await startRun(
      workspace,
      `Use your shell tool to run exactly this command and then report DONE: powershell -NoProfile -ExecutionPolicy Bypass -File "${sleeper}" ${marker} . It sleeps for two minutes.`,
      config,
      controller.signal,
      registry,
    )

    let seen = []
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      seen = markerProcesses()
      if (seen.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    assert.ok(seen.length > 0, 'the sleeper grandchild was started')
    console.log(`   marker observed: ${seen[0]}`)

    controller.abort(new Error('windows-extra cancel'))
    const result = await run.result
    assert.equal(result.stopReason, 'aborted', JSON.stringify(result))
    await run.dispose()

    let goneAfter = []
    const reapDeadline = Date.now() + 20_000
    while (Date.now() < reapDeadline) {
      goneAfter = markerProcesses()
      if (goneAfter.length === 0 && agyProcessCount() <= before) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.deepEqual(goneAfter, [], `grandchild survived termination: ${goneAfter.join(', ')}`)
    assert.ok(agyProcessCount() <= before, 'no agy process left behind')

    const [record] = registry.list('windows-extra')
    assert.ok(record.conversationId.length > 0, 'conversation id recorded')
    assert.equal(record.state, 'aborted')
  })
} finally {
  await rm(workspace, { recursive: true, force: true })
  await rm(extraDir, { recursive: true, force: true })
  await fiber.dispose?.()
}

console.log(`\n${passed} windows extras passed`)
process.exit(0)

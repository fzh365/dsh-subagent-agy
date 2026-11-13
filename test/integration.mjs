/**
 * Real-Cordis integration tests: the plugin registers its read-only `agy_runs`
 * tool and delegation context through the actual dependency-injection seam
 * only while `subagent_agy` is present, suppresses the automatic settings
 * section, and loads through `ctx.plugin` with its declared injects. No agy
 * process, model quota, or network access.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply, inject, name } from '../lib/index.js'

/** Provide every service the plugin needs onto one fresh Cordis context. */
function provideAll(ctx, sink, settings) {
  const defs = new Map()
  ctx.provide('subagents', { registerProvider: (provider) => sink.providers.push(provider) })
  ctx.provide('subprocess', {})
  ctx.provide('logger', { warn: () => {}, info: () => {}, debug: () => {} })
  ctx.provide('settings', settings)
  ctx.provide('tools', {
    register: (definition) => {
      defs.set(definition.name, definition)
      sink.definitions.push(definition)
      ctx.emit('tools/change')
      return () => {
        defs.delete(definition.name)
        const at = sink.definitions.indexOf(definition)
        if (at >= 0) sink.definitions.splice(at, 1)
        ctx.emit('tools/change')
      }
    },
    get: (query) => defs.get(query),
  })
  ctx.provide('systemPrompt', {
    getContextOrder: () => 120,
    context: (contribution) => {
      sink.contexts.push(contribution)
      return () => {
        const at = sink.contexts.indexOf(contribution)
        if (at >= 0) sink.contexts.splice(at, 1)
      }
    },
  })
}

/** Wait for a condition driven by the event loop, with a hard failure instead of a fixed sleep. */
async function waitFor(condition, label) {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function stubDelegationTool() {
  return { name: 'subagent_agy' }
}

// Direct apply: validates the registration surface itself.
{
  const ctx = new Context()
  const sink = { providers: [], definitions: [], contexts: [] }
  const configureCalls = []
  provideAll(ctx, sink, { configure: (patch, owner) => configureCalls.push([patch, owner]) })

  apply(ctx, Config({}))
  await waitFor(() => sink.providers.length === 1, 'provider registration')
  assert.equal(sink.providers[0].name, 'agy')
  assert.equal(sink.definitions.length, 0, 'agy_runs waits for subagent_agy')
  assert.equal(sink.contexts.length, 0)
  assert.equal(configureCalls.length, 1, 'the automatic settings section is suppressed once')
  assert.deepEqual(configureCalls[0][0], { auto: false })
  assert.equal(configureCalls[0][1], ctx.fiber, "the presentation owner is the plugin's own fiber")

  const disposeDelegation = ctx.tools.register(stubDelegationTool())
  await waitFor(
    () => sink.definitions.some((definition) => definition.name === 'agy_runs') && sink.contexts.length === 1,
    'agy_runs follows subagent_agy',
  )
  assert.deepEqual(sink.definitions.map((definition) => definition.name).sort(), ['agy_runs', 'subagent_agy'])
  assert.equal(sink.contexts[0].name, 'tool:agy_runs')
  assert.equal(sink.contexts[0].order, 120)

  disposeDelegation()
  await waitFor(
    () => !sink.definitions.some((definition) => definition.name === 'agy_runs') && sink.contexts.length === 0,
    'agy_runs leaves with subagent_agy',
  )
}

// Full lifecycle: `ctx.plugin` gates the declared injects and activates apply
// exactly the way the host loads the package.
{
  const ctx = new Context()
  const sink = { providers: [], definitions: [], contexts: [] }
  provideAll(ctx, sink, { configure: () => {} })

  const fiber = ctx.plugin({ name, inject, Config, apply }, {})
  await fiber
  await waitFor(() => sink.providers.length === 1, 'plugin activation')
  assert.equal(sink.providers[0].name, 'agy')
  assert.equal(sink.definitions.length, 0, 'agy_runs is still waiting after plugin activation')

  const disposeDelegation = ctx.tools.register(stubDelegationTool())
  await waitFor(
    () => sink.definitions.some((definition) => definition.name === 'agy_runs') && sink.contexts.length === 1,
    'agy_runs activates through ctx.plugin',
  )
  assert.ok(sink.definitions.some((definition) => definition.name === 'agy_runs'))
  assert.equal(sink.contexts[0].name, 'tool:agy_runs')

  disposeDelegation()
  await waitFor(
    () => !sink.definitions.some((definition) => definition.name === 'agy_runs') && sink.contexts.length === 0,
    'agy_runs deactivates through ctx.plugin',
  )
}

console.log('integration test passed')

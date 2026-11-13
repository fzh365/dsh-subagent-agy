import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Load the browser bundle with a minimal but STATEFUL React stub: hook cells
 * persist across manual re-renders so state transitions (toggle, failure) can
 * actually be asserted.
 */
function loadClient() {
  let registration
  const hooks = []
  let cursor = 0
  const slot = () => {
    const index = cursor
    cursor += 1
    return index
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const index = slot()
      if (hooks[index] === undefined) hooks[index] = initial
      const set = (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      }
      return [hooks[index], set]
    },
    useCallback: (fn) => {
      slot()
      return fn
    },
    useMemo: (fn) => {
      slot()
      return fn()
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => {
      slot()
      return getSnapshot()
    },
  }
  const window = {
    __ModuleLoader__: {
      load: (value) => {
        registration = value
      },
    },
  }
  const context = vm.createContext({
    window,
    require: (id) => {
      if (id === 'react') return React
      throw new Error(`unexpected require ${id}`)
    },
  })
  vm.runInContext(source, context)
  assert.ok(registration, 'client bundle registers a module')
  assert.equal(registration.id, 'dsh-subagent-agy')
  const client = registration.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require ${id}`)
  })
  return {
    client,
    /** Render one component with the hook cursor rewound to zero. */
    render: (component, props) => {
      cursor = 0
      return component(props)
    },
    /** Clear every hook cell, isolating one scenario from the next. */
    resetHooks: () => {
      hooks.length = 0
    },
  }
}

/** Depth-first search through the fake React tree. */
function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = find(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/** Collect every text leaf so copy gating can be asserted. */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object') {
    for (const child of node.children ?? []) collectText(child, out)
  }
  return out
}

const { client, render, resetHooks } = loadClient()
assert.equal(typeof client.apply, 'function')
assert.deepEqual([...client.inject], ['slots', 'locale', 'configForms'])

let localeRegistration
let slotRegistration
const effects = []
const setCalls = []
/** The form the real configForms service returns for the provider row: mutable
 * snapshot so writes are visible on the next render. */
const formState = {
  snapshot: { status: 'ready', writable: true, value: { dangerouslySkipPermissions: true } },
}
const form = {
  getSnapshot: () => formState.snapshot,
  subscribe: () => () => {},
  set: async (field, value) => {
    setCalls.push([field, value])
    formState.snapshot = {
      ...formState.snapshot,
      value: { ...formState.snapshot.value, [field]: value },
    }
    return true
  },
}
const ctx = {
  locale: {
    /** The bound t asserts both dictionaries define every key it renders. */
    bind: () => (key) => {
      assert.ok(localeRegistration?.dictionary?.en?.[key] !== undefined, `missing en key: ${key}`)
      assert.ok(localeRegistration?.dictionary?.zh?.[key] !== undefined, `missing zh key: ${key}`)
      return key
    },
    register: (ns, dictionary) => {
      localeRegistration = { ns, dictionary }
      return () => {}
    },
  },
  slots: {
    inject: (name, callback) => {
      assert.equal(name, 'plugins.bundle.config')
      return callback()
    },
    register: (options, component) => {
      slotRegistration = { options, component }
      return () => {}
    },
  },
  configForms: {
    get: (id) => {
      assert.equal(id, 'subagent-agy')
      return form
    },
  },
  effect: (callback) => {
    effects.push(callback)
  },
}

client.apply(ctx)
for (const effect of effects) effect()

assert.equal(localeRegistration.ns, 'subagent-agy')
assert.ok(localeRegistration.dictionary.en)
assert.ok(localeRegistration.dictionary.zh)
assert.equal(slotRegistration.options.name, 'plugins.bundle.config')
assert.equal(slotRegistration.options.key, 'dsh-subagent-agy')
assert.equal(typeof slotRegistration.component, 'function')

const injected = slotRegistration.options.inject()
assert.equal(injected.configForms, ctx.configForms)
assert.equal(typeof injected.t, 'function')

// No props at all, the summary view, and a missing form all render nothing.
assert.equal(render(slotRegistration.component), null)
assert.equal(render(slotRegistration.component, { view: 'summary', configForms: ctx.configForms, t: injected.t }), null)
assert.equal(render(slotRegistration.component, { view: 'page', configForms: { get: () => undefined }, t: injected.t }), null)
assert.equal(render(slotRegistration.component, { view: 'page', t: injected.t }), null)

const tree = render(slotRegistration.component, { view: 'page', configForms: ctx.configForms, t: injected.t })
assert.equal(tree.props.form, form)
const rendered = render(tree.type, tree.props)
const slider = find(rendered, (node) => node.type === 'button' && node.props.role === 'switch')
assert.ok(slider, 'card renders a switch')
assert.equal(slider.props['aria-checked'], true)
assert.equal(slider.props.disabled, false)

// Toggling drives the settings form with the field's next value, and the
// re-rendered card reflects the accepted write.
assert.deepEqual(setCalls, [])
await slider.props.onClick()
assert.deepEqual(setCalls, [['dangerouslySkipPermissions', false]], 'one toggle writes one mutation')
const afterToggle = render(tree.type, tree.props)
const toggledSlider = find(afterToggle, (node) => node.type === 'button' && node.props.role === 'switch')
assert.equal(toggledSlider.props['aria-checked'], false, 'the switch flips after the accepted write')
assert.ok(collectText(afterToggle).includes('off'), 'the state label follows the accepted write')

// A refused write surfaces the failure copy instead of flipping anything.
resetHooks()
const refusedForm = {
  getSnapshot: () => ({ status: 'ready', writable: true, value: { dangerouslySkipPermissions: false } }),
  subscribe: () => () => {},
  set: async () => false,
}
const refusedTree = render(slotRegistration.component, { view: 'page', configForms: { get: () => refusedForm }, t: injected.t })
const refusedRendered = render(refusedTree.type, refusedTree.props)
const refusedSlider = find(refusedRendered, (node) => node.type === 'button' && node.props.role === 'switch')
assert.equal(refusedSlider.props['aria-checked'], false)
await refusedSlider.props.onClick()
const afterRefusal = render(refusedTree.type, refusedTree.props)
assert.ok(collectText(afterRefusal).includes('saveFailed'), 'a refused write shows the failure copy')
const refusedAfter = find(afterRefusal, (node) => node.type === 'button' && node.props.role === 'switch')
assert.equal(refusedAfter.props['aria-checked'], false, 'a refused write never flips the switch')

// The read-only copy waits for the ready snapshot; loading shows only loading.
resetHooks()
const snapshotForm = (snapshot) => ({
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  set: async () => true,
})
const loadingTree = render(slotRegistration.component, {
  view: 'page',
  configForms: { get: () => snapshotForm({ status: 'loading', writable: false, value: {} }) },
  t: injected.t,
})
const loadingTexts = collectText(render(loadingTree.type, loadingTree.props))
assert.ok(loadingTexts.includes('loading'))
assert.ok(!loadingTexts.includes('readOnly'), 'no read-only copy while loading')

resetHooks()
const readOnlyTree = render(slotRegistration.component, {
  view: 'page',
  configForms: { get: () => snapshotForm({ status: 'ready', writable: false, value: {} }) },
  t: injected.t,
})
const readOnlyRendered = render(readOnlyTree.type, readOnlyTree.props)
const readOnlyTexts = collectText(readOnlyRendered)
assert.ok(readOnlyTexts.includes('readOnly'), 'read-only copy shows once ready and not writable')
const readOnlySlider = find(readOnlyRendered, (node) => node.type === 'button' && node.props.role === 'switch')
assert.equal(readOnlySlider.props['aria-checked'], false)
assert.equal(readOnlySlider.props.disabled, true)

console.log('client bundle test passed')

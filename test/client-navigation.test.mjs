import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function mount(services) {
  let plugin, overlay
  const errors = []
  const document = {
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
  }
  runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) {
      plugin = factory(() => ({ createElement: (component, props) => ({ component, props }) }))
    } } },
    document,
    console: { error: (...args) => errors.push(args.join(' ')) },
  })
  const slots = {
    register(config, component) { if (config.name === 'shell.overlay') overlay = component },
    inject(_name, callback) { callback() },
  }
  const scope = { ...services, slots, effect: callback => callback(), get: key => services[key] }
  const ctx = {
    slots, locale: { register() {} }, effect: callback => callback(),
    inject(_names, callback) { callback(scope) },
  }
  plugin.apply(ctx)
  assert.ok(overlay, 'overlay must register')
  return { plugin, open: overlay({ t: key => key }).props.open, errors }
}

test('client: bundle metadata declares the workspace UI dependency', () => {
  assert.ok(metadata.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'))
})

test('client: desktop navigation uses scope.uiWorkspace.openSession', () => {
  const calls = []
  const mounted = mount({ uiWorkspace: { openSession: id => calls.push(id) }, sessions: {} })
  assert.ok(mounted.plugin.inject.includes('uiWorkspace'))
  mounted.open('desktop-session')
  assert.deepEqual(calls, ['desktop-session'])
  assert.deepEqual(mounted.errors, [])
})

test('client: legacy sessions.open fallback remains available when services are provided', () => {
  const calls = []
  const mounted = mount({ sessions: { open: id => calls.push(id) } })
  mounted.open('legacy-session')
  assert.deepEqual(calls, ['legacy-session'])
  assert.deepEqual(mounted.errors, [])
})

test('client: unavailable navigation reports an error instead of silently succeeding', () => {
  const mounted = mount({ sessions: {} })
  mounted.open('missing-session')
  assert.ok(mounted.errors.some(message => message.includes('无法切换会话')))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../lib/index.js'

// Exercise the public HTTP handler, including discovery, decompression and parsing.
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dss-discovery-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  let handler
  apply({ webServer: { register(route) { handler = route.handler } } })
  const session = (id, name, text = 'needle', workspace = '--fixture') => {
    const dir = join(home, 'sessions', workspace, id)
    mkdirSync(dir, { recursive: true })
    const events = [
      { type: 'session/title', data: { title: id } },
      { type: 'user/message', time: 1, data: { id: 'm1', source: { kind: 'user' }, content: text } },
    ]
    writeFileSync(join(dir, name), zstdCompressSync(Buffer.from(events.map(JSON.stringify).join('\n') + '\n')))
    return dir
  }
  const request = async (query = 'needle') => {
    let status, body
    await handler({ headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: '/?q=' + encodeURIComponent(query) }, {
      writeHead(value) { status = value },
      end(value) { body = JSON.parse(value) },
    })
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.ok, true)
    return body
  }
  return { home, session, request }
}

test('discovery: missing session root returns an empty result', async t => {
  const f = fixture(t)
  assert.deepEqual((await f.request()).groups, [])
})

for (const name of ['session.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
  test('discovery: reads ' + name, async t => {
    const f = fixture(t)
    f.session('one', name)
    const result = await f.request()
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].sessionId, 'one')
    assert.equal(result.groups[0].msgs[0].text, 'needle')
    assert.equal(result.groups[0].msgs[0].anchorKey, '13:input-messagem1')
  })
}

test('discovery: v4 takes priority over the legacy file without duplication', async t => {
  const f = fixture(t)
  f.session('one', 'session.jsonl.zstd', 'needle legacy')
  f.session('one', 'session.v4.jsonl.zstd', 'needle current')
  const result = await f.request()
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].msgs[0].text, 'needle current')
  assert.deepEqual((await f.request('legacy')).groups, [])
})

test('discovery: legacy file takes priority over other version filenames', async t => {
  const f = fixture(t)
  f.session('one', 'session.v3.jsonl.zstd', 'needle versioned')
  f.session('one', 'session.jsonl.zstd', 'needle legacy')
  assert.equal((await f.request()).groups[0].msgs[0].text, 'needle legacy')
})

test('discovery: scans multiple workspaces and skips unrelated directories', async t => {
  const f = fixture(t)
  f.session('one', 'session.jsonl.zstd')
  f.session('two', 'session.v4.jsonl.zstd', 'needle', '--other')
  f.session('ignored', 'session.v4.jsonl.zstd', 'needle', 'not-a-workspace')
  f.session('backup', 'session.v4.jsonl.zstd.bak')
  assert.deepEqual((await f.request()).groups.map(g => g.sessionId).sort(), ['one', 'two'])
})

test('discovery: ignores non-directory workspace and session entries', async t => {
  const f = fixture(t)
  f.session('one', 'session.v4.jsonl.zstd')
  writeFileSync(join(f.home, 'sessions', '--not-a-directory'), '')
  writeFileSync(join(f.home, 'sessions', '--fixture', 'metadata.json'), '{}')
  assert.equal((await f.request()).groups.length, 1)
  assert.equal((await f.request('')).groups.length, 1)
})

test('discovery: a directory with a session filename does not hide a legacy file', async t => {
  const f = fixture(t)
  const dir = f.session('one', 'session.jsonl.zstd')
  mkdirSync(join(dir, 'session.v4.jsonl.zstd'))
  assert.equal((await f.request()).groups.length, 1)
})

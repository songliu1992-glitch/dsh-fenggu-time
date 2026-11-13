// Host-half tests: holiday document validation, version ordering, and both
// HTTP routes driven through a fake webServer + a stubbed global fetch.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dataPath = fileURLToPath(new URL('../data/holidays.json', import.meta.url))
const shipped = JSON.parse(fs.readFileSync(dataPath, 'utf8'))

// Keep the sidecar out of the real profile.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fenggu-time-'))
process.env.DSH_HOME = tempHome

const host = await import('../lib/index.js')

// ---- validation ----------------------------------------------------------
const { parseHolidayDoc, compareVersion, sidecarPath, apply } = host

assert.equal(typeof parseHolidayDoc, 'function')
assert.equal(sidecarPath(), path.join(tempHome, 'plugin-state', 'fenggu-time-holidays.json'))
console.log('sidecar path ok')

const ok = parseHolidayDoc(shipped, 'bundled')
assert.equal(ok.version, shipped.version)
assert.equal(ok.origin, 'bundled')
assert.equal(ok.ranges.length, shipped.ranges.length)
console.log(`bundled document ok: v${ok.version}, ${ok.ranges.length} ranges`)

const invalid = [
  ['not an object', 'nope'],
  ['missing version', { ranges: [['2026-01-01', '2026-01-02']] }],
  ['bad version', { version: 'v2026', ranges: [['2026-01-01', '2026-01-02']] }],
  ['empty ranges', { version: '2026.1.1', ranges: [] }],
  ['bad date format', { version: '2026.1.1', ranges: [['2026/01/01', '2026-01-02']] }],
  ['impossible date', { version: '2026.1.1', ranges: [['2026-02-30', '2026-03-01']] }],
  ['reversed range', { version: '2026.1.1', ranges: [['2026-01-05', '2026-01-01']] }],
  ['absurd span', { version: '2026.1.1', ranges: [['2026-01-01', '2026-12-31']] }],
  ['bad updated', { version: '2026.1.1', updated: 'yesterday', ranges: [['2026-01-01', '2026-01-02']] }],
]
for (const [label, value] of invalid) {
  assert.throws(() => parseHolidayDoc(value, 'remote'), label)
  console.log('rejected ok:', label)
}

assert.ok(compareVersion('2026.11.2', '2026.11.1') > 0)
assert.ok(compareVersion('2027.1.1', '2026.12.9') > 0)
assert.equal(compareVersion('2026.11.1', '2026.11.1'), 0)
assert.ok(compareVersion('2026.11.1', '2026.11.2') < 0)
console.log('version ordering ok')

// ---- routes --------------------------------------------------------------
const routes = new Map()
const server = (map) => ({ register: (route) => map.set(route.path, route.handler) })
// cordis surfaces a service through `ctx.inject(deps, scope => …)`; the plugin
// must use that edge so the badge does not depend on there being a web server.
const ctx = {
  get: () => undefined,
  inject: (deps, callback) => {
    assert.deepEqual(deps, ['webServer'])
    callback({ webServer: server(routes) })
  },
}
apply(ctx)
assert.ok(routes.has('/dsh-fenggu-time/holidays'), 'GET route missing')
assert.ok(routes.has('/dsh-fenggu-time/holidays/check'), 'check route missing')
console.log('routes registered:', [...routes.keys()].join(', '))

const call = async (routePath, method) => {
  const chunks = []
  let status = 0
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (payload) => chunks.push(payload ?? ''),
  }
  await routes.get(routePath)({ method, url: routePath }, res)
  const text = chunks.join('')
  return { status, body: text === '' ? null : JSON.parse(text) }
}

{
  const got = await call('/dsh-fenggu-time/holidays', 'GET')
  assert.equal(got.status, 200)
  assert.equal(got.body.version, shipped.version)
  assert.equal(got.body.origin, 'bundled')
  assert.equal(got.body.ranges.length, shipped.ranges.length)
  console.log('GET bundled ok')
}

{
  const got = await call('/dsh-fenggu-time/holidays', 'POST')
  assert.equal(got.status, 405)
  console.log('method guard ok')
}

// Older or equal remote version must not overwrite anything.
const newer = {
  version: '2028.11.1',
  updated: '2027-11-05',
  ranges: [...shipped.ranges, ['2028-10-01', '2028-10-07']],
}
const stubbed = (body, status = 200) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status })
}

stubbed(newer)
{
  const got = await call('/dsh-fenggu-time/holidays/check', 'POST')
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.updated, true)
  assert.equal(got.body.version, '2028.11.1')
  assert.ok(fs.existsSync(sidecarPath()), 'sidecar not written')
  console.log('check: newer table stored')
}

{
  const got = await call('/dsh-fenggu-time/holidays', 'GET')
  assert.equal(got.body.version, '2028.11.1')
  assert.equal(got.body.origin, 'updated')
  console.log('GET reflects the update')
}

{
  const got = await call('/dsh-fenggu-time/holidays/check', 'POST')
  assert.equal(got.body.updated, false, 'same version must not re-download')
  console.log('check: same version is a no-op')
}

stubbed(newer, 500)
{
  const got = await call('/dsh-fenggu-time/holidays/check', 'POST')
  assert.equal(got.status, 502)
  assert.equal(got.body.ok, false)
  console.log('check: upstream failure reported')
}

{
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  const got = await call('/dsh-fenggu-time/holidays/check', 'POST')
  assert.equal(got.status, 502)
  console.log('check: network error reported')
}

// A sidecar written by a later run must win over the bundled copy.
{
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'fenggu-time-'))
  process.env.DSH_HOME = fresh
  fs.mkdirSync(path.join(fresh, 'plugin-state'), { recursive: true })
  fs.writeFileSync(
    path.join(fresh, 'plugin-state', 'fenggu-time-holidays.json'),
    JSON.stringify({ version: '2029.1.1', ranges: [['2029-01-01', '2029-01-02']] }),
  )
  const secondRoutes = new Map()
  apply({
    get: () => undefined,
    inject: (deps, callback) => callback({ webServer: server(secondRoutes) }),
  })
  const res = { writeHead() {}, end: (payload) => (res.payload = payload) }
  await secondRoutes.get('/dsh-fenggu-time/holidays')({ method: 'GET' }, res)
  assert.equal(JSON.parse(res.payload).version, '2029.1.1')
  assert.equal(JSON.parse(res.payload).origin, 'updated')
  fs.rmSync(fresh, { recursive: true, force: true })
  console.log('sidecar overrides bundled after restart')
}

// A surface without a web server must still mount: the badge is client-side.
{
  assert.doesNotThrow(() =>
    apply({ get: () => undefined, inject: (deps, callback) => callback({}) }),
  )
  console.log('mounts without a web server')
}
fs.rmSync(tempHome, { recursive: true, force: true })
console.log('host ok')


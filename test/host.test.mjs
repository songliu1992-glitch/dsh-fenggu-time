// Host-half tests: holiday document validation, version ordering, the annual
// check schedule, and the update path (fetch → validate → store → re-arm input).
//
// Order matters: the sidecar is written before the module state is first read, so
// the "survives a restart" case is exercised against the real disk path.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dataPath = fileURLToPath(new URL('../data/holidays.json', import.meta.url))
const shipped = JSON.parse(fs.readFileSync(dataPath, 'utf8'))

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fenggu-time-'))
process.env.DSH_HOME = tempHome
const sidecar = path.join(tempHome, 'plugin-state', 'fenggu-time-holidays.json')
fs.mkdirSync(path.dirname(sidecar), { recursive: true })

const host = await import('../lib/index.js')
const {
  parseHolidayDoc,
  compareVersion,
  sidecarPath,
  nextCheckAt,
  lastDueAt,
  checkForUpdate,
  apply,
} = host

assert.equal(sidecarPath(), sidecar)
console.log('sidecar path ok')

// ---- validation ----------------------------------------------------------
const ok = parseHolidayDoc(shipped, 'bundled')
assert.equal(ok.version, shipped.version)
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
console.log('version ordering ok')

// ---- annual check schedule ----------------------------------------------
const beijingNoon = (y) => Date.UTC(y, 11, 31, 4, 0, 0) // 12:00 Beijing == 04:00 UTC

// The first run is pinned to the end of 2027: the 2026/2027 tables already ship,
// and the 2028 arrangement is the first one nobody knows yet.
assert.equal(host.FIRST_CHECK_AT, beijingNoon(2027))
assert.equal(nextCheckAt(Date.UTC(2026, 10, 14, 8, 0, 0)), beijingNoon(2027))
// One second before the 2027 instant it is still the next one.
assert.equal(nextCheckAt(beijingNoon(2027) - 1000), beijingNoon(2027))
// At the instant itself the following year is armed — and so on, forever.
assert.equal(nextCheckAt(beijingNoon(2027)), beijingNoon(2028))
assert.equal(nextCheckAt(beijingNoon(2028) + 1), beijingNoon(2029))
console.log('nextCheckAt ok: 2027 -> 2028 -> 2029 chain')

// Before the first run nothing is due, so a fresh install must not check early.
assert.equal(lastDueAt(Date.UTC(2026, 10, 14, 8, 0, 0)), beijingNoon(2027))
assert.equal(lastDueAt(beijingNoon(2027) - 1000), beijingNoon(2027))
assert.equal(lastDueAt(beijingNoon(2027) + 1000), beijingNoon(2027))
assert.equal(lastDueAt(Date.UTC(2028, 5, 1, 0, 0, 0)), beijingNoon(2027))
assert.equal(lastDueAt(beijingNoon(2029) + 1000), beijingNoon(2029))
console.log('lastDueAt ok: catch-up anchor never precedes the first run')

// ---- a sidecar on disk wins over the bundled table (restart case) --------
fs.writeFileSync(
  sidecar,
  JSON.stringify({ version: '2029.1.1', ranges: [['2029-01-01', '2029-01-02']], lastCheckAt: 1 }),
)

const routes = new Map()
const server = { register: (route) => routes.set(route.path, route.handler) }
apply({ get: (service) => (service === 'webServer' ? server : undefined) })
assert.ok(routes.has('/dsh-fenggu-time/holidays'), 'GET route missing')
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
  assert.equal(got.body.version, '2029.1.1', 'sidecar must win over the bundled table')
  assert.equal(got.body.origin, 'updated')
  assert.equal(got.body.lastCheckAt, 1)
  assert.equal(typeof got.body.nextCheckAt, 'number')
  assert.ok(got.body.nextCheckAt > Date.now(), 'nextCheckAt must be in the future')
  console.log('sidecar overrides bundled; nextCheckAt exposed')
}

{
  const got = await call('/dsh-fenggu-time/holidays', 'POST')
  assert.equal(got.status, 405)
  console.log('method guard ok')
}

// ---- update path ---------------------------------------------------------
const newer = {
  version: '2030.11.1',
  updated: '2029-11-05',
  ranges: [...shipped.ranges, ['2030-10-01', '2030-10-07']],
}
const stubFetch = (body, status = 200) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status })
}

stubFetch(newer)
{
  const result = await checkForUpdate()
  assert.equal(result.ok, true)
  assert.equal(result.updated, true)
  assert.equal(result.version, '2030.11.1')
  const stored = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  assert.equal(stored.version, '2030.11.1')
  assert.ok(typeof stored.lastCheckAt === 'number' && stored.lastCheckAt > 1, 'lastCheckAt must be recorded')
  console.log('check: newer table stored with lastCheckAt')
}

{
  const got = await call('/dsh-fenggu-time/holidays', 'GET')
  assert.equal(got.body.version, '2030.11.1')
  console.log('GET reflects the update')
}

stubFetch(newer)
{
  const result = await checkForUpdate()
  assert.equal(result.updated, false, 'same version must not re-download')
  const stored = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
  assert.equal(stored.version, '2030.11.1', 'the table in force is untouched')
  console.log('check: same version is a no-op but records the run')
}

stubFetch(newer, 500)
{
  const result = await checkForUpdate()
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 500/)
  console.log('check: upstream failure reported')
}

{
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  const result = await checkForUpdate()
  assert.equal(result.ok, false)
  console.log('check: network error reported')
}

// A surface without a web server must still mount: the badge is client-side.
{
  assert.doesNotThrow(() =>
    apply({ get: () => undefined }),
  )
  console.log('mounts without a web server')
}

fs.rmSync(tempHome, { recursive: true, force: true })
console.log('host ok')


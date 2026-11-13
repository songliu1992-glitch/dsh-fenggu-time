// Client-half tests: classification, alarm scheduling, and the invariant that
// the inline holiday fallback matches data/holidays.json.
//
// Loads the shipped browser bundle with a stubbed module loader, so the test
// exercises exactly what the page runs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const dataPath = fileURLToPath(new URL('../data/holidays.json', import.meta.url))

let captured
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      captured = spec
    },
    addEventListener() {},
    removeEventListener() {},
  },
}
globalThis.document = { addEventListener() {}, removeEventListener() {} }

await import('file:///' + bundlePath)
assert.ok(captured, 'bundle did not call __ModuleLoader__.load')
assert.equal(captured.id, 'dsh-fenggu-time')

const fakeReact = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  createElement: () => null,
}
const mod = captured.factory((name) => {
  if (name === 'react') return fakeReact
  if (name === 'react-dom') return { createPortal: (node) => node }
  throw new Error('unexpected require: ' + name)
})

assert.deepEqual(mod.inject, ['slots'])
assert.equal(typeof mod.apply, 'function')
const classify = mod.classify
const nextChangeAt = mod.nextChangeAt
assert.equal(typeof classify, 'function', 'classify export missing')
assert.equal(typeof nextChangeAt, 'function', 'nextChangeAt export missing')

// ---- the inline fallback must equal the shipped data file -----------------
{
  const shipped = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
  assert.equal(mod.bundledVersion, shipped.version, 'inline version drifted from data/holidays.json')
  assert.deepEqual(mod.holidayRanges, shipped.ranges, 'inline ranges drifted from data/holidays.json')
  let days = 0
  for (const [from, to] of shipped.ranges) {
    const span = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000
    assert.ok(span >= 0 && span < 31, `${from}..${to} is not a sane holiday range`)
    days += span + 1
  }
  console.log(`bundled data ok: v${shipped.version}, ${shipped.ranges.length} ranges, ${days} days`)
}

// Beijing time -> UTC instant (Beijing = UTC+8).
const bj = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0))

const cases = [
  ['周二 09:00 高峰起点', bj(2026, 11, 10, 9, 0), '梁文峰时间'],
  ['周二 08:59 未到高峰', bj(2026, 11, 10, 8, 59), '梁文谷时间'],
  ['周二 11:59 仍高峰', bj(2026, 11, 10, 11, 59), '梁文峰时间'],
  ['周二 12:00 午休', bj(2026, 11, 10, 12, 0), '梁文谷时间'],
  ['周二 13:59 午休', bj(2026, 11, 10, 13, 59), '梁文谷时间'],
  ['周二 14:00 下午高峰起点', bj(2026, 11, 10, 14, 0), '梁文峰时间'],
  ['周二 17:59 仍高峰', bj(2026, 11, 10, 17, 59), '梁文峰时间'],
  ['周二 18:00 下班', bj(2026, 11, 10, 18, 0), '梁文谷时间'],
  ['周二 22:30 夜间', bj(2026, 11, 10, 22, 30), '梁文谷时间'],
  ['周六 10:00 周末', bj(2026, 11, 14, 10, 0), '梁文谷时间'],
  ['周日 10:00 周末', bj(2026, 11, 15, 10, 0), '梁文谷时间'],
  ['2026 国庆 10-01 周四 10:00', bj(2026, 10, 1, 10, 0), '梁文谷时间'],
  ['2026 春节 02-18 周三 10:00', bj(2026, 2, 18, 10, 0), '梁文谷时间'],
  ['2026 春节 02-23 周一 10:00 末日', bj(2026, 2, 23, 10, 0), '梁文谷时间'],
  ['2026 春节 02-24 周二 10:00 已上班', bj(2026, 2, 24, 10, 0), '梁文峰时间'],
  ['2027 春节 02-05 周五 10:00', bj(2027, 2, 5, 10, 0), '梁文谷时间'],
  ['2027 端午 06-09 周三 10:00', bj(2027, 6, 9, 10, 0), '梁文谷时间'],
  ['2027 中秋 09-15 周三 10:00', bj(2027, 9, 15, 10, 0), '梁文谷时间'],
  ['2027 元旦 01-02 周六 10:00', bj(2027, 1, 2, 10, 0), '梁文谷时间'],
  ['2027 春节 02-14 周日 10:00', bj(2027, 2, 14, 10, 0), '梁文谷时间'],
  ['2028 无节假日表 周三 10:00 回落为高峰', bj(2028, 3, 1, 10, 0), '梁文峰时间'],
  ['2026 调休上班日 10-10 周六 10:00 按规则算周末', bj(2026, 10, 10, 10, 0), '梁文谷时间'],
]

let failed = 0
for (const [label, instant, expected] of cases) {
  const got = classify(instant)
  const ok = got.label === expected
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} -> ${got.label}`)
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
assert.equal(failed, 0)

// ---- colours -------------------------------------------------------------
assert.equal(classify(bj(2026, 11, 10, 10, 0)).color, '#ffd60a', 'peak must be bright yellow')
assert.equal(classify(bj(2026, 11, 10, 22, 0)).color, '#55ff55', 'idle must be light green')
console.log('colours ok: peak #ffd60a / idle #55ff55')

// ---- alarm scheduling ----------------------------------------------------
const scheduleCases = [
  ['周二 08:00 → 09:00 上班', bj(2026, 11, 10, 8, 0), bj(2026, 11, 10, 9, 0)],
  ['周二 10:00 → 12:00 午休', bj(2026, 11, 10, 10, 0), bj(2026, 11, 10, 12, 0)],
  ['周二 12:30 → 14:00 下午班', bj(2026, 11, 10, 12, 30), bj(2026, 11, 10, 14, 0)],
  ['周二 15:00 → 18:00 下班', bj(2026, 11, 10, 15, 0), bj(2026, 11, 10, 18, 0)],
  ['周二 19:00 → 周三 09:00', bj(2026, 11, 10, 19, 0), bj(2026, 11, 11, 9, 0)],
  ['周五 19:00 → 周一 09:00', bj(2026, 11, 13, 19, 0), bj(2026, 11, 16, 9, 0)],
  ['国庆 10-02 10:00 → 10-08 09:00', bj(2026, 10, 2, 10, 0), bj(2026, 10, 8, 9, 0)],
  ['正好在 09:00 边界 → 12:00', bj(2026, 11, 10, 9, 0), bj(2026, 11, 10, 12, 0)],
]
let schedFailed = 0
for (const [label, from, expected] of scheduleCases) {
  const got = nextChangeAt(from.getTime())
  const ok = got === expected.getTime()
  if (!ok) schedFailed++
  const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(30)} -> ${fmt(got)}  (期望 ${fmt(expected.getTime())})`)
}
assert.equal(schedFailed, 0, `${schedFailed} scheduling case(s) failed`)

for (const [, from] of scheduleCases) {
  const at = nextChangeAt(from.getTime())
  assert.notEqual(classify(new Date(at - 1)).peak, classify(new Date(at)).peak, 'wake-up must flip the label')
}
console.log('client ok')

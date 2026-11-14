// dsh-fenggu-time — host half.
//
// Owns the China public-holiday table and the yearly update check. The badge and
// the read-only Settings row live in the client half; they read the table from
// GET /dsh-fenggu-time/holidays.
//
// Update check: once a year, on 31 December at 12:00 Beijing time. The first run
// is 2027-12-31 (the 2026 and 2027 arrangements already ship in data/holidays.json;
// 2028 is the first one nobody knows yet). After each run the next occurrence is
// armed again, so there is nothing to configure and nothing to press.
//
// Table resolution order: the sidecar written by a check, else the bundled copy.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'fenggu-time'

const BUNDLED_FILE = new URL('../data/holidays.json', import.meta.url)
const DEFAULT_SOURCE =
  process.env.DSH_FENGGU_TIME_HOLIDAY_SOURCE ??
  'https://cdn.jsdelivr.net/npm/dsh-fenggu-time/data/holidays.json'
const FETCH_TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_RANGES = 2000
const MAX_RANGE_DAYS = 60

const VERSION_RE = /^\d{4}\.\d{1,2}\.\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Beijing is UTC+8 all year; a fixed offset turns wall-clock time into instants. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
/** setTimeout overflows past 2^31-1 ms (~24.8 days), so long waits are chained. */
const MAX_TIMEOUT_MS = 20 * 24 * 60 * 60 * 1000
/** Give the host a moment to finish booting before the catch-up check hits the network. */
const CATCH_UP_DELAY_MS = 15000

/** Absolute path of the update sidecar. Kept outside node_modules so it survives reinstalls. */
export function sidecarPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugin-state', 'fenggu-time-holidays.json')
}

/** Compare `YYYY.M.D` versions numerically. Positive when `a` is newer than `b`. */
export function compareVersion(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** Beijing calendar year of an instant. */
function beijingYear(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).getUTCFullYear()
}

/** Instant of 31 December 12:00 Beijing time for a Beijing calendar year. */
function checkInstantForYear(year) {
  // 12:00 Beijing == 04:00 UTC on the same date.
  return Date.UTC(year, 11, 31, 4, 0, 0)
}

/**
 * The first run is the end of 2027 on purpose: the 2026 and 2027 arrangements
 * already ship, and the 2028 one is the first that nobody knows yet (it is
 * published around November 2027). Checking at the end of 2026 would only fetch
 * data the package already contains.
 */
export const FIRST_CHECK_AT = checkInstantForYear(2027)

/** The next annual check instant strictly after `from`, never before the first run. */
export function nextCheckAt(from) {
  const candidate = checkInstantForYear(beijingYear(from))
  const next = candidate > from ? candidate : checkInstantForYear(beijingYear(from) + 1)
  return next < FIRST_CHECK_AT ? FIRST_CHECK_AT : next
}

/** The most recent annual check instant at or before `from`, never before the first run. */
export function lastDueAt(from) {
  if (from < FIRST_CHECK_AT) return FIRST_CHECK_AT
  const candidate = checkInstantForYear(beijingYear(from))
  const last = candidate <= from ? candidate : checkInstantForYear(beijingYear(from) - 1)
  return last < FIRST_CHECK_AT ? FIRST_CHECK_AT : last
}

function isRealDate(text) {
  const parsed = Date.parse(text + 'T00:00:00Z')
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text
}

/**
 * Validate a holiday document and return a detached copy.
 * @throws Error naming the first violated rule.
 */
export function parseHolidayDoc(value, origin) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('holiday document must be a JSON object')
  }
  if (typeof value.version !== 'string' || !VERSION_RE.test(value.version)) {
    throw new Error('holiday document needs a "version" like 2026.11.1')
  }
  if (value.updated !== undefined && (typeof value.updated !== 'string' || !DATE_RE.test(value.updated))) {
    throw new Error('"updated" must be a YYYY-MM-DD string')
  }
  if (!Array.isArray(value.ranges) || value.ranges.length === 0) {
    throw new Error('"ranges" must be a non-empty array of [from, to] pairs')
  }
  if (value.ranges.length > MAX_RANGES) {
    throw new Error(`"ranges" has more than ${MAX_RANGES} entries`)
  }
  const ranges = value.ranges.map((range, index) => {
    if (!Array.isArray(range) || range.length !== 2) {
      throw new Error(`ranges[${index}] must be a [from, to] pair`)
    }
    const [from, to] = range
    if (typeof from !== 'string' || typeof to !== 'string' || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new Error(`ranges[${index}] must use YYYY-MM-DD dates`)
    }
    if (!isRealDate(from) || !isRealDate(to)) {
      throw new Error(`ranges[${index}] is not a real calendar date`)
    }
    if (from > to) {
      throw new Error(`ranges[${index}] ends before it starts`)
    }
    if ((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000 > MAX_RANGE_DAYS) {
      throw new Error(`ranges[${index}] spans more than ${MAX_RANGE_DAYS} days`)
    }
    return [from, to]
  })
  return { version: value.version, updated: value.updated, ranges, origin }
}

function readBundled() {
  return parseHolidayDoc(JSON.parse(readFileSync(BUNDLED_FILE, 'utf8')), 'bundled')
}

function readSidecar() {
  const path = sidecarPath()
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    const doc = parseHolidayDoc(parsed, 'updated')
    doc.lastCheckAt = typeof parsed.lastCheckAt === 'number' ? parsed.lastCheckAt : 0
    return doc
  } catch (error) {
    console.warn('[fenggu-time] ignoring unreadable holiday sidecar:', error && error.message)
    return undefined
  }
}

function writeSidecar(doc, lastCheckAt) {
  const path = sidecarPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(
    tmp,
    JSON.stringify(
      { version: doc.version, updated: doc.updated, ranges: doc.ranges, lastCheckAt },
      null,
      2,
    ) + '\n',
  )
  renameSync(tmp, path)
}

async function fetchRemote() {
  const response = await fetch(DEFAULT_SOURCE, {
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`update source answered HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error('update source body is too large')
  }
  const body = await response.text()
  if (body.length > MAX_BODY_BYTES) throw new Error('update source body is too large')
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('update source did not return JSON')
  }
  return parseHolidayDoc(parsed, 'updated')
}

// ---- module state -------------------------------------------------------
let active
let activeLoaded = false

function activeTable() {
  if (!activeLoaded) {
    try {
      active = readSidecar() ?? readBundled()
    } catch (error) {
      console.error('[fenggu-time] holiday table unavailable:', error && error.message)
      active = { version: '0.0.0', updated: undefined, ranges: [], origin: 'missing', lastCheckAt: 0 }
    }
    activeLoaded = true
  }
  return active
}

/** Replace the table in force (used by the check and by tests). */
export function setActiveTable(doc, lastCheckAt) {
  active = {
    version: doc.version,
    updated: doc.updated,
    ranges: doc.ranges,
    origin: doc.origin ?? 'updated',
    lastCheckAt: lastCheckAt ?? 0,
  }
  activeLoaded = true
}

/**
 * Fetch the newest table and store it when it is newer than the one in force.
 * Always records `lastCheckAt`, so a check that finds nothing new is not repeated
 * on the next boot.
 * @returns {{ ok: boolean, updated: boolean, version: string, error?: string }}
 */
export async function checkForUpdate() {
  const current = activeTable()
  const now = Date.now()
  let remote
  try {
    remote = await fetchRemote()
  } catch (error) {
    return {
      ok: false,
      updated: false,
      version: current.version,
      error: error && error.message ? error.message : 'update check failed',
    }
  }
  if (compareVersion(remote.version, current.version) <= 0) {
    try {
      writeSidecar(current, now)
    } catch (error) {
      console.warn('[fenggu-time] could not record the check:', error && error.message)
    }
    setActiveTable(current, now)
    return { ok: true, updated: false, version: current.version }
  }
  try {
    writeSidecar(remote, now)
  } catch (error) {
    return {
      ok: false,
      updated: false,
      version: current.version,
      error: 'could not store the downloaded table: ' + (error && error.message),
    }
  }
  setActiveTable(remote, now)
  return { ok: true, updated: true, version: remote.version }
}

export function apply(ctx) {
  const table = activeTable()

  // ---- annual check: 31 December 12:00 Beijing, then re-armed -----------
  let timer
  const schedule = () => {
    const now = Date.now()
    const target = nextCheckAt(now)
    const hop = Math.min(Math.max(target - now, 1000), MAX_TIMEOUT_MS)
    timer = setTimeout(() => {
      if (Date.now() + 1000 >= target) {
        checkForUpdate()
          .catch((error) => console.error('[fenggu-time] yearly check failed:', error))
          .finally(schedule)
        return
      }
      schedule()
    }, hop)
    timer.unref?.()
  }
  schedule()

  // A machine that was off at New Year still catches up on the next start — but
  // never before the first run is due.
  const due = lastDueAt(Date.now())
  if (due <= Date.now() && (table.lastCheckAt ?? 0) < due) {
    const late = setTimeout(() => {
      checkForUpdate().catch((error) => console.error('[fenggu-time] catch-up check failed:', error))
    }, CATCH_UP_DELAY_MS)
    late.unref?.()
  }

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.warn('[fenggu-time] no webServer service; the badge falls back to the bundled table')
    return
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  try {
    webServer.register({
      kind: 'exact',
      path: '/dsh-fenggu-time/holidays',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          send(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const current = activeTable()
        send(res, 200, {
          version: current.version,
          updated: current.updated,
          ranges: current.ranges,
          origin: current.origin,
          lastCheckAt: current.lastCheckAt ?? 0,
          nextCheckAt: nextCheckAt(Date.now()),
        })
      },
    })
  } catch (error) {
    console.error('[fenggu-time] /dsh-fenggu-time/holidays registration failed:', error && error.message)
  }
}

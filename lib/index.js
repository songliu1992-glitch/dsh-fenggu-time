// dsh-fenggu-time — host half.
//
// Owns the China statutory-holiday table and the "check for holiday updates"
// operation. The badge and the Settings row live in the client half; they read
// the table from GET /dsh-fenggu-time/holidays, so a data update reaches the
// badge without reinstalling the plugin.
//
// Table resolution order: the sidecar written by a successful update check,
// else the `data/holidays.json` shipped in this package.
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

function isRealDate(text) {
  const parsed = Date.parse(text + 'T00:00:00Z')
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text
}

/**
 * Validate a holiday document and return a detached copy.
 * @throws Error naming the first violated rule — the message reaches the Settings row.
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
  const raw = readFileSync(BUNDLED_FILE, 'utf8')
  return parseHolidayDoc(JSON.parse(raw), 'bundled')
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
    return parseHolidayDoc(JSON.parse(raw), 'updated')
  } catch (error) {
    console.warn('[fenggu-time] ignoring unreadable holiday sidecar:', error && error.message)
    return undefined
  }
}

function writeSidecar(doc) {
  const path = sidecarPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify({ version: doc.version, updated: doc.updated, ranges: doc.ranges }, null, 2) + '\n')
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

export function apply(ctx) {
  let active
  try {
    active = readSidecar() ?? readBundled()
  } catch (error) {
    console.error('[fenggu-time] holiday table unavailable:', error && error.message)
    active = { version: '0.0.0', ranges: [], origin: 'missing' }
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const registerRoutes = (webServer) => {
    try {
      webServer.register({
        kind: 'exact',
        path: '/dsh-fenggu-time/holidays',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            send(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          send(res, 200, {
            version: active.version,
            updated: active.updated,
            ranges: active.ranges,
            origin: active.origin,
          })
        },
      })
    } catch (error) {
      console.error('[fenggu-time] /dsh-fenggu-time/holidays registration failed:', error && error.message)
    }

    try {
      webServer.register({
        kind: 'exact',
        path: '/dsh-fenggu-time/holidays/check',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          let remote
          try {
            remote = await fetchRemote()
          } catch (error) {
            send(res, 502, {
              ok: false,
              error: error && error.message ? error.message : 'update check failed',
              current: active.version,
              source: DEFAULT_SOURCE,
            })
            return
          }
          if (compareVersion(remote.version, active.version) <= 0) {
            send(res, 200, {
              ok: true,
              updated: false,
              version: active.version,
              remote: remote.version,
              origin: active.origin,
            })
            return
          }
          try {
            writeSidecar(remote)
          } catch (error) {
            send(res, 500, {
              ok: false,
              error: 'could not store the downloaded table: ' + (error && error.message),
              current: active.version,
            })
            return
          }
          active = remote
          send(res, 200, { ok: true, updated: true, version: active.version, origin: active.origin })
        },
      })
    } catch (error) {
      console.error('[fenggu-time] /dsh-fenggu-time/holidays/check registration failed:', error && error.message)
    }
  }

  // The badge must not depend on the HTTP surface, so the service is awaited
  // through an injection edge instead of `export const inject = ['webServer']`,
  // which would keep the whole plugin — badge included — unmounted on a surface
  // that has no web server.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const webServer = scope.webServer
      if (webServer === undefined) {
        console.warn('[fenggu-time] no webServer service; the update check is unavailable')
        return
      }
      registerRoutes(webServer)
    })
    return
  }
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.warn('[fenggu-time] no webServer service; the update check is unavailable')
    return
  }
  registerRoutes(webServer)
}

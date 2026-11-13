# dsh-fenggu-time

A DeepSeek Harness plugin that puts one small status badge in the window's titlebar:
**梁文峰时间** (peak) during Beijing office hours, **梁文谷时间** (off-peak) at every
other moment.

```
● 梁文峰时间    ← Beijing Mon–Fri, 09:00–12:00 / 14:00–18:00, not a statutory holiday   (yellow #ffd60a)
● 梁文谷时间    ← everything else: lunch, evenings, weekends, holidays                  (light green #55ff55)
```

The badge is a fixed 22px pill in the titlebar row, vertically centred on the window's
caption buttons and click-through (`pointer-events: none`). It stays in the same spot on
every page — conversation, Plugins, Settings — and is drawn above in-page overlays.

## Rules

All times are Beijing time (`Asia/Shanghai`), independent of the machine's timezone.

- **Peak** — Monday to Friday, not a statutory holiday, and the local time is in
  `[09:00, 12:00)` or `[14:00, 18:00)`. Shows 梁文峰时间 in yellow.
- **Off-peak** — every other moment, including the whole of every weekend and holiday.
  Shows 梁文谷时间 in light green.

Deliberate boundary decisions:

- `12:00` and `18:00` are off-peak; `09:00` and `14:00` are peak (left-closed, right-open).
- **Make-up workdays count as weekends.** A 调休 Saturday that the State Council turns
  into a workday still shows off-peak, because the rule above is written against
  weekdays. This matches the documented behaviour; say so in an issue if you want the
  opposite and it can become an option.
- A year with no holiday data behaves as if it had no holidays: weekday office hours are
  peak.

## Install

```sh
dsh plugin add dsh-fenggu-time
```

Or in the app: **Plugins → Discover**, install from an index source that lists this
package, then restart DSH.

The badge appears on the next launch. No other setup, no network use at runtime.

## Holiday data and the update check

China's holiday arrangement is published every November for the following year, so a
plugin that hard-codes holidays goes stale. This one therefore:

1. ships a bundled table (`data/holidays.json`, currently 2026 + 2027), and
2. exposes **Settings → General → 节假日数据 → 检查节假日更新**, which fetches the latest
   table by fetching `data/holidays.json` from the published npm package (served through
   jsDelivr) and, when its `version` is newer, stores it outside `node_modules` so it
   survives reinstalls and plugin upgrades.

```sh
# the stored table, if you ever need to inspect or clear it
~/.dsh/plugin-state/fenggu-time-holidays.json     # Windows: %USERPROFILE%\.dsh\plugin-state\...
```

Deleting that file falls back to the bundled table. The update check is the only network
call this plugin makes, and only when you press the button.

Sources for the shipped dates (逐字核对，非二手转述):

- 2026 — [国办发明电〔2025〕7号](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)
- 2027 — [国办发明电〔2026〕10号](https://www.gov.cn/zhengce/content/202611/content_7085101.htm)

## What it costs

One badge, one alarm. The label can only change at 00:00, 09:00, 12:00, 14:00 and 18:00
Beijing time, so instead of polling every N seconds the plugin computes the next instant
the label flips and sleeps until then (`setTimeout`), then re-arms. Roughly five wake-ups
per day; zero in between. Window focus and `visibilitychange` re-read the clock and
re-arm, so a sleep or a stalled renderer cannot strand it on a stale label.

## Compatibility

Tested against DSH `0.2.2-rc.1` (desktop, Windows). The package deliberately declares **no**
`engines.dsh`: DSH ships release candidates, and semver excludes prereleases from ordinary
ranges, so any range that excludes `0.2.2-rc.1` would get the plugin row silently disabled
by the compatibility preflight — a failure mode that shows up as a missing badge rather
than an error.

The badge uses two internal client slots (`shell.overlay`, and the settings row slot
`settings.general.item`). They are not a compatibility contract. If a future DSH renames
them, the badge and the settings row disappear; the plugin fails closed and logs to the
client console instead of breaking the page.

## Development

Plain JavaScript, no build step: `lib/client.js` is the browser bundle the DSH client loads
(`window.__ModuleLoader__.load({ id, factory })`), `lib/index.js` is the host half (ESM,
node built-ins only).

```sh
npm test    # classification, alarm scheduling, holiday-document validation, both routes
```

The tests load the shipped bundle with a stubbed module loader and drive the host routes
through a fake `webServer`, so they exercise the artifact that ships rather than a copy.

## License

MIT

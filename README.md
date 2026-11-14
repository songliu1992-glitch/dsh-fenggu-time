# dsh-fenggu-time

A DeepSeek Harness plugin that puts a 22px badge in the window titlebar showing which
DeepSeek API pricing period is in force right now:

```
● 梁文峰时间    yellow #ffd60a    peak hours     — full price
● 梁文谷时间    green  #55ff55    off-peak hours — half the peak price
```

The two labels are a pun on the name 梁文峰: 峰 (peak) and 谷 (valley). Green means your
API calls are billed at the **off-peak rate, which is half of the peak rate** — the same
wording DeepSeek uses in its pricing documentation.

The badge is a passive indicator: fixed to the titlebar row, vertically centred on the
window's caption buttons, click-through, and identical on every page (conversation,
Plugins, Settings). Nothing pops up and nothing polls.

## The schedule

Straight from [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing):

> Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00
> UTC, Monday through Friday, excluding Chinese public holidays. All other hours are
> off-peak, including weekends and Chinese public holidays in full.

In Beijing time that is **09:00–12:00 and 14:00–18:00, Monday to Friday**, which is what the
badge evaluates. Both UTC windows fall inside the same Beijing calendar day, so the weekday
is unambiguous. In short:

| | When | Badge |
|---|---|---|
| Peak hours | Mon–Fri, not a Chinese public holiday, 09:00–12:00 / 14:00–18:00 Beijing | 梁文峰时间, yellow |
| Off-peak hours | everything else, including every weekend and Chinese public holidays in full | 梁文谷时间, green |

Chinese public holidays apply to every account worldwide, so the off-peak windows are the
same for users outside China — only the wall-clock time differs:

| Local time zone | Peak hours, local |
|---|---|
| Beijing (UTC+8) | 09:00–12:00, 14:00–18:00 |
| Tokyo (UTC+9) | 10:00–13:00, 15:00–19:00 |
| Sydney (UTC+11) | 12:00–15:00, 17:00–21:00 |
| Berlin / Paris (UTC+1) | 02:00–05:00, 07:00–11:00 |
| London (UTC+0) | 01:00–04:00, 06:00–10:00 |
| New York (UTC-5) | 20:00–23:00 (previous day), 01:00–05:00 |
| Los Angeles (UTC-8) | 17:00–20:00, 22:00–02:00 |

Boundaries are left-closed and right-open: 09:00 and 14:00 are peak, 12:00 and 18:00 are
off-peak. Two consequences worth stating plainly:

- **A 调休 make-up workday counts as off-peak.** A Saturday that the State Council turns
  into a workday is still a weekend by the rule above, and the pricing schedule is written
  against weekdays too.
- **A year with no holiday data behaves as if it had no holidays**: weekday peak hours are
  treated as peak.

## Install

```sh
dsh plugin add dsh-fenggu-time
```

Or in the app: **Plugins → Add plugin**, paste `dsh-fenggu-time`, choose the official npm
registry, install, then restart DSH.

## Holiday data and the update check

China publishes the next year's holiday arrangement every November, so a hard-coded table
goes stale. The plugin:

1. ships a table (`data/holidays.json`, currently 2026 + 2027), and
2. exposes **Settings → General → 节假日数据 → 检查节假日更新**, which fetches the newest
   table from the published package (jsDelivr) and, when its version is newer, stores it
   outside `node_modules` so it survives reinstalls.

```sh
~/.dsh/plugin-state/fenggu-time-holidays.json   # Windows: %USERPROFILE%\.dsh\plugin-state\...
```

Deleting that file falls back to the bundled table. This update check is the only network
call the plugin makes, and only when you press the button.

The shipped dates come from the State Council notices, transcribed per day:

- 2026 — 国办发明电〔2025〕7号 — <https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>
- 2027 — 国办发明电〔2026〕10号 — <https://www.gov.cn/zhengce/content/202611/content_7085101.htm>

**Limit worth knowing:** only the holiday table is updatable. The two daily peak windows
are constants in the code — if DeepSeek changes the schedule itself (it has before: the old
00:30–08:30 Beijing discount window was retired on 2025-09-06), the plugin needs a release.

## What it costs at runtime

One badge, one alarm. The label can only change at 00:00, 09:00, 12:00, 14:00 and 18:00
Beijing time, so the plugin computes the next instant the label flips and sleeps until then
(`setTimeout`), then re-arms. About five wake-ups per day, none in between. Window focus and
`visibilitychange` re-read the clock and re-arm, so a sleep or a stalled renderer cannot
leave it on a stale label.

## Compatibility

Tested against DSH `0.2.2-rc.3` (desktop, Windows). The package deliberately declares **no**
`engines.dsh`: DSH ships release candidates, semver excludes prereleases from ordinary
ranges, and a range that rejects the running rc would get the plugin row silently disabled
by the compatibility preflight — a failure that shows up as a missing badge, not an error.

The badge uses internal client slots (`shell.overlay`, `settings.general.item`). They are
not a compatibility contract; if a future DSH renames them the badge and the settings row
disappear, and the plugin fails closed instead of breaking the page.

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

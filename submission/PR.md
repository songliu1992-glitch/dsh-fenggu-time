## What

Adds `songliu1992-glitch/dsh-fenggu-time` — a 22px badge in the DSH window titlebar that
switches between two labels during Beijing office hours.

- **梁文峰时间** (yellow) — Mon–Fri, not a statutory holiday, 09:00–12:00 or 14:00–18:00
- **梁文谷时间** (light green) — every other moment: lunch, evenings, weekends, holidays

`package.json` declares `dsh.bundle` (`./cordis.patch.yml`) and `dsh.client`
(`platform: web`), so it installs like any other bundle.

## Why this is not a duplicate of `dsh-peak-reminder`

That entry covers the same peak/off-peak rule, including statutory holidays, so the
overlap is real. The differences:

|  | `dsh-peak-reminder` | this one |
|---|---|---|
| Presentation | banner at the top of the page every N minutes, plus a sidebar line | a passive badge in the window titlebar; **nothing pops up, ever** |
| Position | page top | titlebar, on the same row as the caption buttons |
| Data maintenance | no documented update path | **Settings → 通用 → 节假日数据 → 检查节假日更新** fetches a newer table from the published package (jsDelivr) and stores it outside `node_modules` |
| Holiday provenance | not listed | the State Council document numbers and gov.cn links are in `data/holidays.json` and the README |

It is a display, not a reminder: one alarm is scheduled at the next boundary (00:00, 09:00,
12:00, 14:00, 18:00 Beijing) and nothing runs in between. Roughly five wake-ups per day.

## Holiday data

Transcribed per day from the State Council notices:

- 2026 — 国办发明电〔2025〕7号 — <https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>
- 2027 — 国办发明电〔2026〕10号 — <https://www.gov.cn/zhengce/content/202611/content_7085101.htm>

Every November publishes the next year's arrangement, which is why the plugin ships an
in-app update check instead of pretending a hard-coded table stays correct.

Deliberate rule decisions, documented in the README:

- boundaries are left-closed/right-open: 09:00 and 14:00 are peak, 12:00 and 18:00 are off-peak
- a 调休 make-up workday still counts as off-peak, because the rule is written against weekdays
- a year without data behaves as if it had no holidays

## Checks

- `npm test`: classification (22 cases), alarm scheduling (8 cases, including a weekend and
  the National Day week), holiday-document validation (9 rejection cases), both HTTP routes,
  sidecar override after restart, and mounting on a surface without a web server
- `npm pack --dry-run`: 8 files, 12.9 kB
- Published as `dsh-fenggu-time@0.1.0`; the update source returns 200 on jsDelivr

Repo is public and carries the `dsh-plugin` topic.

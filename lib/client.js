window.__ModuleLoader__.load({
  id: "dsh-fenggu-time",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const reactDom = require("react-dom");

    // ---------------------------------------------------------------------
    // Holiday table
    //
    // The host half serves the authoritative table (bundled copy, or a newer
    // one written by the Settings update check). This inline copy is the
    // offline fallback: it must stay identical to data/holidays.json, which a
    // test enforces.
    // ---------------------------------------------------------------------
    const BUNDLED_VERSION = "2026.11.1";
    const BUNDLED_RANGES = [
      ["2026-01-01", "2026-01-03"], // 元旦
      ["2026-02-15", "2026-02-23"], // 春节
      ["2026-04-04", "2026-04-06"], // 清明
      ["2026-05-01", "2026-05-05"], // 劳动节
      ["2026-06-19", "2026-06-21"], // 端午
      ["2026-09-25", "2026-09-27"], // 中秋
      ["2026-10-01", "2026-10-07"], // 国庆
      ["2027-01-01", "2027-01-03"], // 元旦
      ["2027-02-05", "2027-02-13"], // 春节
      ["2027-04-03", "2027-04-05"], // 清明
      ["2027-05-01", "2027-05-05"], // 劳动节
      ["2027-06-09", "2027-06-09"], // 端午
      ["2027-09-15", "2027-09-15"], // 中秋
      ["2027-10-01", "2027-10-07"], // 国庆
    ];

    const DAY = 86400000;

    function daysOf(ranges) {
      const days = new Set();
      for (const pair of ranges) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const end = Date.parse(pair[1] + "T00:00:00Z");
        for (let t = Date.parse(pair[0] + "T00:00:00Z"); t <= end; t += DAY) {
          days.add(new Date(t).toISOString().slice(0, 10));
        }
      }
      return days;
    }

    // ---- table store (shared by the badge and the Settings row) -----------
    const table = {
      version: BUNDLED_VERSION,
      updated: null,
      origin: "bundled",
      days: daysOf(BUNDLED_RANGES),
      listeners: new Set(),
    };

    function tableSnapshot() {
      return { version: table.version, updated: table.updated, origin: table.origin };
    }

    function publishToTable(doc) {
      if (doc === null || typeof doc !== "object" || !Array.isArray(doc.ranges)) return false;
      if (typeof doc.version !== "string") return false;
      table.version = doc.version;
      table.updated = typeof doc.updated === "string" ? doc.updated : null;
      table.origin = doc.origin === "updated" ? "updated" : "bundled";
      table.days = daysOf(doc.ranges);
      for (const listener of [...table.listeners]) {
        try {
          listener();
        } catch (error) {
          console.error("[dsh-fenggu-time] table listener failed:", error);
        }
      }
      return true;
    }

    function subscribeTable(listener) {
      table.listeners.add(listener);
      return () => table.listeners.delete(listener);
    }

    let refreshInFlight = null;
    function refreshTable() {
      if (refreshInFlight !== null) return refreshInFlight;
      refreshInFlight = fetch("/dsh-fenggu-time/holidays")
        .then((response) => (response.ok ? response.json() : null))
        .then((doc) => {
          publishToTable(doc);
        })
        .catch(() => {
          // No host route (plugin not mounted, or a page without the host):
          // the bundled table stays in force.
        })
        .then(() => {
          refreshInFlight = null;
        });
      return refreshInFlight;
    }

    function useHolidayTable() {
      const [snapshot, setSnapshot] = React.useState(tableSnapshot);
      React.useEffect(() => {
        const off = subscribeTable(() => setSnapshot(tableSnapshot()));
        refreshTable();
        return off;
      }, []);
      return snapshot;
    }

    // ---------------------------------------------------------------------
    // Peak/off-peak classification, in Beijing time.
    // Peak = Mon-Fri, not a statutory holiday, 09:00-12:00 or 14:00-18:00.
    // Everything else (weekends, holidays, evenings) is off-peak.
    // ---------------------------------------------------------------------
    const BEIJING = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });

    const PEAK_TEXT = "梁文峰时间";
    const IDLE_TEXT = "梁文谷时间";
    const YELLOW = "#ffd60a";
    const GREEN = "#55ff55";

    function readBeijing(date) {
      const parts = BEIJING.formatToParts(date);
      const read = (type) => {
        const hit = parts.find((part) => part.type === type);
        return hit === undefined ? "" : hit.value;
      };
      return {
        date: read("year") + "-" + read("month") + "-" + read("day"),
        weekday: read("weekday"),
        minutes: Number(read("hour")) * 60 + Number(read("minute")),
      };
    }

    /** @returns {{ label: string, peak: boolean, color: string }} */
    function classify(date) {
      let now;
      try {
        now = readBeijing(date);
      } catch (error) {
        return { label: IDLE_TEXT, peak: false, color: GREEN };
      }
      const weekend = now.weekday === "Sat" || now.weekday === "Sun";
      const holiday = table.days.has(now.date);
      const officeHour =
        (now.minutes >= 9 * 60 && now.minutes < 12 * 60) ||
        (now.minutes >= 14 * 60 && now.minutes < 18 * 60);
      const peak = !weekend && !holiday && officeHour;
      return { label: peak ? PEAK_TEXT : IDLE_TEXT, peak: peak, color: peak ? YELLOW : GREEN };
    }

    // ---- scheduling ------------------------------------------------------
    // The label can only change at five instants of a Beijing day: 00:00 (the
    // date, so weekend/holiday) and the four office-hour edges. Sleep until the
    // next one instead of re-reading the clock on a timer.
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
    const BOUNDARY_MINUTES = [0, 9 * 60, 12 * 60, 14 * 60, 18 * 60];
    const FALLBACK_DELAY_MS = 6 * 60 * 60 * 1000;
    const MAX_LOOKAHEAD_MS = 8 * DAY;

    /** First instant after `from` at which the peak flag flips, or a fallback re-check. */
    function nextChangeAt(from) {
      const peak = classify(new Date(from)).peak;
      // Beijing has no DST, so a fixed offset turns wall-clock minutes into instants.
      const dayStart = Math.floor((from + BEIJING_OFFSET_MS) / DAY) * DAY - BEIJING_OFFSET_MS;
      for (let day = 0; day <= 8; day++) {
        for (const minutes of BOUNDARY_MINUTES) {
          const at = dayStart + day * DAY + minutes * 60000;
          if (at <= from) continue;
          if (at - from > MAX_LOOKAHEAD_MS) return from + FALLBACK_DELAY_MS;
          if (classify(new Date(at)).peak !== peak) return at;
        }
      }
      return from + FALLBACK_DELAY_MS;
    }

    // ---------------------------------------------------------------------
    // Geometry. The badge sits in the Windows titlebar row, centred on the
    // caption buttons rather than on the bar: those are 32px tall and begin at
    // the window's top edge, while the 40px overlay only reserves the drag area.
    // ---------------------------------------------------------------------
    const BADGE_HEIGHT = 22;
    const CAPTION_BUTTON_HEIGHT = 32;
    const BADGE_TOP =
      "calc(min(var(--dsh-windows-titlebar-height, 40px), " +
      CAPTION_BUTTON_HEIGHT +
      "px) / 2 - " +
      BADGE_HEIGHT / 2 +
      "px)";
    const BADGE_RIGHT = 131;
    // Above every in-app layer (the largest built-in z-index is 1250), so page
    // overlays cannot cover it. The slot host itself is capped at z-index 20,
    // which is why this renders through a portal on document.body.
    const PORTAL_Z = 1300;

    function FengguBadge() {
      const [now, setNow] = React.useState(() => Date.now());
      const meta = useHolidayTable();
      React.useEffect(() => {
        let alive = true;
        let timer = 0;
        const schedule = () => {
          if (!alive) return;
          const delay = Math.max(1000, nextChangeAt(Date.now()) - Date.now());
          timer = setTimeout(() => {
            if (!alive) return;
            setNow(Date.now());
            schedule();
          }, delay);
        };
        // Timers can fire late after a sleep or a stalled renderer, so re-read
        // the clock on focus/visibility and reschedule from there.
        const resync = () => {
          if (!alive) return;
          clearTimeout(timer);
          setNow(Date.now());
          schedule();
        };
        schedule();
        document.addEventListener("visibilitychange", resync);
        window.addEventListener("focus", resync);
        return () => {
          alive = false;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", resync);
          window.removeEventListener("focus", resync);
        };
        // `meta.version` re-arms the alarm after the table changes.
      }, [meta.version]);
      const state = React.useMemo(() => classify(new Date(now)), [now, meta.version]);
      const node = React.createElement(
        "div",
        {
          "data-fenggu-time": state.peak ? "peak" : "idle",
          style: {
            position: "fixed",
            top: BADGE_TOP,
            right: BADGE_RIGHT + "px",
            zIndex: PORTAL_Z,
            pointerEvents: "none",
          },
        },
        React.createElement(
          "span",
          {
            style: {
              borderRadius: "var(--dsw-radius-xs)",
              background: "var(--dsw-alias-fill-tsp-secondary)",
              color: state.color,
              fontSize: "12px",
              lineHeight: "22px",
              height: "22px",
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "0 8px",
              userSelect: "none",
            },
          },
          // 4px = a third of the 12px label. currentColor keeps the dot on the
          // same colour as the text, so peak/idle needs no second decision.
          React.createElement("span", {
            "aria-hidden": "true",
            style: {
              width: "4px",
              height: "4px",
              borderRadius: "50%",
              background: "currentColor",
              flex: "none",
            },
          }),
          state.label,
        ),
      );
      return reactDom.createPortal(node, document.body);
    }

    // ---------------------------------------------------------------------
    // Settings → General row: holiday data version + "check for updates".
    // A Settings row is a client registration; registering the host route
    // alone would not produce one.
    // ---------------------------------------------------------------------
    const ORIGIN_TEXT = { bundled: "内置", updated: "已下载" };

    const BUTTON_STYLE = {
      boxSizing: "border-box",
      height: "32px",
      minWidth: "58px",
      borderRadius: "var(--dsw-radius-md)",
      border: "none",
      background: "var(--dsw-alias-bg-module-platform)",
      color: "var(--dsw-alias-label-primary)",
      fontFamily: "inherit",
      fontSize: "13px",
      lineHeight: "20px",
      padding: "0 12px",
      cursor: "pointer",
      flex: "none",
    };

    function FengguSettingsRow() {
      const meta = useHolidayTable();
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const check = async () => {
        setBusy(true);
        setStatus(null);
        try {
          const response = await fetch("/dsh-fenggu-time/holidays/check", { method: "POST" });
          const body = await response.json().catch(() => null);
          if (!response.ok || body === null || body.ok === false) {
            setStatus({ error: true, text: (body && body.error) || "HTTP " + response.status });
            return;
          }
          if (body.updated) {
            await refreshTable();
            setStatus({ text: "已更新到 " + body.version });
          } else {
            setStatus({ text: "已是最新（" + body.version + "）" });
          }
        } catch (error) {
          setStatus({ error: true, text: "检查失败：" + (error && error.message ? error.message : "网络不可用") });
        } finally {
          setBusy(false);
        }
      };

      const version = "数据版本 " + meta.version + " · " + (ORIGIN_TEXT[meta.origin] || meta.origin);
      const detail = meta.updated === null ? version : version + " · 更新于 " + meta.updated;

      return React.createElement(
        "div",
        {
          style: {
            borderBottom: "1px solid var(--dsw-alias-border-l2)",
            alignItems: "center",
            gap: "8px",
            padding: "16px 0",
            display: "flex",
          },
        },
        React.createElement(
          "div",
          {
            style: {
              flexDirection: "column",
              flex: "1",
              gap: "4px",
              minWidth: "0",
              paddingRight: "48px",
              display: "flex",
            },
          },
          React.createElement(
            "div",
            { style: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", lineHeight: "22px" } },
            "节假日数据",
          ),
          React.createElement(
            "div",
            { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" } },
            detail,
          ),
          status === null
            ? null
            : React.createElement(
                "div",
                {
                  style: {
                    color: status.error
                      ? "var(--dsw-alias-state-error-primary)"
                      : "var(--dsw-alias-label-secondary)",
                    fontSize: "12px",
                    lineHeight: "18px",
                  },
                },
                status.text,
              ),
        ),
        React.createElement(
          "button",
          {
            type: "button",
            disabled: busy,
            onClick: check,
            style: busy ? { ...BUTTON_STYLE, opacity: 0.6, cursor: "default" } : BUTTON_STYLE,
          },
          busy ? "检查中…" : "检查节假日更新",
        ),
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("shell.overlay", () => {
        try {
          ctx.slots.register({ name: "shell.overlay", id: "fenggu-time", order: 0 }, FengguBadge);
        } catch (error) {
          console.error("[dsh-fenggu-time] badge registration failed:", error);
        }
      });
      ctx.slots.inject("settings.general.item", () => {
        try {
          ctx.slots.register(
            { name: "settings.general.item", id: "fenggu-time-holidays", order: 12 },
            FengguSettingsRow,
          );
        } catch (error) {
          console.error("[dsh-fenggu-time] settings row registration failed:", error);
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.classify = classify;
    exports.nextChangeAt = nextChangeAt;
    exports.bundledVersion = BUNDLED_VERSION;
    exports.holidayRanges = BUNDLED_RANGES;
    return module.exports;
  },
});

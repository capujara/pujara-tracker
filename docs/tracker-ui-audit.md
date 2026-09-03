# Task Tracker — UI/UX Audit

*Audited 2026-07-12 against `public/tracker.html` v54 (code read + live walkthrough of every screen at 1440px and 375px, all roles).*

This audit precedes the visual redesign. Scope: visual language and interaction only.
**No functionality, data model, sync logic, or API behavior changes.**

---

## 1. What already works (keep)

- **Information architecture is right.** Role-scoped tabs (Dashboard / own workspace /
  Activity / Settings), "My Tasks vs Team's Tasks" split, billing pipeline for Super
  only, archives collapsed by default. Don't touch.
- **Excel-familiar status colors** are a feature for this office, not a bug — staff
  came from spreadsheets. Refine the hues; keep the hue→status mapping.
- **Dense, single-screen tables** with inline edit (contenteditable cells, inline
  selects) are the core workflow and feel fast.
- **Drill-downs** from dashboard → filtered table with focus highlight are excellent.
- **Sync safety UX** (dirty-state guard, sync indicator, saved toast, tombstone
  deletes, inline delete-confirm) is thoughtful; only its *presentation* needs work.
- **History note:** a sidebar redesign (v52) was rolled back to top tabs the same day
  (commit 070027b). This redesign keeps **top tabs** and polishes them.

## 2. Findings

### Typography
- Arial first in the font stack — reads dated on every platform. No type scale:
  ad-hoc sizes 9, 10, 11, 12, 12.5, 13, 14, 15, 18, 20, 22, 32px scattered in ~90
  inline styles. 9–10px metadata is below legibility floor.
- Hierarchy carried by color variety instead of size/weight discipline. Numbers in
  tables/KPIs are not tabular — columns shimmy when values change.

### Color
- Two palettes coexist: legacy Excel pastels (`--green-bg #c6efce`, `--red-bg
  #ffc7ce`…) and a newer hex set hardcoded in JS strings (`#3B6D11`, `#A32D2D`,
  `#BA7517`, `#97C459`…). ~40 raw hex values live inside template literals.
- Navy `#1f3864` is used as header band, table header fill, button fill, link color,
  focus ring, badge — accent and chrome are the same thing, so nothing stands out.
- Muted text `#6b7280` on `#fafbfd` zebra rows ≈ 4.4:1 — borderline; 9px muted
  metadata fails AA badly.

### Spacing & layout
- No spacing scale: 2/3/4/5/6/7/8/9/10/12/14/16/18px paddings all appear. Cards use
  full borders + heavy `th` fills → boxed-in, cramped feel despite low actual density.
- Tables use bordered cells (`border: 1px solid` on every `td`) — the single
  strongest "2005 intranet" signal in the app.
- The Super Admin 100vw breakout (`.super-3col`) fights the 1400px max-width main
  column; on 1200–1400px screens gutter to-do boxes crush to 240px.

### Components
- Emoji as icons throughout (⬇ ⬆ 🖨 📁 💰 🧾 📊 ⚠️ 👥 🏢 📜 ✓ ✕ ▾ ▸) — inconsistent
  cross-platform rendering, unthemeable.
- Buttons: 5+ ad-hoc styles (header white, `.btn` navy, `.toggle-archive`,
  `.clear-filters`, `.row-actions button`, inline-styled ✓ commit buttons).
- Native `confirm()`/`prompt()`/`alert()` dialogs for destructive/bulk flows.
- Focus states: default outlines mostly suppressed by `outline: none`/custom
  backgrounds; keyboard navigation exists in ms-popup/combo but is invisible.
- No `prefers-reduced-motion` handling; the few animations that exist are fine
  durations (150–300ms) but use default easing.

### Interaction gaps
- No hover affordance consistency: some rows highlight, some cells yellow-flash,
  headers darken; nothing shares a motion token.
- No keyboard entry point to anything global (no palette, no shortcuts).
- Delete = inline confirm (good) but styled as a color swap only.
- Empty states are plain italic text; loading states nonexistent (sync is silent
  until the stale indicator trips).

## 3. Redesign plan (approved constraints)

1. **Tokens first** — neutral ramp (12 steps, cool-tinted), one accent (refined
   navy-indigo), semantic status tints (hue-mapped to the current Excel scheme),
   type scale 11/12/13/15/18/24 with Inter + system fallback and tabular numerals,
   4px spacing scale, hairline borders, layered shadows, motion tokens
   (`cubic-bezier(0.16,1,0.3,1)`, 120/180/240ms), `prefers-reduced-motion`.
2. **Restyle every existing class before touching markup** — zero behavior risk.
3. **Screen-by-screen markup cleanup** (shell → tables/forms → dashboard →
   activity/settings): inline styles → classes, emoji → inline Lucide SVG.
4. **Additive keyboard layer**: Ctrl/Cmd+K command palette that only calls existing
   functions (setTab, _dashDrill, exportJSON, print, logout), visible
   `:focus-visible` rings everywhere.
5. **Version bump v55** (client + server constants) last, so deployed clients
   auto-reload once.

Every phase is verified live (desktop 1440 + mobile 375, seeded data, all roles)
before its commit.

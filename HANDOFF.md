# Handoff — Waxing The City Analytics ("Employee Performance")

Last updated: 2026-07-27, end of session covering the theme change, the
P&L tab (built three times, in increasingly different directions), an
hours-parsing bug fix, and a broken-deploy fix.

## What this app is

A single-page React app (`time-and-till`, CRA/react-scripts 5) that compares
labor hours against sales for Waxing The City's three stores — Concord,
Media, Pike Creek — plus a computed P&L. Deployed on Vercel
(`evan-s-projects1515/store-analytics`, auto-deploys on push to `main` on
GitHub `evanrobins6789-cyber/store-analytics`). Data persists to Supabase
(table `periods`, a generic `period_id text primary key / payload jsonb`
store — see "Data model" below) with a localStorage fallback when Supabase
isn't reachable.

Tabs: **Overview**, **Employee Performance**, **By Store**, **P&L**, **Setup**.

## File map

- `src/App.js` — everything UI-side lives in this one file (all tab
  components, the App shell). Not split into `src/tabs/*` — those files
  exist in the repo but are dead/unused leftovers from an earlier version;
  don't edit them expecting effect. `src/styles.css` is similarly unused
  (App.js imports `App.css`, not `styles.css`).
- `src/parser.js` — all Excel/xlsx parsing: `parseHoursFile`,
  `parseSalesFile`, `parseStoreCollectionFile` (new this session),
  `parseRosterFile`, plus shared grid-reading helpers.
- `src/db.js` — Supabase + localStorage persistence, generic key/value
  over the `periods` table.
- `src/hourlyRates.js` — hardcoded per-employee hourly rates + the payroll
  formula (`totalPay`). Edited manually, not uploaded.
- `src/storeRoster.js` — hardcoded employee → store mapping
  (`STORE_ROSTER.stores` = `[{name:'PIKE CREEK',...}, {name:'MEDIA',...},
  {name:'CONCORD',...}]`, note the exact uppercase names — used as object
  keys throughout, e.g. in `fixedExpenses`). Edited manually, not uploaded.
- `src/App.css` — the only stylesheet that's actually live. White/orange
  theme (brass = orange accent, `--brass: #F2790C`).

## What changed this session, in order

1. **Theme**: beige/brass → white/orange across `App.css`,
   `public/index.html`, `public/manifest.json`, and the two chart bar
   colors in `App.js`.
2. **P&L tab, attempt 1**: upload a finished "Contribution Report" P&L
   export and render it. Built, then the user said they didn't want an
   upload step for the P&L at all — reworked.
3. **P&L tab, attempt 2**: compute P&L live from the same Period 1/2
   Hours+Sales files already used elsewhere. Income = service + retail
   revenue (from the sales file), Compensation = same payroll calc as
   Employee Performance, Fixed expenses = a new per-store editable form
   (Rent, Utilities, Insurance, Licenses, Alarm Monitoring, Accounting,
   Bank Fees, Information Systems, Royalties, Supplies, Advertising,
   Maintenance, Paidouts, Refunds), seeded with real numbers hand-parsed
   from a March 2026 Contribution Report the user shared once (see
   `DEFAULT_FIXED_EXPENSES` in App.js — these are baked-in defaults, only
   applied to a store the first time it has no saved fixed-expense data).
4. **Redesign**: per-store sections (Concord/Media/Pike Creek) each with
   their own full statement, plus an "All Stores Combined" section
   (category sums across stores, not per-store totals) — instead of a
   store dropdown. Added a "% of income" column to every line.
5. **Bug fix — hours parsing** (real, user-reported, verified against
   `Attendance(40).xlsx`): the attendance export lists one row *per shift*,
   not one row per employee. `parseHoursFile` was pushing every row as a
   new entry; since periods merge employees by name in a `Map`, each new
   shift silently overwrote the last, so every employee's hours ended up
   as just their final shift instead of the period total. Fixed to sum
   shifts per employee. This was breaking payroll/TSTH everywhere except
   the Overview tab's own "Hours worked" figure (which reads the report's
   footer total directly).
6. **Bug fix — broken Vercel deploy**: a `// eslint-disable-line
   react-hooks/exhaustive-deps` comment referenced a rule that isn't
   registered under that name in this project's ESLint config, which
   CRA's build treats as a hard compile error (`Failed to compile`).
   Fixed by dropping the specific rule name from the disable comment.
   **This is why Node.js is now installed on this machine** (via
   `winget install OpenJS.NodeJS.LTS`, with the user's OK) — there was no
   way to catch this without actually running `npm run build`, and
   Vercel's build logs need the user's login to view. Use
   `npm run build` (with `$env:CI="true"` in PowerShell) before pushing
   anything nontrivial to `App.js` from now on.
7. **P&L income source changed to a third report**: the user gave a
   `KPI's(11).xlsx` — a store-level KPI export, one row per store
   (Concord/Media/Pike Creek, matched by substring since the file spells
   them like "DE-Wilmington (Concord)") plus a Grand Total row. Verified
   to the cent that **Service + Product + Membership + Package + Gift
   Card + Prepaid Collection sum exactly to Total Collection**. Added
   `parseStoreCollectionFile` in `parser.js` and a third upload slot per
   period ("Store collection summary"). P&L Income is now this
   breakdown instead of the sales file's service+retail sum.
8. **Uploads moved into Setup tab**: the Period 1/2 upload panels (now 3
   slots each: Hours, Sales, Collection Summary) no longer sit above the
   tabs on every screen — they live in the Setup tab only. Removed the
   now-dead `panelOpen` collapse toggle and its CSS.
9. **P&L layout → horizontal scroll**: stores are swipeable cards in a
   row (`overflow-x` + `scroll-snap`) instead of stacked vertically.
10. **P&L simplified to current-period-only**: dropped the Period 1 vs
    Period 2 comparison from the P&L tab entirely (no delta badges, no
    period toggle, no date-range text anywhere in it) — it now shows only
    Period 2's data. Store name is the first thing rendered in each card.
    Period 1 is unchanged/still used by Overview, Employee Performance,
    and By Store.

## Data model (Supabase `periods` table)

Generic `period_id text primary key, payload jsonb`. Keys in use:
- `period1`, `period2` — `{ label, hours, sales, collections }`, each of
  `hours`/`sales`/`collections` being the parsed-file object or `null`.
- `fixed_expenses` — `{ [STORE_NAME]: { rent, utilities, insurance,
  licenses, alarmMonitoring, accounting, bankFees, infoSystems, royalties,
  supplies, advertising, maintenance, paidouts, refunds } }`, keyed by the
  exact uppercase store names from `STORE_ROSTER`.

No new Supabase tables/SQL were needed for any of this — everything reuses
the one `periods` table and its existing RLS policy.

## Known gaps / things to watch

- **No live browser verification** was done for any of the P&L UI work —
  no Chrome extension connected, and there's no Firefox automation tool
  available. Everything was verified via `npm run build` compiling
  cleanly plus manual tracing of the component logic against real
  uploaded files (verified numerically with standalone Node scripts, not
  through the actual React UI). Worth an actual eyeball pass in the
  browser, especially the sideways-scroll layout on a real phone.
- **Fixed-expense seed data is from March 2026** and will go stale. It
  only fills in a store the first time it has *no* saved data — once the
  user hits Save on a store's form (even unchanged), their own numbers
  take over permanently for that store.
- **P&L now only reflects Period 2.** If the user relabels which period
  is "current" (e.g. starts using Period 1 for the newer month), the P&L
  won't follow — it's hardcoded to Period 2 in `App.js`'s render call.
- The store collection KPI report has no date range in the file itself
  (unlike Hours/Sales, which have a "From/To" line) — no date label is
  shown in the P&L now anyway, so this doesn't currently matter, but if
  date-awareness comes back it's a gap.
- Node.js (LTS, installed via winget) and its `node_modules` now exist in
  this working directory — previously absent, which is *why* the eslint
  rule-name bug shipped without being caught. `npm run build` before
  pushing App.js/App.css/parser.js changes going forward.

## User preferences learned this session (saved to memory)

- Push completed changes straight to `main` without asking each time —
  this repo auto-deploys via Vercel (see `[[feedback-push-to-main]]`
  memory).
- User uses Firefox, not Chrome — no browser automation tool is
  currently available for live UI verification.

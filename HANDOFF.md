# Handoff — Waxing The City Analytics ("Employee Performance")

Last updated: 2026-08-10 — **Deploying the 2026-08-09 rebuild hit a real
Supabase permissions snag, diagnosed and a fix given — not yet confirmed
fixed, check this first.** See "DEPLOY SNAG — new tables returned 401,
missing GRANTs" right below. No code changed this session, this was pure
live troubleshooting after the rebuild's first real-world deploy.

## DEPLOY SNAG — new tables returned 401, missing GRANTs (2026-08-10)

After running the `attendance_entries`/`sales_entries` SQL from the
2026-08-09 rebuild (below) and confirming via `pg_tables`/`pg_policies`
that both tables and their "Allow all access" RLS policies existed, the
app was still showing "Couldn't reach Supabase (Could not find the table
'public.attendance_entries' in the schema cache)". Talked through several
wrong hypotheses first (stale PostgREST cache, wrong Supabase project) —
ruled both out via `NOTIFY pgrst, 'reload schema'` and confirming the
Vercel Storage-integration SQL Editor is guaranteed to be the same project
the app uses.

**Actual cause, found via the browser's Network tab (Firefox dev tools —
first real live-browser check this app has gotten in weeks):**
`attendance_entries`/`sales_entries` requests returned **401**, while the
existing `periods` table on the same connection returned **200**. Tables
created by hand through the Supabase SQL Editor don't automatically get
`GRANT`ed to the `anon`/`authenticated` roles the way tables created
through Supabase's Table Editor UI do — an RLS policy alone isn't enough,
Postgres checks table-level `GRANT` first. `periods` must have gotten its
grants some other way (created earlier, possibly via a different path) —
these two new tables didn't.

**Fix given** (not yet confirmed by the user as of this writing — check
this first next session before assuming it's fixed):
```sql
grant select, insert, update, delete on public.attendance_entries to anon, authenticated;
grant select, insert, update, delete on public.sales_entries to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
```

**Follow-up not yet done**: the Setup tab's in-app SQL snippet (and the
copy of it in the section below) still doesn't include these `GRANT`
lines — anyone who ever needs to recreate these tables from scratch by
following that snippet will hit this exact same 401. Should add the
`grant` statements there too; flagged but not done this session since the
user only asked for this handoff update, not a code change.

**Once confirmed fixed**, the real end-to-end test from the 2026-08-09
entry below (upload a real Attendance + Employee Sales file, confirm the
tabs populate, re-upload the same file and confirm it corrects instead of
duplicating) is still outstanding and should happen next.

## REBUILT — row-level Attendance + Employee Sales, permanent history (2026-08-09)

The user wants to upload real reports going forward and have the dataset
just keep growing forever, rather than re-uploading into period slots.
Verified against two real files (`Attendance(47).xlsx`, `Employee
Sales(5).xlsx`) that both have a date on *every line*, not just a report
header — so the whole "match this upload to a period by its parsed
from/to date" design (the source of the 2026-08-08 bug) is gone; there are
no periods anymore, just two ever-growing tables filtered by whatever
range the CompareBar picker is set to.

- **New Supabase tables** (row-level, NOT part of the existing generic
  `periods` JSON-blob table — a growing dataset like this would mean
  re-uploading everything on every single upload if it lived in one
  blob): `attendance_entries` (work_date, employee_name, hours_decimal)
  and `sales_entries` (sale_date, employee_name, store_name, invoice_no,
  item_code, item_type, item_name, sale_amount, payment_type, status).
  **The user needs to run the SQL for these once** — it's in the Setup
  tab under "One-time database setup," same pattern as the original
  `periods` table SQL. Until that's run, uploads will silently fall back
  to local-only storage with a toast error (same fallback behavior
  `periods` already had).
- **`src/parser.js`**: `parseHoursFile`/`parseSalesFile` (old KPI-style,
  collapsed to one row per employee) replaced by `parseAttendanceFile`/
  `parseEmployeeSalesFile` — both return one entry per raw line, with its
  own date, no collapsing. Fixes the old per-shift-overwrite risk for
  free (nothing collapses employees by name at parse time anymore).
  `fromDate`/`toDate` on the parsed result are computed from the actual
  row dates (min/max), not the report's header text — sidesteps the
  entire class of bug the old `parseLooseDate`-in-period-matching had,
  since row dates ("8/1/2026") are trivially parseable and every row has
  one. Verified against both real files with an actual Jest+jsdom test
  (parser.js needs a browser `FileReader`, so a plain Node script can't
  exercise the real exported functions) — Employee Sales' 123 rows summed
  to $4,187.50, matching the file's own footer exactly. Attendance summed
  to 370:56 across 53 rows; the file's footer says 404:20 across 66 raw
  rows, but 13 of those are the excluded manager ("Ciana (mgr) Santiago")
  — same `isExcludedName` filter the app has always applied, confirmed by
  counting her rows independently. Not a bug, just took a wrong first
  guess at the test assertion to notice.
- **`src/db.js`**: added `loadAttendanceEntries`/`loadSalesEntries`
  (select all, ordered by date) and `replaceAttendanceRange`/
  `replaceSalesRange` (delete rows in `[fromDate, toDate]` computed from
  the upload's own rows, then insert the new ones) — a re-upload of a
  week you already loaded corrects it in place instead of duplicating,
  with no fragile per-row unique key needed (Employee Sales can
  legitimately have two identical-looking line items in one invoice).
  Local-storage fallback mirrors the same semantics under
  `wtc_attendance_entries_v1`/`wtc_sales_entries_v1`.
- **`src/App.js`**: the display components (Overview, Employee
  Performance, By Store, P&L's statement layout, `LedgerTable`,
  `CompareBar`, etc.) are **unchanged** — they all consumed one shared
  "merged period" shape before and still do now; only the data-plumbing
  underneath was replaced. `aggregateAttendance`/`aggregateSales` (new)
  filter the raw row arrays by picked date range and sum per employee;
  `mergePeriod` (kept, same logic) combines those into the shape the UI
  already expected. Default comparison range on load: most recent 7 days
  present in the data vs. the 7 days before that (replaces "two most
  recent periods").
- **P&L unchanged in spirit**: per explicit user decision, P&L still gets
  its Income from a separate Store Collection Summary upload (not derived
  from Employee Sales) — that upload isn't historical, it's a single
  "current snapshot" now stored under the `periods` table's
  `collections_current` key (previously lived awkwardly inside whichever
  `report_periods` entry was "most recently touched").
- **History tab → Upload Log tab**: there's no more "period" to browse —
  data is continuous now. The tab instead lists every Attendance/Employee
  Sales upload ever made (file name, date range, row count, when), so you
  can check "did I already load the week of Aug 1?" before re-running an
  export. Browsing actual numbers by date now happens via the
  `CompareBar` picker on every other tab, which works over however wide a
  range you want (no more "spans more than one uploaded period" concern —
  there's no period to span).
- **Old `report_periods` data**: left alone in Supabase, not migrated
  (explicit user decision — there's no way to reconstruct row-level facts
  from already-rolled-up weekly totals). The new tabs don't read it. If
  historical weeks matter going forward, re-upload their Attendance/
  Employee Sales files if still available.
- **Accepted simplification**: the old "house / unattributed sales"
  footnote on the Employees tab is gone — excluded names (managers,
  house-sale rows, anything matching `pos`) are now dropped entirely at
  parse time rather than tallied into a running total.
- **Known gap — no live browser verification**, same as every session on
  this machine (no Chrome extension, no Firefox automation tool). Verified
  via `CI=true npm run build` (compiles clean) and an actual Jest+jsdom
  test exercising the real parser functions against both real sample
  files (see above) — but nobody has clicked through the real UI with
  these changes yet. **Before trusting it with next week's real upload**:
  open the app, upload a real Attendance file and a real Employee Sales
  file, confirm Overview/Employee Performance/By Store populate and the
  numbers look right, check the Upload Log tab shows the upload, then
  re-upload the *same* file and confirm it corrects in place rather than
  duplicating (row count in Upload Log should show a new entry but the
  totals shouldn't double).

---

## STILL OPEN — uploads still not populating after the compare-range fix (2026-08-08, fifth touch)

The fourth-touch fix below (backfilling the CompareBar when both sides are
blank) did not fix it — user tested again after that deploy and it's still
broken. Didn't get to dig further this session; here's the strongest
remaining hypothesis, ranked, for whoever picks this up next.

**Most likely: `fromDate`/`toDate` parsing is failing on the user's real
report files, even though the old `dateRangeLabel` text extraction still
works.** `periodsOverlappingRange` (in `App.js`) hard-requires
`p.fromDate && p.toDate` to match a period into *any* picked range — if
those come back `null`, that period can never appear in Overview/Employee
Performance/By Store/P&L no matter what the picker is set to, even though
it'll still show up fine in the History tab (which doesn't filter by
date). `fromDate`/`toDate` are brand new this session (`parseLooseDate()`
in `parser.js`, added alongside the Period 1/2 removal) — unlike the raw
`dateRangeLabel` text extraction, which has worked against real files for
months (see the 2026-07-27 hours-parsing bug fix entry further down,
which was verified against a real `Attendance(40).xlsx`). `parseLooseDate`
was only ever tested against fabricated strings like `"07/01/2026"` in a
throwaway Node script — never against the actual date text a real Zenoti/
ADP export prints, which might use a format `new Date(...)` doesn't
parse (e.g. a different separator, a weekday name, a locale quirk) and
silently returns `null` with no error surfaced anywhere.

**Fastest way to confirm this next session:** upload one real hours file,
then check the History tab entry it created. If the entry's label reads a
real date range (e.g. "7/1/2026 – 7/15/2026") but the period still never
shows up in Overview/Employee Performance no matter what's in the
CompareBar's date pickers, that confirms `fromDate`/`toDate` are `null`
while `dateRangeLabel` is fine — i.e. exactly this bug. (If the label
itself is also wrong/missing — "Untitled period" — the problem is further
upstream, in `findDateRange`'s regex not matching this file's header at
all, which would be a preexisting issue unrelated to this session's work.)

**If confirmed, two ways to fix, not mutually exclusive:**
1. Fix `parseLooseDate` (in `parser.js`) to actually handle the real date
   text format — need one real exported file (or just the "From : ... To
   : ..." header line copy-pasted) from the user to know what it looks
   like; nothing in this repo currently captures a real sample.
2. Make the app degrade gracefully instead of hard-failing: have
   `periodsOverlappingRange`/`computeDefaultRange` fall back to matching
   on `dateRangeLabel` string equality when `fromDate`/`toDate` are
   missing, so a parse failure loses the "pick an arbitrary date range"
   flexibility for that period but doesn't silently make it disappear
   from every comparison tab.

**Other things to rule out first, cheaper than the above:** the user may
not have hard-refreshed since the deploy (no service worker is registered
in `src/index.js`, so this shouldn't matter, but worth a sanity check —
have them close and reopen the tab/PWA). Also confirm in the Vercel
dashboard that the deployment actually built from commit `d55d388` or
later (Claude has no Vercel login to check this directly).

## FIX (did not fully resolve it — see STILL OPEN above) — report periods didn't show up anywhere after upload (2026-08-08, fourth touch)

## FIX — report periods didn't show up anywhere after upload (2026-08-08, fourth touch)

Immediately after the Period 1/2 → report-periods change below shipped,
the user uploaded a real report and the main page (Overview) stayed
empty — same for Employee Performance, By Store, and P&L. This was a real
bug, not just an unverified-in-browser gap: the new CompareBar's two
date-range pickers start blank (`{from:'', to:''}`), and nothing in
`handleFile` ever filled them in after a successful upload — so a fresh
account (or anyone who'd just hit "Delete all data") could upload
correctly, see it land in History, and still see "no data" everywhere
else because the picker wasn't pointed at any real date range yet.

**Fix**, in `App.js`'s `handleFile`: after adding/updating a period,
`setCompareRange` now backfills via `computeDefaultRange(next)` whenever
*both* sides of the picker are still untouched (both from/to blank) —
i.e. only on that first-ever-population case; once the user (or this
backfill) has set a real range, later uploads don't yank it out from
under them. Also fixed the empty-state copy in Overview/Employee
Performance/By Store, which still said "no files uploaded yet" — that's
no longer the likely cause now that periods are matched by date range, so
the message now points at the picker/Setup tab instead.

Verified via `CI=true npm run build` only — still no browser automation
on this machine. This class of bug (something that only breaks in a real
render, not in build/lint) is exactly why every prior "needs a real
browser click-through" caveat in this file has been earning its keep —
worth actually doing that click-through soon instead of deferring it
again.

## NEW THIS SESSION — Period 1/2 replaced by date-driven report periods (2026-08-08, third session)

The user asked: no more "Period 1"/"Period 2" in the uploads tab, just
Hours / Service Sales / Collections drop boxes — every report already has
a date range printed on it, so the app shouldn't need the user to manually
assign uploads to a slot. Then, when asked how Overview/Employee
Performance/By Store should still do their side-by-side comparison without
slots, the user wanted **their own two-date-range picker** (not just an
auto "latest vs previous"), plus a **"month to date vs prior month"**
shortcut button.

- **Storage model replaced**: `period1`/`period2`/`period_history` (from
  the "automatic period history" feature earlier that day) are gone,
  replaced by one key, `report_periods` — a flat, ever-growing array of
  `{ id, label, fromDate, toDate, hours, sales, collections, updatedAt }`.
  A one-time migration in `App.js` (`migrateLegacyToReportPeriods`) runs
  once on load if `report_periods` doesn't exist yet, folding any existing
  `period1`/`period2`/`period_history` data into the new list — so data
  already uploaded before this deploy isn't lost. Same generic `periods`
  table/`savePeriod` pattern as always, no schema change.
- **Real dates, not just a label**: `parser.js` now parses the "From : …
  To : …" text into actual `fromDate`/`toDate` ISO (`YYYY-MM-DD`) fields
  via a new `parseLooseDate()` (built from local calendar fields, not
  `toISOString()`, to avoid a UTC-conversion off-by-one near midnight) —
  alongside the pre-existing `dateRangeLabel` string. Collections reports
  still have no date range printed on them (confirmed earlier session) —
  uploading one files it under whichever period was most recently touched.
- **Upload matching**: in `handleFile` (`App.js`), a new hours/sales
  upload is matched against an existing `report_periods` entry with the
  *same* `fromDate`/`toDate` (a correction, merged in place) or creates a
  brand-new entry (a new period) if no match — no more "is this the same
  period or a new one" heuristic needed, the date range answers it
  directly.
- **New CompareBar** (top of Overview/Employee Performance/By Store/P&L,
  not shown on Weekly Report/History/Setup): two independent date-range
  pickers (`<input type="date">` × 2 per side, labeled A/B) plus a "This
  month vs last month" button that sets A = 1st-of-prior-month through the
  same day-of-month, B = 1st-of-this-month through today. If a picked
  range spans more than one uploaded period (e.g. a full calendar month
  made of two semi-monthly pay periods), they're summed together via new
  `combineHours`/`combineSales`/`combineCollections` before going through
  the existing `mergePeriod` — every downstream display component
  (`PeriodSummaryCard`, `LedgerTable`, `PLTab`, etc.) needed **zero**
  changes, they just consume whatever merged data they're handed.
  Default range on load: the two most recent distinct periods.
- **History tab** now lists every uploaded period permanently (sourced
  from the same `report_periods` list), not just ones that got replaced —
  a superset of what the earlier "automatic period history" version did.
- **"Clear all" → "Delete all data"**: now a real, explicit, confirmed
  delete of `report_periods`. Periods can no longer be lost by accident
  the way Period 1/2 reuse used to risk, so there's no more soft-archive
  step here — this button means it.
- **Not done**: no per-entry delete/edit from the History tab (e.g. to fix
  a bad upload) — would be a reasonable follow-up if it comes up. Also no
  UI for renaming a period's auto-filled label.
- Verified via `CI=true npm run build` plus **standalone Node scripts**
  (same no-browser-automation gap as every session this week) checking
  `parseLooseDate` against sample date strings, the month-to-date range
  math including a Dec→Jan year rollover and a Mar→Feb 28-day rollover,
  and the date-range overlap filter — but nobody has uploaded a real file
  through the actual UI since this change. Before trusting it: upload an
  hours file, confirm it lands as a new History entry with the right date
  range, re-upload the same file (or same date range) and confirm it
  corrects in place rather than duplicating, then try the compare picker
  and "This month vs last month" button with real data.

## Automatic period history, nothing uploaded is ever lost (2026-08-08, earlier session — superseded by the above)

Previously Period 1 and Period 2 were plain overwrite slots: uploading a new
hours/sales file into a slot that already had data silently discarded the
old one, with no way to look back. User asked for uploads to be historical.

- **Detection**: `parseHoursFile`/`parseSalesFile` already return a
  `dateRangeLabel` parsed from the file itself (see `parser.js`). In
  `handleFile` (`App.js`), if the slot being uploaded into already holds a
  file of the *same kind* with a *different* `dateRangeLabel`, that's
  treated as a new period being loaded in (not a correction) — the whole
  outgoing period (`label`/`hours`/`sales`/`collections`) is archived first,
  then the slot resets to just the newly uploaded file. If the date range
  matches (or there's nothing to compare, e.g. a lone collections
  re-upload), it's treated as a same-period correction and just overwrites
  in place — no archive noise for typo fixes.
- **Storage**: archived snapshots go into a new `period_history` key (an
  array, newest first) in the same generic `periods` table — same
  `savePeriod`/`loadPeriods` pattern as `fixed_expenses` and
  `weekly_report`. No schema change. Each entry: `{ id, archivedAt, label,
  hours, sales, collections }`.
- **New History tab** (`HistoryTab`/`HistoryEntryCard` in `App.js`, between
  Weekly Report and Setup): lists every archived period with the same
  summary stats as an Overview card (hours, service revenue, TSTH, payroll,
  plus store-collections total if present) and an expandable per-employee
  table, reusing `mergePeriod`.
- **"Clear all" → "Clear periods"**: now archives Period 1 and 2 (via the
  same `archivePeriods` helper) before resetting just those two keys,
  instead of calling the old `clearPeriods()` in `db.js`, which ran `delete
  from periods` — i.e. it wiped the *entire* table including
  `fixed_expenses` and `weekly_report`, not just the two period slots the
  button implied. That function is now deleted from `db.js` since nothing
  needs a delete-everything path anymore.
- **Known gap — depends on the still-open Supabase DNS issue below.** Like
  everything else in this app, `period_history` only actually syncs
  cross-device once that's fixed; until then it's per-device via
  localStorage same as period1/period2 already are.
- **Not done**: no "restore an archived period back into Period 1/2 for a
  live side-by-side" action — History is read-only browsing for now. Would
  be a natural follow-up if the user wants to re-compare an old period
  against a current one instead of just eyeballing the archived summary.
- Verified via `CI=true npm run build` only (same no-browser-automation gap
  as every other UI session on this machine) — nobody has actually
  triggered the archive-on-reupload path by hand in a real browser yet.
  Before relying on it: upload an hours file into Period 1, then upload a
  *different date range's* hours file into the same slot, and confirm the
  old one shows up under History with correct numbers.

## Weekly Report tab, ported from Lauren's separate site (2026-08-08, earlier session)

Evan's sister Lauren built a separate Next.js site (`wtc-weekly-report`,
local copy at `OneDrive\Desktop\WTC\Laurens Site\wtc-weekly-report-main`)
that does sales/employee tracking fed by the studios' Zenoti report
exports — a different, complementary dataset to this app's existing
Hours/Sales/Collection-driven tabs. Ported the whole thing in as a new
"Weekly Report" tab rather than a link to a separate site.

- **New files**: `src/weeklyReport/{constants,fileReader,parsers,compute,store}.js`
  (logic, ported near-verbatim from her `lib/`) and
  `src/weeklyReport/WeeklyReportTab.jsx` (~1500 lines — all UI for this
  feature lives in this one file, matching how the rest of this app keeps
  each tab's UI in `App.js`). New CSS classes are all prefixed `wr-` at the
  bottom of `App.css`.
- **Persistence**: reuses the existing Supabase `periods` table (see
  `src/db.js`) under one new key, `'weekly_report'`, holding the whole
  nested data blob as a single JSON payload — same pattern as the existing
  `'fixed_expenses'` key. No new Supabase table or schema change needed.
  Her original site used Vercel KV instead; not used here.
- **Scope**: sales history table (weekly + MTD, by studio or all studios),
  goal thermometers, month-over-month pacing charts (chart.js bars, not
  recharts — recharts was never added as a dependency), employee
  performance tables, pay-period (1st–15th / 16th–EOM) bonus tracking,
  supply costs, memberships (new/cancelled snapshot tracking), Club Orange
  collections (billed vs. collected rates), and guest retention — all of
  it, as one pass rather than phased, per Evan's explicit call. Internal
  sub-nav inside the tab (Dashboard / Memberships / Collections / Guest
  Retention / Supply Costs / Upload & Goals) instead of separate pages like
  her site had. No password gate was added (matches this app's existing
  no-auth behavior, unlike her site's shared-password login).
- **Uploads**: seven Zenoti report types (KPI, Attendance, Sales-Accrual,
  Cerologist Journey Sheet, Memberships export, Memberships Payment
  export, Guest Retention export) all parse client-side now (originally
  server-side in her Next.js API routes) via `xlsx` + hand-rolled CSV
  parsing, same as this app's existing Hours/Sales parsers in `parser.js`.
- **Known gap — no live browser verification.** No browser automation tool
  was available on this machine this session either (same gap as last
  time — no Chrome extension, no Firefox tool, and installing Playwright
  fresh wasn't attempted since it'd mean downloading a full Chromium
  binary unprompted). Verified via `npm run build` (`CI=true`, catches
  ESLint issues too) compiling clean, plus a careful manual line-by-line
  read of the ported logic against Lauren's originals — but nobody has
  actually clicked through this in a real browser yet. Do that first
  before trusting it with real uploads: open the Weekly Report tab, click
  through all six sub-tabs, try one real Weekly Upload with a real KPI/
  Attendance/Sales-Accrual/Cerologist file set.
- **Landmine avoided, not re-triggered**: almost added a
  `// eslint-disable-next-line react-hooks/exhaustive-deps` comment (the
  exact thing that broke the build two sessions ago, since that rule name
  isn't registered under that name in this project's ESLint config).
  Caught it via `CI=true npm run build` before pushing. Fixed properly
  instead: `GoalsSection` (in `WeeklyReportTab.jsx`) is split into an
  outer component holding the studio/month picker and an inner
  `GoalsForm` keyed by `` `${studio}|${month}` `` so it remounts with
  fresh lazy-initialized state on picker change, with no effect (and thus
  no exhaustive-deps question) needed at all.
- **Not ported**: Lauren's `/seed` page and `/api/seed` route — a
  one-time migration tool that loaded her own historical spreadsheet data
  into her site right after its first deploy. Not applicable here; the
  new tab starts empty like the rest of this app's data did.

## OPEN ISSUE — Supabase project unreachable, sync broken for everyone but Evan (2026-07-28)

User reported: site shows a red banner "Couldn't reach Supabase (TypeError:
NetworkError when attempting to fetch resource.) — showing this device's
local data only" on load, and people other than Evan who open the shared
link see no data populated.

**Diagnosis** (confirmed, not yet fixed — needs the user's Supabase/Vercel
dashboard access, which Claude doesn't have):
- Pulled the live bundle from
  `https://store-analytics-git-main-evan-s-projects1515.vercel.app/` and
  extracted the baked-in `REACT_APP_SUPABASE_URL`:
  `https://ffbcjofwfjwuldpvarbi.supabase.co`.
- That hostname does not resolve in DNS at all (`nslookup` → "Non-existent
  domain"), not a timeout/CORS/RLS error. This means the Supabase project
  behind that ref is gone (deleted, or a stale/wrong ref — not just
  free-tier-paused, since a paused project still resolves).
- Evan still sees data because it's cached in his own browser's
  localStorage (`time_and_till_periods_v1`, see `src/db.js`) from before;
  other users have no such cache, so they see an empty app.
- No real Supabase credentials are or were ever committed to this repo
  (checked full git history of `.env*` — only `.env.example` placeholders
  exist). Nothing to fix in code; this is purely a Supabase/Vercel config
  problem.

**Next steps (for the user, in their dashboards)**:
1. Check supabase.com/dashboard for whether project `ffbcjofwfjwuldpvarbi`
   still exists. If merely paused, restore it — no other changes needed.
   If gone, get the URL + anon key of whichever project should be current.
2. In Vercel (`evan-s-projects1515/store-analytics`) → Settings →
   Environment Variables, set `REACT_APP_SUPABASE_URL` and
   `REACT_APP_SUPABASE_ANON_KEY` to the correct project's values (from
   Supabase dashboard → Settings → API), for whichever environment serves
   the `-git-main-` URL.
3. Redeploy — `REACT_APP_*` vars are inlined at build time, so updating
   them in Vercel alone doesn't affect an already-built deployment.

Was not resolved this session; pick this up first next time before other
work, since it means shared sync is completely broken for all users right
now.

## What this app is

A single-page React app (`time-and-till`, CRA/react-scripts 5) that compares
labor hours against sales for Waxing The City's three stores — Concord,
Media, Pike Creek — plus a computed P&L. Deployed on Vercel
(`evan-s-projects1515/store-analytics`, auto-deploys on push to `main` on
GitHub `evanrobins6789-cyber/store-analytics`). Data persists to Supabase
(table `periods`, a generic `period_id text primary key / payload jsonb`
store — see "Data model" below) with a localStorage fallback when Supabase
isn't reachable.

Tabs: **Overview**, **Employee Performance**, **By Store**, **P&L**, **Weekly Report**, **History**, **Setup**.

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
- `report_periods` — **current, as of the third 2026-08-08 session.** An
  array of `{ id, label, fromDate, toDate, hours, sales, collections,
  updatedAt }`, one entry per uploaded date range, permanent (see "Period
  1/2 replaced by date-driven report periods" above). `period1`, `period2`,
  and `period_history` are legacy keys from before that session — no
  longer written, but left in Supabase for the one-time migration path
  (`migrateLegacyToReportPeriods` in `App.js`) to read on an account that
  hasn't loaded the app since the change yet.
- `fixed_expenses` — `{ [STORE_NAME]: { rent, utilities, insurance,
  licenses, alarmMonitoring, accounting, bankFees, infoSystems, royalties,
  supplies, advertising, maintenance, paidouts, refunds } }`, keyed by the
  exact uppercase store names from `STORE_ROSTER`.
- `weekly_report` — the whole Weekly Report tab's data (see the "Weekly
  Report tab" section above), a single nested JSON blob.

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
- **P&L now only reflects Range B** of the CompareBar (see the third
  2026-08-08 session above) — it's hardcoded to `mergedB`/`collectionsB` in
  `App.js`'s render call, same "current side only" behavior as before,
  just no longer tied to a literal "Period 2" slot.
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

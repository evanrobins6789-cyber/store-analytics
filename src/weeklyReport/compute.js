import { srRate, SR_TIER_THRESHOLDS, standardMembershipPrice, STUDIOS as MEMB_STUDIOS } from './constants';

// Ported from Lauren's wtc-weekly-report app (lib/compute.js + lib/dashboardLogic.js).

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthKey(dateStr) {
  return dateStr.slice(0, 7); // "2026-07"
}
export function monthLabel(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
export function daysInclusive(startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  return Math.round((end - start) / 86400000) + 1;
}

// ─── Format helpers ─────────────────────────────────────────────────────────
export function n(v, d = 0) {
  if (v === null || v === undefined || isNaN(v)) return '';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function money(v, d = 0) {
  if (v === null || v === undefined || isNaN(v)) return '';
  return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function pct(v) {
  if (v === null || v === undefined || isNaN(v)) return '';
  return (v * 100).toFixed(0) + '%';
}
export function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Studio weekly / MTD row builders
// ---------------------------------------------------------------------------

export function buildStudioWeekRow({ kpi, attendanceHours, addon }, start, end) {
  const guestCount = kpi.guests;
  const totalHours = attendanceHours || 0;
  const sales = kpi.totalRevenue;
  return {
    start, end,
    guest_count: guestCount,
    new_guests: kpi.newGuests,
    serv_per_guest: kpi.servicesPerInvoice,
    total_services: kpi.totalServices,
    sales,
    sales_per_day: sales / 7,
    total_discounts: kpi.totalDiscount,
    total_collections: null, // weekly rows never carry this — month total only
    at: kpi.avgInvoiceValue,
    tsth: totalHours ? sales / totalHours : null,
    total_hours: totalHours,
    retail: kpi.productRevenue,
    rpg: guestCount ? kpi.productRevenue / guestCount : null,
    addon: addon || 0,
    packages_dollars: kpi.packageSales,
    packages: kpi.packageCount,
    co_enrollment: kpi.membership,
    rebooking_pct: kpi.rebookingPct,
  };
}

export function buildStudioMTDRow({ kpi, attendanceHours, addon }, start, end) {
  const guestCount = kpi.guests;
  const totalHours = attendanceHours || 0;
  const sales = kpi.totalRevenue;
  return {
    start, end,
    label: monthLabel(start),
    guest_count: guestCount,
    new_guests: kpi.newGuests,
    serv_per_guest: kpi.servicesPerInvoice,
    total_services: kpi.totalServices,
    sales,
    service_revenue: kpi.serviceRevenue,
    sales_per_day: sales / daysInclusive(start, end),
    total_discounts: kpi.totalDiscount,
    total_collections: kpi.totalCollection,
    at: kpi.avgInvoiceValue,
    tsth: totalHours ? sales / totalHours : null,
    total_hours: totalHours,
    retail: kpi.productRevenue,
    rpg: guestCount ? kpi.productRevenue / guestCount : null,
    addon: addon || 0,
    packages_dollars: kpi.packageSales,
    packages: kpi.packageCount,
    co_enrollment: kpi.membership,
    rebooking_pct: kpi.rebookingPct,
  };
}

// ---------------------------------------------------------------------------
// Employee weekly / MTD row builders
// ---------------------------------------------------------------------------

export function buildEmployeeRow(cero, hours, start, end, extra = {}) {
  const totalSales = cero.totalSales;
  return {
    start, end, ...extra,
    guests: cero.guests,
    services: cero.services,
    rebook_pct: cero.rebookPct,
    membership: cero.membership,
    service_revenue: cero.serviceRevenue,
    avg_invoice_value: cero.avgInvoiceValue,
    avg_services_per_invoice: cero.avgServicesPerInvoice,
    product_revenue: cero.productRevenue,
    pct_product_invoices: cero.pctProductInvoices,
    total_sales: totalSales,
    total_hours: hours ?? null,
    tsth: hours ? totalSales / hours : null,
  };
}

// ---------------------------------------------------------------------------
// Pay-period bonus calculation
// ---------------------------------------------------------------------------

export function computeBonus({ serviceRev, retail }) {
  const rate = srRate(serviceRev);
  const srBonus = Math.round(serviceRev * rate * 100) / 100;
  const retailBonus = Math.round(retail * 0.10 * 100) / 100;
  return {
    sr_rate: rate,
    sr_bonus: srBonus,
    retail: retail,
    retail_bonus: retailBonus,
    total_bonus: Math.round((srBonus + retailBonus) * 100) / 100,
    tier_remaining: SR_TIER_THRESHOLDS.map(t => Math.round((t - serviceRev) * 100) / 100),
  };
}

// ---------------------------------------------------------------------------
// Merge helpers — append-only storage, "current" is derived at read time
// ---------------------------------------------------------------------------

export function upsertByStart(list, row) {
  const idx = list.findIndex(r => r.start === row.start);
  if (idx === -1) list.push(row);
  else list[idx] = row;
  list.sort((a, b) => (a.start < b.start ? -1 : 1));
  return list;
}

export function upsertMonthTotal(list, row) {
  const idx = list.findIndex(r => r.label === row.label);
  if (idx === -1) list.push(row);
  else list[idx] = row;
  list.sort((a, b) => (a.start < b.start ? -1 : 1));
  return list;
}

// Given all weekly rows ever uploaded and the label of the latest MTD upload,
// returns just the weeks that belong to that in-progress month (including the
// boundary week that starts in the prior month but ends in this one).
export function getCurrentWeeks(allWeeks, currentMonthKey) {
  if (!currentMonthKey) return [];
  return allWeeks
    .filter(w => monthKey(w.end) === currentMonthKey || monthKey(w.start) === currentMonthKey)
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Combining studio rows across one or more studios (dashboard views)
// ---------------------------------------------------------------------------

function combineFields(rows, fields) {
  const row = {};
  fields.forEach(f => (row[f] = 0));
  let invoicesFromAt = 0, rebookWeighted = 0, rebookGuests = 0, hasData = false;
  rows.forEach(r => {
    if (r.guest_count !== null && r.guest_count !== undefined) hasData = true;
    fields.forEach(f => { if (r[f] !== null && r[f] !== undefined) row[f] += r[f]; });
    if (r.at) invoicesFromAt += r.sales / r.at;
    if (r.rebooking_pct !== null && r.rebooking_pct !== undefined && r.guest_count) {
      rebookWeighted += r.rebooking_pct * r.guest_count;
      rebookGuests += r.guest_count;
    }
  });
  return { row, invoicesFromAt, rebookWeighted, rebookGuests, hasData };
}

const SUM_FIELDS = [
  'guest_count', 'new_guests', 'total_services', 'sales', 'total_discounts',
  'total_collections', 'total_hours', 'retail', 'addon', 'packages_dollars',
  'packages', 'co_enrollment',
];

export function combineWeeks(studioData, studios, currentMonthKey) {
  const map = {};
  studios.forEach(st => {
    const weeks = getCurrentWeeks(studioData[st]?.all_weeks || [], currentMonthKey);
    weeks.forEach(w => {
      if (w.start > w.end) return; // guard against a mistyped date
      if (!map[w.start]) map[w.start] = { start: w.start, end: w.end, rows: [] };
      map[w.start].rows.push(w);
      if (w.newly_added) map[w.start].newly_added = true;
    });
  });
  return Object.values(map)
    .sort((a, b) => (a.start < b.start ? -1 : 1))
    .map(({ start, end, rows, newly_added }) => {
      const { row, invoicesFromAt, rebookWeighted, rebookGuests, hasData } = combineFields(rows, SUM_FIELDS);
      return {
        ...row, start, end, newly_added, has_data: hasData,
        serv_per_guest: row.guest_count ? row.total_services / row.guest_count : null,
        at: invoicesFromAt ? row.sales / invoicesFromAt : null,
        tsth: row.total_hours ? row.sales / row.total_hours : null,
        rpg: row.guest_count ? row.retail / row.guest_count : null,
        sales_per_day: row.sales ? row.sales / 7 : null,
        rebooking_pct: rebookGuests ? rebookWeighted / rebookGuests : null,
      };
    });
}

export function combineMonths(studioData, studios) {
  const byLabel = {};
  studios.forEach(st => {
    (studioData[st]?.month_totals || []).forEach(m => {
      if (!byLabel[m.label]) byLabel[m.label] = [];
      byLabel[m.label].push(m);
    });
  });
  return Object.entries(byLabel)
    .map(([label, rows]) => {
      const { row, invoicesFromAt, rebookWeighted, rebookGuests } = combineFields(rows, SUM_FIELDS);
      return {
        ...row, label, start: rows[0].start, end: rows[0].end,
        serv_per_guest: row.guest_count ? row.total_services / row.guest_count : null,
        at: invoicesFromAt ? row.sales / invoicesFromAt : null,
        tsth: row.total_hours ? row.sales / row.total_hours : null,
        rpg: row.guest_count ? row.retail / row.guest_count : null,
        sales_per_day: row.sales ? row.sales / daysInclusive(rows[0].start, rows[0].end) : null,
        rebooking_pct: rebookGuests ? rebookWeighted / rebookGuests : null,
      };
    })
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Pacing / month-comparison (ported from lib/pacingData.js)
// ---------------------------------------------------------------------------

function shiftMonthKey(mKey, offsetMonths) {
  const [y, m] = mKey.split('-').map(Number);
  const d = new Date(y, m - 1 + offsetMonths, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Sums a metric's underlying month-total row across the given studios for one
// calendar month. TSTH is derived from combined sales/hours (not averaged),
// since averaging a ratio across studios of different sizes isn't meaningful.
function monthTotals(studioData, studios, mKey) {
  const label = monthLabel(mKey + '-01');
  let sales = 0, hours = 0, newGuests = 0, collections = 0, found = false;
  studios.forEach(st => {
    const row = (studioData[st]?.month_totals || []).find(m => m.label === label);
    if (!row) return;
    found = true;
    sales += row.sales || 0;
    hours += row.total_hours || 0;
    newGuests += row.new_guests || 0;
    collections += row.total_collections || 0;
  });
  if (!found) return null;
  return {
    tsth: hours ? Math.round((sales / hours) * 100) / 100 : null,
    total_hours: Math.round(hours * 10) / 10,
    new_guests: newGuests,
    total_collections: collections,
  };
}

export const PACING_PERIODS = [
  { key: 'current', color: '#F2790C' },
  { key: 'lastMonth', color: '#8A6D3B' },
  { key: 'lastYear', color: '#5C7A5A' },
];

// Returns { current: {label, data}, lastMonth: {label, data}, lastYear: {label, data} }
export function buildMonthlyComparison(studioData, studios, currentMonthKey) {
  const lastMonthKey = shiftMonthKey(currentMonthKey, -1);
  const lastYearKey = shiftMonthKey(currentMonthKey, -12);

  const current = monthTotals(studioData, studios, currentMonthKey);
  const lastMonth = monthTotals(studioData, studios, lastMonthKey);
  const lastYear = monthTotals(studioData, studios, lastYearKey);

  return {
    current: { label: `${monthLabel(currentMonthKey + '-01')} (MTD)`, data: current },
    lastMonth: { label: monthLabel(lastMonthKey + '-01'), data: lastMonth },
    lastYear: { label: monthLabel(lastYearKey + '-01'), data: lastYear },
  };
}

// ---------------------------------------------------------------------------
// Memberships snapshot summary (ported from lib/membershipsCompute.js)
// ---------------------------------------------------------------------------

function emptyCounts() {
  return { activeCount: 0, cancelledCount: 0, suspendedCount: 0, otherCount: 0, projectedRevenue: 0, cancelledRevenue: 0 };
}

// Zenoti dates in this report come as US-format strings like "7/1/2026".
// Returns a "YYYY-MM" key for calendar-month comparison, or null if unparseable.
function monthKeyFromUSDate(s) {
  if (!s) return null;
  const parts = String(s).split('/');
  if (parts.length !== 3) return null;
  const [m, , y] = parts.map(Number);
  if (!m || !y) return null;
  return `${y}-${String(m).padStart(2, '0')}`;
}

// Builds the snapshot summary (per studio + total) for a Memberships MTD
// upload. "New Memberships" and "Newly Cancelled" are both scoped to the
// snapshot's own calendar month — determined directly from each record's
// Start Date (for new) or Recurrence Cancellation / Termination Date (for
// cancelled) — rather than by comparing against a previous upload. That
// means these lists are always "this month's" activity and naturally reset
// once you start uploading next month's MTD report, with no extra logic
// needed to clear anything.
export function buildMembershipSnapshot(records, snapshotDate) {
  const snapshotMonthKey = snapshotDate.slice(0, 7);

  const byStudio = {};
  MEMB_STUDIOS.forEach(s => (byStudio[s] = emptyCounts()));
  const total = emptyCounts();

  const newlyCancelled = [];
  const newMemberships = [];

  for (const r of records) {
    const bucket = byStudio[r.studio] || (byStudio[r.studio] = emptyCounts());
    const status = (r.status || '').toLowerCase();

    if (status === 'active') {
      bucket.activeCount += 1;
      total.activeCount += 1;
      bucket.projectedRevenue += r.sales || 0;
      total.projectedRevenue += r.sales || 0;
    } else if (status === 'cancelled') {
      bucket.cancelledCount += 1;
      total.cancelledCount += 1;
      bucket.cancelledRevenue += r.sales || 0;
      total.cancelledRevenue += r.sales || 0;
    } else if (status === 'suspended') {
      bucket.suspendedCount += 1;
      total.suspendedCount += 1;
    } else {
      bucket.otherCount += 1;
      total.otherCount += 1;
    }

    if (monthKeyFromUSDate(r.startDate) === snapshotMonthKey) {
      newMemberships.push({
        guestName: r.guestName, membershipName: r.membershipName, studio: r.studio,
        sales: standardMembershipPrice(r.studio, r.membershipName, r.sales),
      });
    }

    if (status === 'cancelled') {
      const cancelMonthKey = monthKeyFromUSDate(r.cancellationDate) || monthKeyFromUSDate(r.terminationDate);
      if (cancelMonthKey === snapshotMonthKey) {
        newlyCancelled.push({
          guestName: r.guestName, membershipName: r.membershipName, studio: r.studio,
          sales: standardMembershipPrice(r.studio, r.membershipName, r.sales),
        });
      }
    }
  }

  Object.values(byStudio).forEach(b => {
    b.projectedRevenue = Math.round(b.projectedRevenue * 100) / 100;
    b.cancelledRevenue = Math.round(b.cancelledRevenue * 100) / 100;
  });
  total.projectedRevenue = Math.round(total.projectedRevenue * 100) / 100;
  total.cancelledRevenue = Math.round(total.cancelledRevenue * 100) / 100;

  return {
    date: snapshotDate,
    monthLabel: monthLabel(snapshotMonthKey + '-01'),
    byStudio,
    total,
    newlyCancelled,
    newMemberships,
    recordCount: records.length,
  };
}

// ---------------------------------------------------------------------------
// Collections (Club Orange) summary (ported from lib/collectionsCompute.js)
// ---------------------------------------------------------------------------

function parseUSDate(s) {
  if (!s) return null;
  const parts = String(s).split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(Number);
  if (!m || !d || !y) return null;
  return { m, d, y };
}

function emptyAgg() {
  return { billed: 0, collected: 0, due: 0, count: 0, pendingCount: 0, failedCount: 0 };
}

function addRecord(agg, r) {
  agg.billed += r.salesIncTax || 0;
  agg.collected += r.amountCollected || 0;
  agg.due += r.due || 0;
  agg.count += 1;
  if (r.collectionStatus === 'Pending') agg.pendingCount += 1;
  if (r.collectionStatus === 'Failed') agg.failedCount += 1;
}

function finalizeAgg(agg) {
  agg.billed = Math.round(agg.billed * 100) / 100;
  agg.collected = Math.round(agg.collected * 100) / 100;
  agg.due = Math.round(agg.due * 100) / 100;
  agg.rate = agg.billed > 0 ? Math.round((agg.collected / agg.billed) * 1000) / 10 : null;
  return agg;
}

function combineAgg(a, b) {
  return {
    billed: a.billed + b.billed,
    collected: a.collected + b.collected,
    due: a.due + b.due,
    count: a.count + b.count,
    pendingCount: a.pendingCount + b.pendingCount,
    failedCount: a.failedCount + b.failedCount,
  };
}

function emptyBucket(key) {
  return { key, label: monthLabel(key + '-01'), full: emptyAgg(), pull1: emptyAgg(), pull15: emptyAgg(), byStudio: {} };
}

// Builds the full Collections summary from every raw record on file:
//   - one row per calendar month, each with a "full month" total, a
//     "1st pull" total (1st-5th, when the start-of-month charge goes out),
//     a "15th pull" total (15th-20th, the mid-month charge), a "both pulls"
//     total (1st pull + 15th pull combined — the two totals a card is
//     actually charged, as opposed to "full month" which also picks up any
//     stray non-pull-day activity), and a per-studio breakdown for that month
//   - a ranked list of decline reasons across everything on file
// This recomputes from scratch every time rather than storing running
// totals, since a later upload can change an earlier row's outcome (e.g. a
// "Pending" retry that later succeeds or hard-declines).
export function buildCollectionsSummary(records) {
  const byMonth = {};

  for (const r of records) {
    const mk = monthKeyFromUSDate(r.saleDate);
    if (!mk) continue;
    if (!byMonth[mk]) byMonth[mk] = emptyBucket(mk);
    const bucket = byMonth[mk];
    addRecord(bucket.full, r);

    const day = parseUSDate(r.saleDate).d;
    if (day >= 1 && day <= 5) addRecord(bucket.pull1, r);
    if (day >= 15 && day <= 20) addRecord(bucket.pull15, r);

    if (!bucket.byStudio[r.studio]) bucket.byStudio[r.studio] = emptyAgg();
    addRecord(bucket.byStudio[r.studio], r);
  }

  const months = Object.values(byMonth).sort((a, b) => (a.key < b.key ? -1 : 1));
  months.forEach(m => {
    m.bothPulls = combineAgg(m.pull1, m.pull15);
    finalizeAgg(m.full);
    finalizeAgg(m.pull1);
    finalizeAgg(m.pull15);
    finalizeAgg(m.bothPulls);
    Object.values(m.byStudio).forEach(finalizeAgg);
  });

  const declineCounts = {};
  for (const r of records) {
    const isUnresolvedOrFailed = r.collectionStatus === 'Failed' || r.collectionStatus === 'Pending';
    if (isUnresolvedOrFailed && r.declineReason && r.declineReason !== 'Not Declined') {
      declineCounts[r.declineReason] = (declineCounts[r.declineReason] || 0) + 1;
    }
  }
  const declineReasons = Object.entries(declineCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  return { months, declineReasons, recordCount: records.length };
}

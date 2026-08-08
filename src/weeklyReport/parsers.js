import { readFileAsArrayBuffer, readRows, findHeaderAndData, cellByHeader, toNumber, toHours } from './fileReader';
import { CENTER_TO_STUDIO, NON_WAXING_SUBCATEGORIES } from './constants';

// Ported from Lauren's wtc-weekly-report app (lib/parse/*.js). Each parse*
// function here takes a browser File; the original took a Node Buffer.

// ─── KPI report ─────────────────────────────────────────────────────────────
// Parses a Zenoti "KPI_s" report (weekly or MTD — same shape either way) into
// per-studio totals. Ignores the "Grand Total" row.
export async function parseKPI(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const rows = readRows(buffer, file.name);
  const { headers, dataRows } = findHeaderAndData(rows, 'Column Name');

  const out = {};
  for (const row of dataRows) {
    const center = cellByHeader(headers, row, 'Column Name');
    const studio = CENTER_TO_STUDIO[center];
    if (!studio) continue; // skips "Grand Total" and anything unrecognized

    out[studio] = {
      guests: toNumber(cellByHeader(headers, row, '# Guests')),
      newGuests: toNumber(cellByHeader(headers, row, '# New Guests')),
      servicesPerInvoice: toNumber(cellByHeader(headers, row, 'Average # Services per Invoice')),
      totalServices: toNumber(cellByHeader(headers, row, '# Services')),
      totalRevenue: toNumber(cellByHeader(headers, row, 'Total Revenue ')) || toNumber(cellByHeader(headers, row, 'Total Revenue')),
      serviceRevenue: toNumber(cellByHeader(headers, row, 'Service Revenue')),
      totalDiscount: toNumber(cellByHeader(headers, row, 'Total Discount')),
      totalCollection: toNumber(cellByHeader(headers, row, 'Total Collection')),
      avgInvoiceValue: toNumber(cellByHeader(headers, row, 'Average Invoice Value')),
      productRevenue: toNumber(cellByHeader(headers, row, 'Product Revenue')),
      packageSales: toNumber(cellByHeader(headers, row, 'Package Sales')),
      packageCount: toNumber(cellByHeader(headers, row, '# Package')),
      membership: toNumber(cellByHeader(headers, row, '# Membership')),
      rebookingPct: toNumber(cellByHeader(headers, row, '% Rebooking Source')) / 100,
    };
  }
  return out;
}

// ─── Attendance report ──────────────────────────────────────────────────────
// Parses a Zenoti "Attendance" report (weekly CSV or MTD XLSX) into total
// Actual Hours, both by studio and by individual employee name.
export async function parseAttendance(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const rows = readRows(buffer, file.name);
  const { headers, dataRows } = findHeaderAndData(rows, 'Employee Name');

  const byStudio = {};
  const byEmployee = {};

  for (const row of dataRows) {
    const name = cellByHeader(headers, row, 'Employee Name');
    const center = cellByHeader(headers, row, 'Work Center');
    if (!name || !center) continue;

    const hours = toHours(cellByHeader(headers, row, 'Actual Hours'));
    const studio = CENTER_TO_STUDIO[center];
    if (studio) byStudio[studio] = (byStudio[studio] || 0) + hours;

    const cleanName = name.trim();
    byEmployee[cleanName] = (byEmployee[cleanName] || 0) + hours;
  }

  return { byStudio, byEmployee };
}

// ─── Sales-Accrual report ───────────────────────────────────────────────────
// Parses a Zenoti "Sales-Accrual" report (weekly CSV or MTD XLSX). Add-On
// Services = net sales (Sales Exc. Tax) of non-waxing subcategories only.
export async function parseSalesAccrual(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const rows = readRows(buffer, file.name);
  const { headers, dataRows } = findHeaderAndData(rows, 'Item Name');

  const addonByStudio = {};

  for (const row of dataRows) {
    const subcat = cellByHeader(headers, row, 'Item Subcategory');
    if (!NON_WAXING_SUBCATEGORIES.includes(subcat)) continue;

    const center = cellByHeader(headers, row, 'Center Name');
    const studio = CENTER_TO_STUDIO[center];
    if (!studio) continue;

    const netSales = toNumber(cellByHeader(headers, row, 'Sales (Exc. Tax)'));
    addonByStudio[studio] = (addonByStudio[studio] || 0) + netSales;
  }

  return { addonByStudio };
}

// ─── Cerologist Journey Sheet KPIs ──────────────────────────────────────────
// Zenoti's employee codes are prefixed by studio: DENW = Concord,
// DEWIP = Pike Creek, PAM = Media. Non-employee rows (POS buckets, house
// sale, grand total) are skipped.
function studioFromCode(code) {
  if (code.startsWith('DENW')) return 'Concord';
  if (code.startsWith('DEWIP')) return 'Pike Creek';
  if (code.startsWith('PAM')) return 'Media';
  return null;
}

// Parses a Zenoti "Cerologist Journey Sheet KPIs" report (weekly or MTD —
// same shape) into per-employee metrics.
export async function parseCerologistKPI(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const rows = readRows(buffer, file.name);
  const { headers, dataRows } = findHeaderAndData(rows, 'Column Name');

  const out = {};
  for (const row of dataRows) {
    const col = cellByHeader(headers, row, 'Column Name');
    if (!col) continue;
    const match = col.match(/^\(([^)]*)\)\s*(.*)$/);
    if (!match) continue;
    const [, code, rawName] = match;
    const name = rawName.trim();
    if (!code || !name || name === 'House Sale') continue;

    const studio = studioFromCode(code);
    if (!studio) continue; // skips PAME_POS and anything unrecognized

    const serviceRevenue = toNumber(cellByHeader(headers, row, 'Service Revenue'));
    const productRevenue = toNumber(cellByHeader(headers, row, 'Product Revenue'));

    out[name] = {
      studio,
      guests: toNumber(cellByHeader(headers, row, '# Guests')),
      services: toNumber(cellByHeader(headers, row, '# Services')),
      rebookPct: toNumber(cellByHeader(headers, row, '% Rebooking Source')) / 100,
      membership: toNumber(cellByHeader(headers, row, '# Membership')),
      serviceRevenue,
      avgInvoiceValue: toNumber(cellByHeader(headers, row, 'Average Invoice Value')),
      avgServicesPerInvoice: toNumber(cellByHeader(headers, row, 'Average # Services per Invoice')),
      productRevenue,
      pctProductInvoices: toNumber(cellByHeader(headers, row, '% Product/Total Invoices')) / 100,
      totalSales: serviceRevenue + productRevenue,
    };
  }
  return out;
}

// ─── Memberships export (point-in-time snapshot) ───────────────────────────
// Parses a Zenoti "Memberships" export into a flat list of membership line
// items. Each row is one membership (a guest can have more than one).
export async function parseMemberships(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const rows = readRows(buffer, file.name);
  const { headers, dataRows } = findHeaderAndData(rows, 'Invoice No');

  const out = [];
  for (const row of dataRows) {
    const center = cellByHeader(headers, row, 'Sale Center');
    const studio = CENTER_TO_STUDIO[center];
    if (!studio) continue;

    out.push({
      invoiceNo: cellByHeader(headers, row, 'Invoice No'),
      studio,
      guestName: cellByHeader(headers, row, 'Guest Name'),
      membershipName: cellByHeader(headers, row, 'Membership Name'),
      sales: toNumber(cellByHeader(headers, row, 'Sales')),
      status: cellByHeader(headers, row, 'Membership Status'),
      recurrenceStatus: cellByHeader(headers, row, 'Recurrence Status'),
      nextRecurrenceDate: cellByHeader(headers, row, 'Next Recurrence Date'),
      startDate: cellByHeader(headers, row, 'Start Date'),
      terminationDate: cellByHeader(headers, row, 'Membership Termination Date'),
      cancellationDate: cellByHeader(headers, row, 'Recurrence Cancellation Date'),
    });
  }
  return out;
}

// ─── Memberships Payment export (Club Orange collections) ─────────────────
// Parses a Zenoti "Memberships Payment" export (per-attempt billing/collection
// detail: what was billed on a given Sale Date, what actually got collected,
// and why anything didn't). Different from the plain "Memberships" export
// above (a point-in-time snapshot with no collection outcome) — this file is
// what tells you whether a recurring charge actually succeeded.
export async function parseCollections(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const rows = readRows(buffer, file.name);
  const { headers, dataRows } = findHeaderAndData(rows, 'Invoice No');

  const out = [];
  for (const row of dataRows) {
    const center = cellByHeader(headers, row, 'Sale Center');
    const studio = CENTER_TO_STUDIO[center];
    if (!studio) continue;

    const saleDate = cellByHeader(headers, row, 'Sale Date');
    const invoiceNo = cellByHeader(headers, row, 'Invoice No');
    if (!saleDate || !invoiceNo) continue;

    out.push({
      // One invoice can appear again on a later export as its dunning status
      // changes (Pending -> Collected/Failed) — invoiceNo+saleDate is stable
      // and lets a later upload overwrite the earlier, stale outcome.
      key: `${invoiceNo}|${saleDate}`,
      invoiceNo,
      studio,
      guestName: cellByHeader(headers, row, 'Guest Name'),
      membershipName: cellByHeader(headers, row, 'Membership Name'),
      saleDate,
      collectionStatus: cellByHeader(headers, row, 'Collection Status'),
      salesIncTax: toNumber(cellByHeader(headers, row, 'Sales(Inc. Tax)')),
      amountCollected: toNumber(cellByHeader(headers, row, 'Amount Collected')),
      due: toNumber(cellByHeader(headers, row, 'Due')),
      declineReason: cellByHeader(headers, row, 'Decline Reason'),
      totalTries: toNumber(cellByHeader(headers, row, 'Total Tries')),
    });
  }
  return out;
}

// ─── Guest Retention export ─────────────────────────────────────────────────
// Parses a Zenoti "Guest Retention" export (Retention By = Cerologist) into
// per-studio, per-cerologist retention rows.
export async function parseGuestRetention(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const rows = readRows(buffer, file.name);
  const { headers, dataRows } = findHeaderAndData(rows, 'Cerologist Name');

  const byStudio = {};
  for (const row of dataRows) {
    const center = cellByHeader(headers, row, 'Center Name');
    const studio = CENTER_TO_STUDIO[center];
    if (!studio) continue;

    const entry = {
      cerologistName: cellByHeader(headers, row, 'Cerologist Name'),
      newGuests: toNumber(cellByHeader(headers, row, '# of New Guests')),
      newRetainedSame: toNumber(cellByHeader(headers, row, 'New Guests Retained(same Cerologist)')),
      newRetainedOther: toNumber(cellByHeader(headers, row, 'New Guests Retained(other Cerologist)')),
      newRetentionPct: toNumber(cellByHeader(headers, row, 'Retained New Guests(%)')),
      repeatGuests: toNumber(cellByHeader(headers, row, '# of Repeat Guests')),
      repeatRetainedSame: toNumber(cellByHeader(headers, row, 'Repeat Guests Retained(same Cerologist)')),
      repeatRetainedOther: toNumber(cellByHeader(headers, row, 'Repeat Guests Retained(other Cerologist)')),
      repeatRetentionPct: toNumber(cellByHeader(headers, row, 'Retained Repeat Guests(%)')),
    };

    if (!byStudio[studio]) byStudio[studio] = [];
    byStudio[studio].push(entry);
  }
  return byStudio;
}

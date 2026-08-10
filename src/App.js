import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Tooltip, Legend
} from 'chart.js';
import {
  loadPeriods, savePeriod, isConfigured,
  loadAttendanceEntries, loadSalesEntries, replaceAttendanceRange, replaceSalesRange,
  deleteAllAttendance, deleteAllSales,
} from './db';
import { parseAttendanceFile, parseEmployeeSalesFile, parseStoreCollectionFile, normalizeEmployeeName, decimalToHoursDisplay, COLLECTION_CATEGORIES } from './parser';
import { STORE_ROSTER } from './storeRoster';
import { getHourlyRate, totalPay } from './hourlyRates';
import WeeklyReportTab from './weeklyReport/WeeklyReportTab';
import { emptyWeeklyReportData, WEEKLY_REPORT_KEY } from './weeklyReport/store';
import './App.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const fmt$ = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtRate = n => (n == null ? '—' : `$${n.toFixed(2)} TSTH`);

function pctChange(curr, prev) {
  if (!prev) return null;
  return ((curr - prev) / Math.abs(prev) * 100).toFixed(1);
}

function Badge({ curr, prev }) {
  const pct = pctChange(curr, prev);
  if (pct === null || isNaN(pct)) return null;
  const up = parseFloat(pct) >= 0;
  return <span className={`badge ${up ? 'badge-up' : 'badge-dn'}`}>{up ? '+' : ''}{pct}%</span>;
}

// ─── Row-level data: every Attendance/Employee Sales row carries its own ───
// ─── date, so "a period" is just whatever range is picked — no period ──────
// ─── objects, no matching, no combining multiple uploads by hand ───────────
function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fmtDateShort(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function rangeLabel(range) {
  if (!range?.from || !range?.to) return 'No range selected';
  return `${fmtDateShort(range.from)} – ${fmtDateShort(range.to)}`;
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Sum raw attendance rows in [from, to] per employee.
function aggregateAttendance(rows, from, to) {
  if (!from || !to) return null;
  const byName = new Map();
  rows.filter(r => r.workDate >= from && r.workDate <= to).forEach(r => {
    const key = normalizeEmployeeName(r.employeeName);
    const cur = byName.get(key) || { name: r.employeeName, hoursDecimal: 0 };
    cur.hoursDecimal += r.hoursDecimal;
    byName.set(key, cur);
  });
  const employees = Array.from(byName.values()).map(e => ({
    name: e.name,
    hoursDecimal: Math.round(e.hoursDecimal * 100) / 100,
    hoursDisplay: decimalToHoursDisplay(e.hoursDecimal),
  }));
  const totalHoursDecimal = Math.round(employees.reduce((s, e) => s + e.hoursDecimal, 0) * 100) / 100;
  return { totalHoursDecimal, totalHoursDisplay: decimalToHoursDisplay(totalHoursDecimal), employees };
}

// Sum raw sales rows in [from, to] per employee. Every non-Service item type
// (Product, Membership, Package, Gift Card, ...) rolls into "retail sales",
// matching the old app's two-bucket Service vs. Product split.
function aggregateSales(rows, from, to) {
  if (!from || !to) return null;
  const byName = new Map();
  rows.filter(r => r.saleDate >= from && r.saleDate <= to).forEach(r => {
    const key = normalizeEmployeeName(r.employeeName);
    const cur = byName.get(key) || { name: r.employeeName, serviceRevenue: 0, retailSales: 0 };
    if (r.itemType === 'Service') cur.serviceRevenue += r.saleAmount;
    else cur.retailSales += r.saleAmount;
    byName.set(key, cur);
  });
  const employees = Array.from(byName.values()).map(e => ({
    name: e.name,
    serviceRevenue: Math.round(e.serviceRevenue * 100) / 100,
    retailSales: Math.round(e.retailSales * 100) / 100,
  }));
  return {
    totalServiceRevenue: Math.round(employees.reduce((s, e) => s + e.serviceRevenue, 0) * 100) / 100,
    totalRetailSales: Math.round(employees.reduce((s, e) => s + e.retailSales, 0) * 100) / 100,
    employees,
  };
}

// Default comparison on first load: the most recent 7 days present in either
// dataset, vs. the 7 days before that.
function computeDefaultCompareRange(attendanceRows, salesRows) {
  const allDates = [...attendanceRows.map(r => r.workDate), ...salesRows.map(r => r.saleDate)].sort();
  const empty = { a: { from: '', to: '' }, b: { from: '', to: '' } };
  if (!allDates.length) return empty;
  const bTo = new Date(allDates[allDates.length - 1] + 'T00:00:00');
  const bFrom = new Date(bTo); bFrom.setDate(bFrom.getDate() - 6);
  const aTo = new Date(bFrom); aTo.setDate(aTo.getDate() - 1);
  const aFrom = new Date(aTo); aFrom.setDate(aFrom.getDate() - 6);
  return { a: { from: toISODate(aFrom), to: toISODate(aTo) }, b: { from: toISODate(bFrom), to: toISODate(bTo) } };
}

// ─── Merge one range's attendance + sales aggregates into a single ────────
// ─── comparable dataset ─────────────────────────────────────────────────────
function mergePeriod(hours, sales) {
  if (!hours && !sales) return null;
  const map = new Map();

  (hours?.employees || []).forEach(e => {
    map.set(normalizeEmployeeName(e.name), {
      name: e.name, hoursDecimal: e.hoursDecimal, hoursDisplay: e.hoursDisplay, serviceRevenue: null, retailSales: null,
    });
  });
  (sales?.employees || []).forEach(e => {
    const key = normalizeEmployeeName(e.name);
    const existing = map.get(key);
    if (existing) { existing.serviceRevenue = e.serviceRevenue; existing.retailSales = e.retailSales; }
    else map.set(key, { name: e.name, hoursDecimal: null, hoursDisplay: null, serviceRevenue: e.serviceRevenue, retailSales: e.retailSales });
  });

  const allEmployees = Array.from(map.values()).map(e => ({
    ...e,
    revPerHour: (e.hoursDecimal > 0 && e.serviceRevenue != null) ? e.serviceRevenue / e.hoursDecimal : null,
  }));

  // Only employees with BOTH an hours record and a sales record for this
  // period count toward the metrics — partial data is excluded entirely
  // rather than shown with blanks.
  const employees = allEmployees
    .filter(e => e.hoursDecimal != null && e.serviceRevenue != null)
    .sort((a, b) => (b.serviceRevenue ?? -1) - (a.serviceRevenue ?? -1));

  const hoursOnly = allEmployees.filter(e => e.hoursDecimal != null && e.serviceRevenue == null).map(e => e.name);
  const salesOnly = allEmployees.filter(e => e.serviceRevenue != null && e.hoursDecimal == null).map(e => e.name);

  const totalHours = hours ? hours.totalHoursDecimal : null;
  const totalRevenue = sales ? sales.totalServiceRevenue : null;
  const totalRetailSales = sales ? sales.totalRetailSales : null;
  const totalRevPerHour = (totalHours && totalRevenue != null && totalHours > 0) ? totalRevenue / totalHours : null;
  const totalSalesAll = (totalRevenue || 0) + (totalRetailSales || 0);

  const totalPayroll = employees.reduce((sum, e) => {
    const rate = getHourlyRate(e.name);
    const pay = totalPay(e.hoursDecimal, rate, e.retailSales);
    return pay != null ? sum + pay : sum;
  }, 0);
  const payrollPct = totalSalesAll > 0 ? totalPayroll / totalSalesAll : null;

  return {
    totalHours,
    totalHoursDisplay: hours?.totalHoursDisplay || null,
    totalRevenue,
    totalRetailSales,
    totalSalesAll,
    totalRevPerHour,
    totalPayroll,
    payrollPct,
    employees,
    hoursOnly,
    salesOnly,
    hasHours: !!(hours && hours.employees.length),
    hasSales: !!(sales && sales.employees.length),
    complete: !!(hours && hours.employees.length) && !!(sales && sales.employees.length),
  };
}

// ─── P&L: fixed monthly expenses (entered once per store, reused every ────
// ─── period until changed) plus store-level income/payroll rollups ────────
const FIXED_EXPENSE_FIELDS = [
  { key: 'rent', label: 'Rent (Occupancy Cost)' },
  { key: 'utilities', label: 'Utilities' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'licenses', label: 'Licenses & Permits' },
  { key: 'alarmMonitoring', label: 'Alarm Monitoring' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'bankFees', label: 'Bank Fees' },
  { key: 'infoSystems', label: 'Information Systems' },
  { key: 'supplies', label: 'Supplies' },
  { key: 'advertising', label: 'Advertising' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'paidouts', label: 'Paidouts' },
  { key: 'refunds', label: 'Refunds' },
];

// Compensation still comes from the Hours + Sales files (hours * rate, plus
// a 10% commission on retail sales, all with an 8% payroll tax on top —
// see totalPay in hourlyRates.js). storeName === null means every store
// combined.
function storePayroll(merged, storeName) {
  if (!merged) return 0;
  if (storeName == null) return merged.totalPayroll || 0;
  const emps = merged.employees.filter(e => STORE_ROSTER.storeByName[normalizeEmployeeName(e.name)] === storeName);
  return emps.reduce((sum, e) => {
    const rate = getHourlyRate(e.name);
    const pay = totalPay(e.hoursDecimal, rate, e.retailSales);
    return pay != null ? sum + pay : sum;
  }, 0);
}

// Income comes from the store collection summary report (Total Collection),
// broken into the six categories that sum to it. storeName === null uses
// the report's own Grand Total row rather than re-summing the three stores
// (same number either way — verified against a real export — but this is
// the more authoritative source).
function storeIncome(collections, storeName) {
  const entry = storeName == null ? collections?.grandTotal : collections?.stores?.[storeName];
  const values = {};
  let total = 0;
  COLLECTION_CATEGORIES.forEach(c => {
    const v = entry?.[c.key] || 0;
    values[c.key] = v;
    total += v;
  });
  return { values, total };
}

// Franchise royalty: always exactly 6% of Total Collection (income), never a
// manually-entered/editable amount — recomputed live from whatever
// collections were actually uploaded so it can't drift or go stale.
const ROYALTY_RATE = 0.06;
function storeRoyalties(income) {
  return income * ROYALTY_RATE;
}

// storeName === null sums that one category across every store (used for
// the combined statement); otherwise it's just that store's saved value.
function fixedExpenseCategoryValue(fixedExpenses, storeName, key) {
  if (storeName == null) {
    return STORE_ROSTER.stores.reduce((sum, s) => sum + fixedExpenseCategoryValue(fixedExpenses, s.name, key), 0);
  }
  return Number(fixedExpenses?.[storeName]?.[key]) || 0;
}

function fixedExpenseTotal(fixedExpenses, storeName) {
  return FIXED_EXPENSE_FIELDS.reduce((sum, f) => sum + fixedExpenseCategoryValue(fixedExpenses, storeName, f.key), 0);
}

// Seeded from the real per-store numbers in the March 2026 Contribution
// Report (Rent = Occupancy Cost Rent, Information Systems = tech fees).
// Used only to fill in a store the first time it has no saved values —
// once saved (even unchanged), the user's own numbers take over.
const DEFAULT_FIXED_EXPENSES = {
  CONCORD: {
    rent: 5336.66, utilities: 847.4, insurance: 309.89, licenses: 0, alarmMonitoring: 0,
    accounting: 0, bankFees: 156.36, infoSystems: 799, supplies: 210.4,
    advertising: 2606.61, maintenance: 0, paidouts: 28.24, refunds: 0,
  },
  MEDIA: {
    rent: 6038.33, utilities: 848, insurance: 309.89, licenses: 0, alarmMonitoring: 0,
    accounting: 0, bankFees: 373.93, infoSystems: 846.94, supplies: 1324.82,
    advertising: 3062.82, maintenance: 55, paidouts: 90, refunds: 0,
  },
  'PIKE CREEK': {
    rent: 5895.71, utilities: 1079.45, insurance: 309.89, licenses: 0, alarmMonitoring: 0,
    accounting: 0, bankFees: 496.04, infoSystems: 799, supplies: 1470.49,
    advertising: 3056.87, maintenance: 55, paidouts: 154.84, refunds: 0,
  },
};

// ─── Overview headline: side-by-side comparison of the more productive ─────
// ─── period (higher revenue per labor hour) ─────────────────────────────────
function BalanceScale({ leftLabel, rightLabel, leftValue, rightValue }) {
  return (
    <div className="balance">
      <div className="balance-labels">
        <div className="balance-side">
          <span className="balance-side-label">{leftLabel}</span>
          <span className="balance-side-value">{fmtRate(leftValue)}</span>
        </div>
        <span className="balance-vs">vs</span>
        <div className="balance-side">
          <span className="balance-side-label">{rightLabel}</span>
          <span className="balance-side-value">{fmtRate(rightValue)}</span>
        </div>
      </div>
      <p className="balance-caption">TSTH — service revenue earned per labor hour</p>
    </div>
  );
}

// ─── Upload UI ──────────────────────────────────────────────────────────────
function UploadSlot({ inputId, title, hint, accent, fileInfo, uploading, onFile }) {
  return (
    <label htmlFor={inputId} className={`upload-slot upload-slot--${accent} ${fileInfo ? 'upload-slot--filled' : ''}`}>
      <input
        id={inputId} type="file" accept=".xlsx,.xls,.csv"
        onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
      <div className="upload-slot-icon">{uploading ? <span className="spinner small" /> : (fileInfo ? '✓' : '+')}</div>
      <div className="upload-slot-body">
        <p className="upload-slot-title">{title}</p>
        {fileInfo ? (
          <>
            <p className="upload-slot-file">{fileInfo.fileName}</p>
            <p className="upload-slot-sub">{fileInfo.sub}</p>
            <span className="upload-slot-replace">Replace file</span>
          </>
        ) : (
          <p className="upload-slot-hint">{hint}</p>
        )}
      </div>
    </label>
  );
}

// The most recent upload-log entry of a given kind — used only to show
// "here's what's currently loaded" feedback in the upload box. uploadLog is
// stored newest-first.
function mostRecentLogEntry(uploadLog, kind) {
  return uploadLog.find(e => e.kind === kind) || null;
}

function UploadPanel({ uploadLog, collectionsSnapshot, uploadingKind, onFile }) {
  const attendance = mostRecentLogEntry(uploadLog, 'attendance');
  const sales = mostRecentLogEntry(uploadLog, 'sales');
  const hasCollections = collectionsSnapshot && Object.keys(collectionsSnapshot.stores || {}).length > 0;
  return (
    <div className="period-panel">
      <div className="period-panel-head">
        <span className="period-eyebrow">Upload a report</span>
        <p className="upload-panel-hint">Every row already has its own date, so uploads are permanent — upload as many weeks as you want, over time, and the dataset just keeps growing. Re-uploading a week you already loaded corrects it in place instead of duplicating.</p>
      </div>
      <div className="period-slots">
        <UploadSlot
          inputId="upload-attendance"
          title="Attendance"
          hint="Upload the attendance / hours export"
          accent="steel"
          uploading={uploadingKind === 'attendance'}
          fileInfo={attendance ? { fileName: attendance.fileName, sub: `${attendance.rowCount} rows · ${fmtDateShort(attendance.fromDate)} – ${fmtDateShort(attendance.toDate)}` } : null}
          onFile={file => onFile('attendance', file)}
        />
        <UploadSlot
          inputId="upload-sales"
          title="Employee Sales"
          hint="Upload the employee sales export"
          accent="sage"
          uploading={uploadingKind === 'sales'}
          fileInfo={sales ? { fileName: sales.fileName, sub: `${sales.rowCount} rows · ${fmtDateShort(sales.fromDate)} – ${fmtDateShort(sales.toDate)}` } : null}
          onFile={file => onFile('sales', file)}
        />
        <UploadSlot
          inputId="upload-collections"
          title="Store collection summary (for P&L)"
          hint="Upload the store-level KPI/collection export"
          accent="brass"
          uploading={uploadingKind === 'collections'}
          fileInfo={hasCollections ? { fileName: collectionsSnapshot.fileName, sub: `${Object.keys(collectionsSnapshot.stores).length} stores · ${fmt$(collectionsSnapshot.grandTotal?.totalCollection)} total collection` } : null}
          onFile={file => onFile('collections', file)}
        />
      </div>
    </div>
  );
}

// ─── Compare bar: pick the two date ranges every comparison tab uses ───────
function CompareBar({ rangeA, rangeB, onRangeChange, onMonthToDate }) {
  return (
    <div className="compare-bar">
      <div className="compare-range">
        <span className="compare-range-tag compare-range-tag--a">A</span>
        <input type="date" value={rangeA.from} onChange={e => onRangeChange('a', 'from', e.target.value)} />
        <span className="compare-range-sep">–</span>
        <input type="date" value={rangeA.to} onChange={e => onRangeChange('a', 'to', e.target.value)} />
      </div>
      <span className="compare-vs">vs</span>
      <div className="compare-range">
        <span className="compare-range-tag compare-range-tag--b">B</span>
        <input type="date" value={rangeB.from} onChange={e => onRangeChange('b', 'from', e.target.value)} />
        <span className="compare-range-sep">–</span>
        <input type="date" value={rangeB.to} onChange={e => onRangeChange('b', 'to', e.target.value)} />
      </div>
      <button className="btn-ghost btn-sm compare-mtd-btn" onClick={onMonthToDate}>This month vs last month</button>
    </div>
  );
}

// ─── Overview tab ───────────────────────────────────────────────────────────
function PeriodSummaryCard({ label, data, deltaHours, deltaRevenue, deltaRate, deltaPayroll, deltaPayrollPct }) {
  if (!data) {
    return (
      <div className="summary-card summary-card--empty">
        <p className="period-name">{label}</p>
        <p className="empty-note">No uploaded report falls in this date range — check the picker above, or upload one on the Setup tab.</p>
      </div>
    );
  }
  return (
    <div className="summary-card">
      <p className="period-name">{label}</p>
      <div className="summary-row">
        <span className="summary-label">Hours worked</span>
        <span className="summary-value">{data.totalHoursDisplay || '—'}</span>
        {deltaHours != null && <Badge curr={data.totalHours} prev={data.totalHours - deltaHours} />}
      </div>
      <div className="summary-row">
        <span className="summary-label">Service revenue</span>
        <span className="summary-value">{data.totalRevenue != null ? fmt$(data.totalRevenue) : '—'}</span>
        {deltaRevenue != null && <Badge curr={data.totalRevenue} prev={data.totalRevenue - deltaRevenue} />}
      </div>
      <div className="summary-row summary-row--highlight">
        <span className="summary-label">TSTH</span>
        <span className="summary-value">{fmtRate(data.totalRevPerHour)}</span>
        {deltaRate != null && <Badge curr={data.totalRevPerHour} prev={data.totalRevPerHour - deltaRate} />}
      </div>
      <div className="summary-row">
        <span className="summary-label">Total payroll</span>
        <span className="summary-value">{data.totalPayroll != null ? fmt$(data.totalPayroll) : '—'}</span>
        {deltaPayroll != null && <Badge curr={data.totalPayroll} prev={data.totalPayroll - deltaPayroll} />}
      </div>
      <div className="summary-row">
        <span className="summary-label">Payroll %</span>
        <span className="summary-value">{data.payrollPct != null ? `${(data.payrollPct * 100).toFixed(1)}%` : '—'}</span>
        {deltaPayrollPct != null && <Badge curr={data.payrollPct} prev={data.payrollPct - deltaPayrollPct} />}
      </div>
      {!data.complete && (
        <p className="summary-warn">⚠ still missing the {data.hasHours ? 'sales' : 'hours'} file for this period</p>
      )}
    </div>
  );
}

function OverviewTab({ p1, p2, label1, label2 }) {
  const deltaHours = (p1?.totalHours != null && p2?.totalHours != null) ? p2.totalHours - p1.totalHours : null;
  const deltaRevenue = (p1?.totalRevenue != null && p2?.totalRevenue != null) ? p2.totalRevenue - p1.totalRevenue : null;
  const deltaRate = (p1?.totalRevPerHour != null && p2?.totalRevPerHour != null) ? p2.totalRevPerHour - p1.totalRevPerHour : null;
  const deltaPayroll = (p1?.totalPayroll != null && p2?.totalPayroll != null) ? p2.totalPayroll - p1.totalPayroll : null;
  const deltaPayrollPct = (p1?.payrollPct != null && p2?.payrollPct != null) ? p2.payrollPct - p1.payrollPct : null;

  return (
    <div className="tab-content">
      <BalanceScale leftLabel={label1} rightLabel={label2} leftValue={p1?.totalRevPerHour} rightValue={p2?.totalRevPerHour} />
      {deltaRate != null && p1?.totalRevPerHour > 0 && (
        <p className="narrative">
          <strong>{label2}</strong> ran {' '}
          <strong>{fmt$(Math.abs(deltaRate))}/hr {deltaRate >= 0 ? 'more' : 'less'}</strong> productive than <strong>{label1}</strong>
          {' — a '}<strong>{Math.abs((deltaRate / p1.totalRevPerHour) * 100).toFixed(1)}%</strong> {deltaRate >= 0 ? 'improvement' : 'decline'} in sales generated per hour of labor.
        </p>
      )}
      <div className="period-compare-grid">
        <PeriodSummaryCard label={label1} data={p1} />
        <PeriodSummaryCard
          label={label2} data={p2}
          deltaHours={deltaHours} deltaRevenue={deltaRevenue} deltaRate={deltaRate}
          deltaPayroll={deltaPayroll} deltaPayrollPct={deltaPayrollPct}
        />
      </div>
    </div>
  );
}

// ─── Shared row sorting (used by both Employee Performance and By Store) ───
function sortComparisonRows(rows, sortBy) {
  const arr = [...rows];
  if (sortBy === 'delta') {
    arr.sort((a, b) => {
      const da = (a.p2?.revPerHour ?? -Infinity) - (a.p1?.revPerHour ?? -Infinity);
      const db = (b.p2?.revPerHour ?? -Infinity) - (b.p1?.revPerHour ?? -Infinity);
      return (isFinite(db) ? db : -999) - (isFinite(da) ? da : -999);
    });
  } else if (sortBy === 'tsth') {
    arr.sort((a, b) => {
      const ta = Math.max(a.p1?.revPerHour ?? -Infinity, a.p2?.revPerHour ?? -Infinity);
      const tb = Math.max(b.p1?.revPerHour ?? -Infinity, b.p2?.revPerHour ?? -Infinity);
      return (isFinite(tb) ? tb : -999) - (isFinite(ta) ? ta : -999);
    });
  } else if (sortBy === 'revenue') {
    arr.sort((a, b) => ((b.p1?.serviceRevenue || 0) + (b.p2?.serviceRevenue || 0)) - ((a.p1?.serviceRevenue || 0) + (a.p2?.serviceRevenue || 0)));
  } else {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return arr;
}

// ─── Employees tab ──────────────────────────────────────────────────────────
function buildComparisonRows(p1, p2, label1, label2) {
  const map = new Map();
  (p1?.employees || []).forEach(e => {
    map.set(normalizeEmployeeName(e.name), { name: e.name, p1: e, p2: null });
  });
  (p2?.employees || []).forEach(e => {
    const key = normalizeEmployeeName(e.name);
    const existing = map.get(key);
    if (existing) existing.p2 = e;
    else map.set(key, { name: e.name, p1: null, p2: e });
  });
  const all = Array.from(map.values());

  // Only employees with complete (hours + sales) data in BOTH periods show
  // up anywhere — someone present in only one period is excluded entirely.
  const rows = all.filter(r => r.p1 && r.p2);
  const excluded = all
    .filter(r => !(r.p1 && r.p2))
    .map(r => (r.p1 ? `${r.name} (only has data for ${label1})` : `${r.name} (only has data for ${label2})`));

  return { rows, excluded };
}

function periodMetrics(p, rate) {
  if (!p) return null;
  const hours = p.hoursDecimal;
  const serviceRev = p.serviceRevenue ?? 0;
  const retail = p.retailSales ?? 0;
  const totalSales = serviceRev + retail;
  const pay = totalPay(hours, rate, retail);
  const production = pay != null ? totalSales - pay : null;
  const tsthService = (hours > 0) ? serviceRev / hours : null;
  const tsthTotal = (hours > 0) ? totalSales / hours : null;
  const payrollPct = (pay != null && totalSales > 0) ? pay / totalSales : null;
  return { hours, hoursDisplay: p.hoursDisplay, serviceRev, retail, totalSales, pay, production, tsthService, tsthTotal, payrollPct };
}

function avg(values) {
  const v = values.filter(x => x != null && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function LedgerTable({ rows, label1, label2 }) {
  const enriched = rows.map(r => {
    const rate = getHourlyRate(r.name);
    return { ...r, rate, m1: periodMetrics(r.p1, rate), m2: periodMetrics(r.p2, rate) };
  });

  const avgTsth1 = avg(enriched.map(r => r.m1?.tsthService));
  const avgTsthTotal1 = avg(enriched.map(r => r.m1?.tsthTotal));
  const avgPayroll1 = avg(enriched.map(r => r.m1?.payrollPct));
  const avgTsth2 = avg(enriched.map(r => r.m2?.tsthService));
  const avgTsthTotal2 = avg(enriched.map(r => r.m2?.tsthTotal));
  const avgPayroll2 = avg(enriched.map(r => r.m2?.payrollPct));
  const pct = n => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);

  return (
    <div className="ledger-scroll">
      <table className="ledger-table">
        <thead>
          <tr>
            <th className="ledger-name-col">Employee</th>
            <th>Base Pay $</th>
            <th colSpan={9} className="ledger-group-head ledger-group-head--steel">{label1}</th>
            <th colSpan={9} className="ledger-group-head ledger-group-head--sage">{label2}</th>
            <th>Δ TSTH</th>
          </tr>
          <tr className="ledger-subhead">
            <th></th>
            <th></th>
            <th>Actual Hours</th><th>Service Rev</th><th>Retail Sales</th><th>Total Sales</th><th>Pay + Tax + Retail</th><th>Production</th><th>TSTH</th><th>TSTH (Total)</th><th>Payroll %</th>
            <th>Actual Hours</th><th>Service Rev</th><th>Retail Sales</th><th>Total Sales</th><th>Pay + Tax + Retail</th><th>Production</th><th>TSTH</th><th>TSTH (Total)</th><th>Payroll %</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {enriched.map(r => {
            const delta = (r.m1?.tsthService != null && r.m2?.tsthService != null) ? r.m2.tsthService - r.m1.tsthService : null;
            return (
              <tr key={r.name}>
                <td className="ledger-name-col">{r.name}</td>
                <td>{r.rate != null ? `$${r.rate.toFixed(2)}` : '—'}</td>
                <td>{r.m1.hoursDisplay || '—'}</td>
                <td>{fmt$(r.m1.serviceRev)}</td>
                <td>{fmt$(r.m1.retail)}</td>
                <td>{fmt$(r.m1.totalSales)}</td>
                <td>{r.m1.pay != null ? fmt$(r.m1.pay) : '—'}</td>
                <td className={r.m1.production != null && r.m1.production < 0 ? 'ledger-margin-neg' : ''}>{r.m1.production != null ? fmt$(r.m1.production) : '—'}</td>
                <td className="ledger-rate">{fmtRate(r.m1.tsthService)}</td>
                <td className="ledger-rate">{fmtRate(r.m1.tsthTotal)}</td>
                <td>{pct(r.m1.payrollPct)}</td>
                <td>{r.m2.hoursDisplay || '—'}</td>
                <td>{fmt$(r.m2.serviceRev)}</td>
                <td>{fmt$(r.m2.retail)}</td>
                <td>{fmt$(r.m2.totalSales)}</td>
                <td>{r.m2.pay != null ? fmt$(r.m2.pay) : '—'}</td>
                <td className={r.m2.production != null && r.m2.production < 0 ? 'ledger-margin-neg' : ''}>{r.m2.production != null ? fmt$(r.m2.production) : '—'}</td>
                <td className="ledger-rate">{fmtRate(r.m2.tsthService)}</td>
                <td className="ledger-rate">{fmtRate(r.m2.tsthTotal)}</td>
                <td>{pct(r.m2.payrollPct)}</td>
                <td>{delta != null ? <Badge curr={r.m2.tsthService} prev={r.m1.tsthService} /> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="ledger-avg-row">
            <td className="ledger-name-col">Average</td>
            <td></td>
            <td></td><td></td><td></td><td></td><td></td><td></td>
            <td className="ledger-rate">{fmtRate(avgTsth1)}</td>
            <td className="ledger-rate">{fmtRate(avgTsthTotal1)}</td>
            <td>{pct(avgPayroll1)}</td>
            <td></td><td></td><td></td><td></td><td></td><td></td>
            <td className="ledger-rate">{fmtRate(avgTsth2)}</td>
            <td className="ledger-rate">{fmtRate(avgTsthTotal2)}</td>
            <td>{pct(avgPayroll2)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function EmployeesTab({ p1, p2, label1, label2 }) {
  const [sortBy, setSortBy] = useState('delta');
  const { rows, excluded: crossPeriodExcluded } = useMemo(
    () => buildComparisonRows(p1, p2, label1, label2),
    [p1, p2, label1, label2]
  );

  const sorted = useMemo(() => sortComparisonRows(rows, sortBy), [rows, sortBy]);

  const chartRows = useMemo(() => (
    [...rows]
      .filter(r => r.p1?.revPerHour != null || r.p2?.revPerHour != null)
      .sort((a, b) => ((b.p1?.serviceRevenue || 0) + (b.p2?.serviceRevenue || 0)) - ((a.p1?.serviceRevenue || 0) + (a.p2?.serviceRevenue || 0)))
      .slice(0, 12)
  ), [rows]);

  const chartData = {
    labels: chartRows.map(r => r.name),
    datasets: [
      { label: label1, data: chartRows.map(r => r.p1?.revPerHour != null ? Math.round(r.p1.revPerHour * 100) / 100 : null), backgroundColor: '#C25E00', borderRadius: 4 },
      { label: label2, data: chartRows.map(r => r.p2?.revPerHour != null ? Math.round(r.p2.revPerHour * 100) / 100 : null), backgroundColor: '#F2A153', borderRadius: 4 },
    ],
  };
  const chartOpts = {
    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: '#6e655d', font: { size: 11, family: 'Work Sans' }, boxWidth: 12 } },
      tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtRate(ctx.parsed.x)}` } },
    },
    scales: {
      x: { grid: { color: 'rgba(42,36,32,0.06)' }, ticks: { color: '#6e655d', callback: v => '$' + v, font: { size: 10, family: 'IBM Plex Mono' } } },
      y: { grid: { display: false }, ticks: { color: '#2a2420', font: { size: 11, family: 'Work Sans' } } },
    },
  };

  const unmatched = [
    ...(p1?.hoursOnly || []).map(n => `${n} (${label1}: hours logged, no matching sales record)`),
    ...(p1?.salesOnly || []).map(n => `${n} (${label1}: sales logged, no matching hours record)`),
    ...(p2?.hoursOnly || []).map(n => `${n} (${label2}: hours logged, no matching sales record)`),
    ...(p2?.salesOnly || []).map(n => `${n} (${label2}: sales logged, no matching hours record)`),
    ...crossPeriodExcluded,
    ...rows.filter(r => getHourlyRate(r.name) == null).map(r => `${r.name} (no hourly rate on file — check spelling)`),
  ];

  if (!rows.length) {
    return <div className="empty-state"><p className="empty-title">No employees yet</p><p>No uploaded report falls in the picked date range(s) — check the picker above, or upload one on the Setup tab.</p></div>;
  }

  return (
    <div className="tab-content">
      {chartRows.length > 0 && (
        <div className="chart-card">
          <p className="chart-title">TSTH by employee</p>
          <div style={{ height: Math.max(220, chartRows.length * 34 + 60) }}>
            <Bar data={chartData} options={chartOpts} />
          </div>
        </div>
      )}

      <div className="ledger-head-row">
        <p className="section-label" style={{ margin: 0 }}>Full comparison</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="delta">Sort: biggest change in TSTH</option>
          <option value="tsth">Sort: highest TSTH</option>
          <option value="revenue">Sort: total revenue</option>
          <option value="name">Sort: name</option>
        </select>
      </div>

      <LedgerTable rows={sorted} label1={label1} label2={label2} />

      {unmatched.length > 0 && (
        <div className="unmatched-box">
          <p className="unmatched-title">⚠ {unmatched.length} name{unmatched.length > 1 ? 's' : ''} excluded — missing hours or sales data</p>
          <p className="unmatched-hint">These aren't shown anywhere in the metrics because only one of the two reports had them. Usually a spelling difference between the reports, or they didn't work that period:</p>
          <ul>{unmatched.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ─── By Store tab ───────────────────────────────────────────────────────────
function ByStoreTab({ p1, p2, label1, label2 }) {
  const [sortBy, setSortBy] = useState('tsth');
  const { rows } = useMemo(() => buildComparisonRows(p1, p2, label1, label2), [p1, p2, label1, label2]);

  const groups = useMemo(() => {
    const byStore = new Map();
    STORE_ROSTER.stores.forEach(s => byStore.set(s.name, []));
    const unassigned = [];
    rows.forEach(r => {
      const store = STORE_ROSTER.storeByName[normalizeEmployeeName(r.name)];
      if (store && byStore.has(store)) byStore.get(store).push(r);
      else unassigned.push(r);
    });
    const result = STORE_ROSTER.stores
      .map(s => ({ name: s.name, rows: sortComparisonRows(byStore.get(s.name), sortBy) }))
      .filter(g => g.rows.length > 0);
    if (unassigned.length) result.push({ name: 'No store on file', rows: sortComparisonRows(unassigned, sortBy) });
    return result;
  }, [rows, sortBy]);

  if (!rows.length) {
    return <div className="empty-state"><p className="empty-title">No employees yet</p><p>No uploaded report falls in the picked date range(s) — check the picker above, or upload one on the Setup tab.</p></div>;
  }

  return (
    <div className="tab-content">
      <div className="ledger-head-row">
        <p className="section-label" style={{ margin: 0 }}>Grouped by store</p>
        <select className="sort-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="tsth">Sort: highest TSTH</option>
          <option value="delta">Sort: biggest change in TSTH</option>
          <option value="revenue">Sort: total revenue</option>
          <option value="name">Sort: name</option>
        </select>
      </div>
      {groups.map(g => (
        <div key={g.name} className="store-group">
          <p className="store-group-title">{g.name} <span className="store-group-count">{g.rows.length} employee{g.rows.length > 1 ? 's' : ''}</span></p>
          <LedgerTable rows={g.rows} label1={label1} label2={label2} />
        </div>
      ))}
    </div>
  );
}

// ─── P&L tab ─────────────────────────────────────────────────────────────────
// Current period only (no prior-period comparison) — income comes from the
// store collection summary report's Total Collection (broken into the
// categories that sum to it). Compensation is computed live from the same
// Hours + Sales files used elsewhere in the app. Royalties are always a flat
// 6% of income (see storeRoyalties), never manually entered. Other fixed
// costs (rent, tech fees, bank fees, etc.) don't come from any report —
// they're entered once per store below and reused every time until changed.
function PLSummaryCard({ income, payroll, fixed }) {
  const net = income - payroll - fixed;
  const margin = income > 0 ? net / income : null;
  return (
    <div className="summary-card">
      <div className="summary-row">
        <span className="summary-label">Total Collection</span>
        <span className="summary-value">{fmt$(income)}</span>
      </div>
      <div className="summary-row">
        <span className="summary-label">Compensation</span>
        <span className="summary-value">{fmt$(payroll)}</span>
      </div>
      <div className="summary-row">
        <span className="summary-label">Fixed expenses</span>
        <span className="summary-value">{fmt$(fixed)}</span>
      </div>
      <div className="summary-row summary-row--highlight">
        <span className="summary-label">Net income</span>
        <span className="summary-value">{fmt$(net)}</span>
      </div>
      <div className="summary-row">
        <span className="summary-label">Net margin</span>
        <span className="summary-value">{margin != null ? `${(margin * 100).toFixed(1)}%` : '—'}</span>
      </div>
    </div>
  );
}

// A single line of the statement: label, its % of that period's income, and
// the dollar value.
function StatementRow({ label, value, pctBase, bold }) {
  const pct = pctBase > 0 ? (value / pctBase) * 100 : null;
  return (
    <div className={`pl-row ${bold ? 'pl-row--total' : ''}`}>
      <span className="pl-row-label">{label}</span>
      <span className="pl-row-pct">{pct != null ? `${pct.toFixed(1)}%` : '—'}</span>
      <span className="pl-row-value">{fmt$(value)}</span>
    </div>
  );
}

function PLStatement({ incomeValues, income, payroll, fixedExpenses, storeName }) {
  const royalties = storeRoyalties(income);
  const fixedRows = FIXED_EXPENSE_FIELDS.map(f => ({
    label: f.label,
    value: fixedExpenseCategoryValue(fixedExpenses, storeName, f.key),
  }));
  const fixedTotal = fixedRows.reduce((sum, r) => sum + r.value, 0) + royalties;
  const totalExpense = payroll + fixedTotal;
  const netIncome = income - totalExpense;

  return (
    <div className="chart-card">
      <p className="chart-title">Full statement</p>
      <div className="pl-statement">
        <div className="pl-row pl-row-head"><span className="pl-row-label" /><span className="pl-row-pct">% Income</span><span className="pl-row-value">Amount</span></div>
        <p className="pl-section-title">Income (Total Collection)</p>
        {COLLECTION_CATEGORIES.map(c => (
          <StatementRow key={c.key} label={c.label} value={incomeValues[c.key] || 0} pctBase={income} />
        ))}
        <StatementRow label="Total Collection" value={income} pctBase={income} bold />

        <p className="pl-section-title">Expense</p>
        <StatementRow label="Compensation" value={payroll} pctBase={income} />
        <StatementRow label="Royalties (6% of Collections)" value={royalties} pctBase={income} />
        <p className="pl-section-title">Fixed expenses</p>
        {fixedRows.map(r => <StatementRow key={r.label} label={r.label} value={r.value} pctBase={income} />)}
        <StatementRow label="Total Expense" value={totalExpense} pctBase={income} bold />

        <StatementRow label="Net Income" value={netIncome} pctBase={income} bold />
      </div>
    </div>
  );
}

function FixedExpensesForm({ storeName, values, onSave }) {
  const [draft, setDraft] = useState(() => ({ ...values }));
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft({ ...values }); }, [storeName]); // eslint-disable-line

  const handleSave = async () => {
    setSaving(true);
    const clean = {};
    FIXED_EXPENSE_FIELDS.forEach(f => { clean[f.key] = Number(draft[f.key]) || 0; });
    await onSave(storeName, clean);
    setDraft(clean);
    setSaving(false);
  };

  return (
    <div className="chart-card">
      <p className="chart-title">Fixed monthly expenses — {storeName}</p>
      <div className="pl-fixed-grid">
        {FIXED_EXPENSE_FIELDS.map(f => (
          <label key={f.key} className="pl-fixed-field">
            <span>{f.label}</span>
            <input
              type="number" inputMode="decimal" placeholder="0"
              value={draft[f.key] ?? ''}
              onChange={e => setDraft(prev => ({ ...prev, [f.key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <button className="btn-ghost btn-sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save fixed expenses'}</button>
    </div>
  );
}

// One store's (or the combined) whole P&L block, for the current period
// only: the store name up top, the summary card, the itemized statement,
// and — for a real store — its fixed-expenses edit form. storeName === null
// renders the combined total.
function StorePLSection({ storeName, merged, collections, fixedExpenses, onSaveFixedExpenses }) {
  const inc = storeIncome(collections, storeName);
  const payroll = storePayroll(merged, storeName);
  const fixed = fixedExpenseTotal(fixedExpenses, storeName) + storeRoyalties(inc.total);

  return (
    <section className="pl-store-section">
      <h3 className="pl-store-heading">{storeName || 'All Stores Combined'}</h3>

      <PLSummaryCard income={inc.total} payroll={payroll} fixed={fixed} />

      <PLStatement
        incomeValues={inc.values} income={inc.total}
        payroll={payroll} fixedExpenses={fixedExpenses} storeName={storeName}
      />

      {storeName != null && (
        <FixedExpensesForm storeName={storeName} values={fixedExpenses?.[storeName] || {}} onSave={onSaveFixedExpenses} />
      )}
    </section>
  );
}

function PLTab({ merged, collections, fixedExpenses, onSaveFixedExpenses }) {
  return (
    <div className="tab-content">
      <div className="pl-store-scroll">
        {STORE_ROSTER.stores.map(s => (
          <StorePLSection
            key={s.name} storeName={s.name} merged={merged} collections={collections}
            fixedExpenses={fixedExpenses} onSaveFixedExpenses={onSaveFixedExpenses}
          />
        ))}
        <StorePLSection
          storeName={null} merged={merged} collections={collections}
          fixedExpenses={fixedExpenses} onSaveFixedExpenses={onSaveFixedExpenses}
        />
      </div>
    </div>
  );
}

// ─── Setup tab ──────────────────────────────────────────────────────────────
function SetupTab({ configured, uploadLog, collectionsSnapshot, uploadingKind, onFile }) {
  const steps = [
    { n: 1, title: 'Export your Attendance report', body: 'From your scheduling/POS system, run the Attendance report for whatever date range you want to add (a week at a time is typical). It needs a Date, Employee Name, and Actual Hours column.' },
    { n: 2, title: 'Export your Employee Sales report', body: 'Run the Employee Sales report for the same date range — the line-item export with a Sale Date, Item Type, and Sales column per transaction, not a rolled-up KPI summary.' },
    { n: 3, title: 'Export your store collection summary', body: 'For the P&L tab only, run the store-level KPI/collection export (one row per store, with a Total Collection column). This one isn\'t historical — each upload just replaces the current snapshot P&L reads from.' },
    { n: 4, title: 'Upload the files below', body: 'Tap + on Attendance and Employee Sales any time you have a new date range to add — every row already has its own date, so there\'s nothing to match up manually. Uploading the same date range again corrects those rows in place instead of duplicating them.' },
    { n: 5, title: 'Employees are grouped by store automatically', body: 'The "By Store" tab groups this same comparison by location. The employee → store list is built into the app — no upload needed for it.' },
    { n: 6, title: 'Pick what to compare', body: 'Overview, Employee Performance, By Store, and P&L all share one date-range picker at the top: type in exactly the two ranges you want (A vs B), or tap "This month vs last month" for a quick MTD comparison — the picker just filters whatever has been uploaded so far, spanning as many weeks as it needs to.' },
    { n: 7, title: 'Read the comparison', body: 'Employee Performance and By Store break down each side by Actual Hours, Service Rev, Retail Sales, Total Sales, Pay + Tax + Retail (hourly pay + 10% retail commission + 8% payroll tax), Production (what they made minus what they cost), two TSTH columns (service-only and total-sales), and Payroll % (pay ÷ total sales). Averages for both TSTH columns and Payroll % show at the bottom of each table. Only employees with both an hours record and a sales record for a period are included.' },
    { n: 8, title: 'Nothing is ever lost', body: 'Every Attendance/Employee Sales row you\'ve ever uploaded stays in the dataset permanently — the app just keeps growing week over week. Check the Upload Log tab any time to see what\'s been loaded so far.' },
    { n: 9, title: 'Add to your phone home screen', body: 'On iPhone: open the app URL in Safari → Share → "Add to Home Screen." On Android: Chrome → three dots → "Add to Home Screen."' },
  ];
  return (
    <div className="tab-content setup-tab">
      <div className={`setup-status ${configured ? 'setup-status--ok' : 'setup-status--warn'}`}>
        {configured
          ? '✓ Connected to Supabase — your data syncs across devices.'
          : '⚠ Supabase not connected — data is only saved on this device. See below to enable cross-device sync.'}
      </div>

      <UploadPanel uploadLog={uploadLog} collectionsSnapshot={collectionsSnapshot} uploadingKind={uploadingKind} onFile={onFile} />

      <div className="setup-section">
        {steps.map(s => (
          <div key={s.n} className="setup-step">
            <div className="step-num">{s.n}</div>
            <div><p className="step-title">{s.title}</p><p className="step-body">{s.body}</p></div>
          </div>
        ))}
      </div>

      <div className="setup-sql-card">
        <p className="chart-title">One-time database setup — Attendance &amp; Employee Sales tables</p>
        <p className="step-body">This app now stores Attendance and Employee Sales as permanent, row-level data instead of weekly snapshots, so it needs two dedicated tables. Run this once in the Supabase SQL Editor (safe to run again if you're not sure it already ran — <code>create table</code> will just error harmlessly if the tables exist):</p>
        <pre className="setup-sql">{`create table attendance_entries (
  id bigint generated always as identity primary key,
  work_date date not null,
  employee_name text not null,
  hours_decimal numeric not null,
  source_file text,
  uploaded_at timestamptz not null default now()
);
create index attendance_entries_date_idx on attendance_entries (work_date);

create table sales_entries (
  id bigint generated always as identity primary key,
  sale_date date not null,
  employee_name text not null,
  store_name text,
  invoice_no text,
  item_code text,
  item_type text not null,
  item_name text,
  sale_amount numeric not null,
  payment_type text,
  status text,
  source_file text,
  uploaded_at timestamptz not null default now()
);
create index sales_entries_date_idx on sales_entries (sale_date);

alter table attendance_entries enable row level security;
alter table sales_entries enable row level security;

create policy "Allow all access" on attendance_entries for all using (true) with check (true);
create policy "Allow all access" on sales_entries for all using (true) with check (true);`}</pre>
        <p className="step-body">Same "Allow all access" policy as the existing <code>periods</code> table — without it, Supabase silently blocks every request and uploads will only save on this device. If Attendance/Employee Sales uploads seem to disappear after a refresh, this is the first thing to check.</p>
      </div>

      {!configured && (
        <div className="setup-sql-card">
          <p className="chart-title">One-time Supabase setup</p>
          <p className="step-body">Create a table called <code>periods</code> by running this in the Supabase SQL Editor:</p>
          <pre className="setup-sql">{`create table periods (
  period_id text primary key,
  payload jsonb not null,
  updated_at timestamp with time zone default now()
);

alter table periods enable row level security;

create policy "Allow all access"
  on periods for all
  using (true)
  with check (true);`}</pre>
          <p className="step-body">That last policy is what lets the app actually read and write — without it, Supabase silently blocks every request and the app quietly falls back to saving only on your own device. If you already created the table without it, just run the <code>alter table</code> and <code>create policy</code> lines on their own.</p>
          <p className="step-body">Then add <code>REACT_APP_SUPABASE_URL</code> and <code>REACT_APP_SUPABASE_ANON_KEY</code> as environment variables in Vercel, using the values from Supabase → Settings → API.</p>
        </div>
      )}
    </div>
  );
}

// ─── Upload Log tab ─────────────────────────────────────────────────────────
// Every Attendance/Employee Sales upload, permanently, newest first — a
// quick way to check whether a given week has already been loaded before
// running the export again. Data itself isn't browsed here (it's continuous
// now, not a set of discrete periods) — that happens via the date-range
// picker on every other tab.
function UploadLogTab({ uploadLog }) {
  if (!uploadLog.length) {
    return (
      <div className="tab-content">
        <div className="empty-state">
          <p className="empty-title">No uploads yet</p>
          <p>Every Attendance or Employee Sales file you upload shows up here automatically, permanently.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="tab-content">
      <p className="section-label">Every upload, newest first.</p>
      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr><th>Uploaded</th><th>Report</th><th>File</th><th>Date range</th><th>Rows</th></tr>
          </thead>
          <tbody>
            {uploadLog.map(entry => (
              <tr key={entry.id}>
                <td>{new Date(entry.uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td>{entry.kind === 'attendance' ? 'Attendance' : 'Employee Sales'}</td>
                <td className="ledger-name-col">{entry.fileName}</td>
                <td>{fmtDateShort(entry.fromDate)} – {fmtDateShort(entry.toDate)}</td>
                <td>{entry.rowCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Employee Performance', 'By Store', 'P&L', 'Weekly Report', 'Upload Log', 'Setup'];
const COMPARE_TABS = ['Overview', 'Employee Performance', 'By Store', 'P&L'];
const emptyRange = { a: { from: '', to: '' }, b: { from: '', to: '' } };
const emptyCollections = { stores: {}, grandTotal: null };

export default function App() {
  const [attendanceRows, setAttendanceRows] = useState([]);
  const [salesRows, setSalesRows] = useState([]);
  const [collectionsSnapshot, setCollectionsSnapshot] = useState(emptyCollections);
  const [uploadLog, setUploadLog] = useState([]);
  const [compareRange, setCompareRange] = useState(emptyRange);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');
  const [toast, setToast] = useState(null);
  const [uploadingKind, setUploadingKind] = useState(null); // 'attendance'|'sales'|'collections'|null
  const [fixedExpenses, setFixedExpenses] = useState({}); // { [storeName]: { rent, utilities, ... } }
  const [weeklyReportData, setWeeklyReportData] = useState(emptyWeeklyReportData());

  useEffect(() => {
    Promise.all([loadAttendanceEntries(), loadSalesEntries(), loadPeriods()]).then(([att, sal, periodsRes]) => {
      setAttendanceRows(att.data);
      setSalesRows(sal.data);
      setCompareRange(computeDefaultCompareRange(att.data, sal.data));

      const saved = periodsRes.data;
      setCollectionsSnapshot(saved.collections_current || emptyCollections);
      setUploadLog(saved.upload_log || []);

      // Seed any store that has no saved fixed expenses yet with the real
      // numbers from the March 2026 Contribution Report — once a store is
      // saved (even unchanged), its own values take over from here on.
      const savedFixed = saved.fixed_expenses || {};
      const withDefaults = { ...savedFixed };
      let seeded = false;
      Object.keys(DEFAULT_FIXED_EXPENSES).forEach(store => {
        if (!withDefaults[store]) { withDefaults[store] = DEFAULT_FIXED_EXPENSES[store]; seeded = true; }
      });
      setFixedExpenses(withDefaults);
      if (seeded) savePeriod('fixed_expenses', withDefaults);
      setWeeklyReportData({ ...emptyWeeklyReportData(), ...(saved[WEEKLY_REPORT_KEY] || {}) });
      setLoading(false);

      const failed = [att, sal, periodsRes].find(r => r.source === 'local' && r.error);
      if (isConfigured() && failed) {
        showToast(`Couldn't reach Supabase (${failed.error}) — showing this device's local data only`, 'error');
      }
    }).catch(() => setLoading(false));
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const appendUploadLog = useCallback((kind, parsed) => {
    setUploadLog(prev => {
      const next = [{
        id: newId(), kind, fileName: parsed.fileName,
        fromDate: parsed.fromDate, toDate: parsed.toDate, rowCount: parsed.rows.length,
        uploadedAt: new Date().toISOString(),
      }, ...prev];
      savePeriod('upload_log', next);
      return next;
    });
  }, []);

  const handleFile = useCallback(async (kind, file) => {
    setUploadingKind(kind);
    try {
      if (kind === 'attendance') {
        const parsed = await parseAttendanceFile(file);
        const result = await replaceAttendanceRange(parsed.fromDate, parsed.toDate, parsed.rows, file.name);
        setAttendanceRows(prev => [...prev.filter(r => r.workDate < parsed.fromDate || r.workDate > parsed.toDate), ...parsed.rows]);
        appendUploadLog('attendance', parsed);
        if (isConfigured() && !result.ok) {
          showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
        } else {
          showToast(`Loaded ${file.name} — ${parsed.rows.length} rows, ${fmtDateShort(parsed.fromDate)} – ${fmtDateShort(parsed.toDate)}`);
        }
      } else if (kind === 'sales') {
        const parsed = await parseEmployeeSalesFile(file);
        const result = await replaceSalesRange(parsed.fromDate, parsed.toDate, parsed.rows, file.name);
        setSalesRows(prev => [...prev.filter(r => r.saleDate < parsed.fromDate || r.saleDate > parsed.toDate), ...parsed.rows]);
        appendUploadLog('sales', parsed);
        if (isConfigured() && !result.ok) {
          showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
        } else {
          showToast(`Loaded ${file.name} — ${parsed.rows.length} rows, ${fmtDateShort(parsed.fromDate)} – ${fmtDateShort(parsed.toDate)}`);
        }
      } else {
        const parsed = await parseStoreCollectionFile(file);
        setCollectionsSnapshot(parsed);
        const result = await savePeriod('collections_current', parsed);
        if (isConfigured() && !result.ok) {
          showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
        } else {
          showToast(`Loaded ${file.name} — ${Object.keys(parsed.stores).length} stores found`);
        }
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploadingKind(null);
    }
  }, [appendUploadLog]);

  const handleRangeChange = useCallback((side, field, value) => {
    setCompareRange(prev => ({ ...prev, [side]: { ...prev[side], [field]: value } }));
  }, []);

  const handleMonthToDate = useCallback(() => {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth();
    const bFrom = toISODate(new Date(y, m, 1));
    // Cap "to" at the latest date that actually has uploaded data, not at
    // today's calendar date — otherwise a gap between the last upload and
    // today (e.g. data through the 7th but it's the 10th) reads as a real
    // dip instead of just missing data.
    const allDates = [...attendanceRows.map(r => r.workDate), ...salesRows.map(r => r.saleDate)].sort();
    const latestDataDate = allDates.length ? allDates[allDates.length - 1] : null;
    const todayISO = toISODate(today);
    const bTo = (latestDataDate && latestDataDate >= bFrom) ? latestDataDate : todayISO;
    const bToDay = Number(bTo.slice(8, 10));
    const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
    const daysInPrevMonth = new Date(py, pm + 1, 0).getDate();
    const aFrom = toISODate(new Date(py, pm, 1));
    const aTo = toISODate(new Date(py, pm, Math.min(bToDay, daysInPrevMonth)));
    setCompareRange({ a: { from: aFrom, to: aTo }, b: { from: bFrom, to: bTo } });
  }, [attendanceRows, salesRows]);

  const handleClearAll = async () => {
    if (!window.confirm('Permanently delete every uploaded Attendance/Employee Sales row, the P&L collection snapshot, and the upload log? This cannot be undone.')) return;
    setAttendanceRows([]);
    setSalesRows([]);
    setCollectionsSnapshot(emptyCollections);
    setUploadLog([]);
    setCompareRange(emptyRange);
    await Promise.all([
      deleteAllAttendance(), deleteAllSales(),
      savePeriod('collections_current', emptyCollections), savePeriod('upload_log', []),
    ]);
    showToast('All uploaded data deleted');
  };

  const handleSaveFixedExpenses = useCallback(async (storeName, values) => {
    const next = { ...fixedExpenses, [storeName]: values };
    setFixedExpenses(next);
    const result = await savePeriod('fixed_expenses', next);
    if (isConfigured() && !result.ok) {
      showToast(`Saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
    } else {
      showToast(`${storeName} fixed expenses saved`);
    }
  }, [fixedExpenses]);

  const hoursA = useMemo(() => {
    const a = aggregateAttendance(attendanceRows, compareRange.a.from, compareRange.a.to);
    return a && a.employees.length ? a : null;
  }, [attendanceRows, compareRange.a]);
  const salesA = useMemo(() => {
    const s = aggregateSales(salesRows, compareRange.a.from, compareRange.a.to);
    return s && s.employees.length ? s : null;
  }, [salesRows, compareRange.a]);
  const hoursB = useMemo(() => {
    const a = aggregateAttendance(attendanceRows, compareRange.b.from, compareRange.b.to);
    return a && a.employees.length ? a : null;
  }, [attendanceRows, compareRange.b]);
  const salesB = useMemo(() => {
    const s = aggregateSales(salesRows, compareRange.b.from, compareRange.b.to);
    return s && s.employees.length ? s : null;
  }, [salesRows, compareRange.b]);

  const mergedA = useMemo(() => mergePeriod(hoursA, salesA), [hoursA, salesA]);
  const mergedB = useMemo(() => mergePeriod(hoursB, salesB), [hoursB, salesB]);
  const labelA = rangeLabel(compareRange.a);
  const labelB = rangeLabel(compareRange.b);
  const hasAnyData = attendanceRows.length > 0 || salesRows.length > 0;

  if (loading) return <div className="app-loading"><div className="spinner large" /></div>;

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Employee Performance</h1>
          <p className="app-subtitle">Labor hours vs. service sales, side by side</p>
        </div>
        <div className="header-right">
          {hasAnyData && <button className="btn-ghost" onClick={handleClearAll}>Delete all data</button>}
        </div>
      </header>

      <nav className="tab-nav">
        {TABS.map(t => (
          <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      {COMPARE_TABS.includes(tab) && (
        <CompareBar rangeA={compareRange.a} rangeB={compareRange.b} onRangeChange={handleRangeChange} onMonthToDate={handleMonthToDate} />
      )}
      <main className="app-main">
        {tab === 'Overview' && <OverviewTab p1={mergedA} p2={mergedB} label1={labelA} label2={labelB} />}
        {tab === 'Employee Performance' && <EmployeesTab p1={mergedA} p2={mergedB} label1={labelA} label2={labelB} />}
        {tab === 'By Store' && <ByStoreTab p1={mergedA} p2={mergedB} label1={labelA} label2={labelB} />}
        {tab === 'P&L' && (
          <PLTab
            merged={mergedB} collections={collectionsSnapshot}
            fixedExpenses={fixedExpenses} onSaveFixedExpenses={handleSaveFixedExpenses}
          />
        )}
        {tab === 'Weekly Report' && (
          <WeeklyReportTab data={weeklyReportData} onChange={setWeeklyReportData} showToast={showToast} />
        )}
        {tab === 'Upload Log' && <UploadLogTab uploadLog={uploadLog} />}
        {tab === 'Setup' && (
          <SetupTab
            configured={isConfigured()} uploadLog={uploadLog} collectionsSnapshot={collectionsSnapshot}
            uploadingKind={uploadingKind} onFile={handleFile}
          />
        )}
      </main>
    </div>
  );
}

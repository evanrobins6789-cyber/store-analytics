import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Tooltip, Legend
} from 'chart.js';
import { loadPeriods, savePeriod, isConfigured } from './db';
import { parseHoursFile, parseSalesFile, parseStoreCollectionFile, normalizeEmployeeName, decimalToHoursDisplay, parseLooseDate, COLLECTION_CATEGORIES } from './parser';
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

// ─── Report periods: every upload files itself into a period by its own ────
// ─── date range — no manual "Period 1 / Period 2" slots to manage ──────────
function newPeriodId() {
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

function periodDisplayLabel(entry) {
  if (entry.label) return entry.label;
  if (entry.fromDate && entry.toDate) return `${fmtDateShort(entry.fromDate)} – ${fmtDateShort(entry.toDate)}`;
  return 'Untitled period';
}

// One-time migration for accounts that still have data under the old
// period1/period2 (+ period_history) keys from before periods were keyed by
// date range — folds them into the new unified list so nothing uploaded
// before this change goes missing.
function migrateLegacyToReportPeriods(saved) {
  const list = [];
  const addSnapshot = snap => {
    if (!snap || (!snap.hours && !snap.sales && !snap.collections)) return;
    const label = snap.label || snap.hours?.dateRangeLabel || snap.sales?.dateRangeLabel || '';
    const [fromText, toText] = label.split(' – ');
    list.push({
      id: newPeriodId(),
      label,
      fromDate: snap.hours?.fromDate || snap.sales?.fromDate || parseLooseDate(fromText) || null,
      toDate: snap.hours?.toDate || snap.sales?.toDate || parseLooseDate(toText) || null,
      hours: snap.hours || null,
      sales: snap.sales || null,
      collections: snap.collections || null,
      updatedAt: new Date().toISOString(),
    });
  };
  addSnapshot(saved.period1);
  addSnapshot(saved.period2);
  (saved.period_history || []).forEach(addSnapshot);
  return list;
}

// Every report period whose date range overlaps [from, to] — ISO YYYY-MM-DD
// strings compare correctly with plain string comparison.
function periodsOverlappingRange(reportPeriods, range) {
  if (!range?.from || !range?.to) return [];
  return reportPeriods.filter(p => p.fromDate && p.toDate && p.fromDate <= range.to && p.toDate >= range.from);
}

// Sum multiple periods' hours/sales/collections into one combined dataset —
// lets a picked date range span more than one uploaded report (e.g. a full
// month made of two semi-monthly pay periods) while reusing mergePeriod and
// every downstream display component unchanged.
function combineHours(periods) {
  const list = periods.map(p => p.hours).filter(Boolean);
  if (!list.length) return null;
  const byName = new Map();
  list.forEach(h => (h.employees || []).forEach(e => {
    const key = normalizeEmployeeName(e.name);
    const cur = byName.get(key) || { name: e.name, hoursDecimal: 0 };
    cur.hoursDecimal += e.hoursDecimal || 0;
    byName.set(key, cur);
  }));
  const employees = Array.from(byName.values()).map(e => ({
    name: e.name,
    hoursDecimal: Math.round(e.hoursDecimal * 100) / 100,
    hoursDisplay: decimalToHoursDisplay(e.hoursDecimal),
  }));
  const totalHoursDecimal = Math.round(list.reduce((s, h) => s + (h.totalHoursDecimal || 0), 0) * 100) / 100;
  return {
    location: [...new Set(list.map(h => h.location).filter(Boolean))].join(', ') || null,
    totalHoursDecimal,
    totalHoursDisplay: decimalToHoursDisplay(totalHoursDecimal),
    employees,
  };
}

function combineSales(periods) {
  const list = periods.map(p => p.sales).filter(Boolean);
  if (!list.length) return null;
  const byName = new Map();
  let otherRevenue = 0, otherRetailSales = 0;
  list.forEach(s => {
    otherRevenue += s.otherRevenue || 0;
    otherRetailSales += s.otherRetailSales || 0;
    (s.employees || []).forEach(e => {
      const key = normalizeEmployeeName(e.name);
      const cur = byName.get(key) || { name: e.name, serviceRevenue: 0, retailSales: 0 };
      cur.serviceRevenue += e.serviceRevenue || 0;
      cur.retailSales += e.retailSales || 0;
      byName.set(key, cur);
    });
  });
  const employees = Array.from(byName.values()).map(e => ({
    name: e.name,
    serviceRevenue: Math.round(e.serviceRevenue * 100) / 100,
    retailSales: Math.round(e.retailSales * 100) / 100,
  }));
  return {
    totalServiceRevenue: Math.round(list.reduce((s, x) => s + (x.totalServiceRevenue || 0), 0) * 100) / 100,
    totalRetailSales: Math.round(list.reduce((s, x) => s + (x.totalRetailSales || 0), 0) * 100) / 100,
    otherRevenue: Math.round(otherRevenue * 100) / 100,
    otherRetailSales: Math.round(otherRetailSales * 100) / 100,
    employees,
  };
}

function combineCollections(periods) {
  const list = periods.map(p => p.collections).filter(Boolean);
  if (!list.length) return null;
  const emptyCategoryTotals = () => Object.fromEntries(COLLECTION_CATEGORIES.map(c => [c.key, 0]));
  const stores = {};
  const grandTotal = { totalCollection: 0, ...emptyCategoryTotals() };
  list.forEach(c => {
    Object.entries(c.stores || {}).forEach(([storeName, entry]) => {
      const cur = stores[storeName] || { totalCollection: 0, ...emptyCategoryTotals() };
      cur.totalCollection += entry.totalCollection || 0;
      COLLECTION_CATEGORIES.forEach(cc => { cur[cc.key] += entry[cc.key] || 0; });
      stores[storeName] = cur;
    });
    grandTotal.totalCollection += c.grandTotal?.totalCollection || 0;
    COLLECTION_CATEGORIES.forEach(cc => { grandTotal[cc.key] += c.grandTotal?.[cc.key] || 0; });
  });
  return { stores, grandTotal };
}

// Default comparison: the two most recent distinct periods, so the app
// isn't blank on first load.
function computeDefaultRange(reportPeriods) {
  const dated = reportPeriods.filter(p => p.fromDate && p.toDate).sort((a, b) => b.fromDate.localeCompare(a.fromDate));
  const toRange = p => (p ? { from: p.fromDate, to: p.toDate } : { from: '', to: '' });
  return { a: toRange(dated[1]), b: toRange(dated[0]) };
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Merge one period's hours + sales into a single comparable dataset ─────
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
    location: hours?.location || null,
    totalHours,
    totalHoursDisplay: hours?.totalHoursDisplay || null,
    totalRevenue,
    totalRetailSales,
    totalSalesAll,
    totalRevPerHour,
    totalPayroll,
    payrollPct,
    otherRevenue: sales?.otherRevenue || 0,
    employees,
    hoursOnly,
    salesOnly,
    hasHours: !!hours,
    hasSales: !!sales,
    complete: !!hours && !!sales,
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
  { key: 'royalties', label: 'Royalties' },
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
    accounting: 0, bankFees: 156.36, infoSystems: 799, royalties: 500.39, supplies: 210.4,
    advertising: 2606.61, maintenance: 0, paidouts: 28.24, refunds: 0,
  },
  MEDIA: {
    rent: 6038.33, utilities: 848, insurance: 309.89, licenses: 0, alarmMonitoring: 0,
    accounting: 0, bankFees: 373.93, infoSystems: 846.94, royalties: 1152.47, supplies: 1324.82,
    advertising: 3062.82, maintenance: 55, paidouts: 90, refunds: 0,
  },
  'PIKE CREEK': {
    rent: 5895.71, utilities: 1079.45, insurance: 309.89, licenses: 0, alarmMonitoring: 0,
    accounting: 0, bankFees: 496.04, infoSystems: 799, royalties: 1421.22, supplies: 1470.49,
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

// The most recently updated period that has a file of this kind — used only
// to show "here's what's currently loaded" feedback in the upload box.
function mostRecentOfKind(reportPeriods, kind) {
  const withKind = reportPeriods.filter(p => p[kind]);
  if (!withKind.length) return null;
  return withKind.reduce((latest, p) => ((p.updatedAt || '') > (latest.updatedAt || '') ? p : latest))[kind];
}

function UploadPanel({ reportPeriods, uploadingKind, onFile }) {
  const hours = mostRecentOfKind(reportPeriods, 'hours');
  const sales = mostRecentOfKind(reportPeriods, 'sales');
  const collections = mostRecentOfKind(reportPeriods, 'collections');
  return (
    <div className="period-panel">
      <div className="period-panel-head">
        <span className="period-eyebrow">Upload a report</span>
        <p className="upload-panel-hint">Each file's own date range files it into the right period automatically — upload as many as you want, over time, without losing anything.</p>
      </div>
      <div className="period-slots">
        <UploadSlot
          inputId="upload-hours"
          title="Hours worked"
          hint="Upload the attendance / hours export"
          accent="steel"
          uploading={uploadingKind === 'hours'}
          fileInfo={hours ? { fileName: hours.fileName, sub: `${hours.employees.length} employees · ${hours.totalHoursDisplay} total` } : null}
          onFile={file => onFile('hours', file)}
        />
        <UploadSlot
          inputId="upload-sales"
          title="Service sales"
          hint="Upload the sales / KPI export"
          accent="sage"
          uploading={uploadingKind === 'sales'}
          fileInfo={sales ? { fileName: sales.fileName, sub: `${sales.employees.length} employees · ${fmt$(sales.totalServiceRevenue)} total` } : null}
          onFile={file => onFile('sales', file)}
        />
        <UploadSlot
          inputId="upload-collections"
          title="Store collection summary (for P&L)"
          hint="Upload the store-level KPI/collection export"
          accent="brass"
          uploading={uploadingKind === 'collections'}
          fileInfo={collections ? { fileName: collections.fileName, sub: `${Object.keys(collections.stores).length} stores · ${fmt$(collections.grandTotal?.totalCollection)} total collection` } : null}
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
        <p className="empty-note">No files uploaded yet</p>
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
    return <div className="empty-state"><p className="empty-title">No employees yet</p><p>Upload at least one hours or sales file to see this table.</p></div>;
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

      {(p1?.otherRevenue > 0 || p2?.otherRevenue > 0) && (
        <p className="ledger-footnote">
          House / unattributed sales not tied to a specific employee — {label1}: {fmt$(p1?.otherRevenue || 0)}, {label2}: {fmt$(p2?.otherRevenue || 0)}.
        </p>
      )}

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
    return <div className="empty-state"><p className="empty-title">No employees yet</p><p>Upload hours and sales files with matching data for both periods first.</p></div>;
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
// Hours + Sales files used elsewhere in the app. Fixed costs (rent, tech
// fees, bank fees, royalties, etc.) don't come from any report — they're
// entered once per store below and reused every time until you change them.
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
  const fixedRows = FIXED_EXPENSE_FIELDS.map(f => ({
    label: f.label,
    value: fixedExpenseCategoryValue(fixedExpenses, storeName, f.key),
  }));
  const fixedTotal = fixedRows.reduce((sum, r) => sum + r.value, 0);
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
  const fixed = fixedExpenseTotal(fixedExpenses, storeName);

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
function SetupTab({ configured, reportPeriods, uploadingKind, onFile }) {
  const steps = [
    { n: 1, title: 'Export your hours report', body: 'From your scheduling/POS system, run the attendance (hours) report for whatever date range you want to look at.' },
    { n: 2, title: 'Export your sales report', body: 'Run the service-sales (KPI) report for the same date range. The Service Revenue column is the one this app reads.' },
    { n: 3, title: 'Export your store collection summary', body: 'For the P&L tab, run the store-level KPI/collection export (one row per store, with a Total Collection column) for the same date range.' },
    { n: 4, title: 'Upload the three files below', body: 'Tap + on each box: Hours, Sales, and Collection Summary. Each file already has its own date range printed on it, so the app files it into the right period automatically — upload hours and sales first, then collections. No "Period 1" or "Period 2" to pick.' },
    { n: 5, title: 'Employees are grouped by store automatically', body: 'The "By Store" tab groups this same comparison by location. The employee → store list is built into the app — no upload needed for it.' },
    { n: 6, title: 'Pick what to compare', body: 'Overview, Employee Performance, By Store, and P&L all share one date-range picker at the top: type in exactly the two ranges you want (A vs B), or tap "This month vs last month" for a quick MTD comparison. If a picked range spans more than one uploaded report, they\'re summed together automatically.' },
    { n: 7, title: 'Read the comparison', body: 'Employee Performance and By Store break down each side by Actual Hours, Service Rev, Retail Sales, Total Sales, Pay + Tax + Retail (hourly pay + 10% retail commission + 8% payroll tax), Production (what they made minus what they cost), two TSTH columns (service-only and total-sales), and Payroll % (pay ÷ total sales). Averages for both TSTH columns and Payroll % show at the bottom of each table. Only employees with both an hours record and a sales record for a period are included.' },
    { n: 8, title: 'Nothing is ever lost', body: 'Every report you upload becomes its own permanent period, filed by date — re-uploading the same date range just corrects it in place. Look back on any past period any time under the History tab.' },
    { n: 9, title: 'Add to your phone home screen', body: 'On iPhone: open the app URL in Safari → Share → "Add to Home Screen." On Android: Chrome → three dots → "Add to Home Screen."' },
  ];
  return (
    <div className="tab-content setup-tab">
      <div className={`setup-status ${configured ? 'setup-status--ok' : 'setup-status--warn'}`}>
        {configured
          ? '✓ Connected to Supabase — your data syncs across devices.'
          : '⚠ Supabase not connected — data is only saved on this device. See below to enable cross-device sync.'}
      </div>

      <UploadPanel reportPeriods={reportPeriods} uploadingKind={uploadingKind} onFile={onFile} />

      <div className="setup-section">
        {steps.map(s => (
          <div key={s.n} className="setup-step">
            <div className="step-num">{s.n}</div>
            <div><p className="step-title">{s.title}</p><p className="step-body">{s.body}</p></div>
          </div>
        ))}
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

// ─── History tab ────────────────────────────────────────────────────────────
// Every report period ever uploaded lives here permanently, newest first —
// this is the same list the comparison tabs draw from, just browsable in
// full rather than filtered down to two picked ranges.
function HistoryEntryCard({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const merged = useMemo(() => mergePeriod(entry.hours, entry.sales), [entry]);
  const collectionsTotal = entry.collections?.grandTotal?.totalCollection;
  const updatedDate = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

  return (
    <div className="summary-card history-card">
      <div className="history-card-head">
        <div>
          <p className="period-name">{periodDisplayLabel(entry)}</p>
          {updatedDate && <p className="history-archived-at">Last updated {updatedDate}</p>}
        </div>
        {merged?.employees?.length > 0 && (
          <button className="btn-ghost btn-sm" onClick={() => setExpanded(x => !x)}>
            {expanded ? 'Hide' : 'Show'} employees
          </button>
        )}
      </div>

      {merged ? (
        <>
          <div className="summary-row">
            <span className="summary-label">Hours worked</span>
            <span className="summary-value">{merged.totalHoursDisplay || '—'}</span>
          </div>
          <div className="summary-row">
            <span className="summary-label">Service revenue</span>
            <span className="summary-value">{merged.totalRevenue != null ? fmt$(merged.totalRevenue) : '—'}</span>
          </div>
          <div className="summary-row summary-row--highlight">
            <span className="summary-label">TSTH</span>
            <span className="summary-value">{fmtRate(merged.totalRevPerHour)}</span>
          </div>
          <div className="summary-row">
            <span className="summary-label">Total payroll</span>
            <span className="summary-value">{merged.totalPayroll != null ? fmt$(merged.totalPayroll) : '—'}</span>
          </div>
          {collectionsTotal != null && (
            <div className="summary-row">
              <span className="summary-label">Store collections</span>
              <span className="summary-value">{fmt$(collectionsTotal)}</span>
            </div>
          )}
        </>
      ) : (
        <p className="empty-note">No hours/sales data in this snapshot</p>
      )}

      {expanded && merged?.employees?.length > 0 && (
        <div className="ledger-scroll history-emp-scroll">
          <table className="ledger-table">
            <thead>
              <tr><th className="ledger-name-col">Employee</th><th>Hours</th><th>Service Rev</th><th>Retail Sales</th><th>TSTH</th></tr>
            </thead>
            <tbody>
              {merged.employees.map(e => (
                <tr key={e.name}>
                  <td className="ledger-name-col">{e.name}</td>
                  <td>{e.hoursDisplay || '—'}</td>
                  <td>{fmt$(e.serviceRevenue)}</td>
                  <td>{fmt$(e.retailSales)}</td>
                  <td className="ledger-rate">{fmtRate(e.revPerHour)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HistoryTab({ reportPeriods }) {
  const sorted = useMemo(
    () => [...reportPeriods].sort((a, b) => (b.fromDate || b.updatedAt || '').localeCompare(a.fromDate || a.updatedAt || '')),
    [reportPeriods]
  );
  if (!sorted.length) {
    return (
      <div className="tab-content">
        <div className="empty-state">
          <p className="empty-title">No reports uploaded yet</p>
          <p>Every report you upload shows up here automatically, filed by its own date range — nothing you upload is ever overwritten or lost.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="tab-content">
      <p className="section-label">Every period ever uploaded, newest first.</p>
      <div className="history-list">
        {sorted.map(entry => <HistoryEntryCard key={entry.id} entry={entry} />)}
      </div>
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Employee Performance', 'By Store', 'P&L', 'Weekly Report', 'History', 'Setup'];
const COMPARE_TABS = ['Overview', 'Employee Performance', 'By Store', 'P&L'];
const emptyRange = { a: { from: '', to: '' }, b: { from: '', to: '' } };

export default function App() {
  const [reportPeriods, setReportPeriods] = useState([]);
  const [compareRange, setCompareRange] = useState(emptyRange);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');
  const [toast, setToast] = useState(null);
  const [uploadingKind, setUploadingKind] = useState(null); // 'hours'|'sales'|'collections'|null
  const [fixedExpenses, setFixedExpenses] = useState({}); // { [storeName]: { rent, utilities, ... } }
  const [weeklyReportData, setWeeklyReportData] = useState(emptyWeeklyReportData());

  useEffect(() => {
    loadPeriods().then(({ data: saved, source, error }) => {
      let list = saved.report_periods;
      if (!list) {
        list = migrateLegacyToReportPeriods(saved);
        if (list.length) savePeriod('report_periods', list);
      }
      setReportPeriods(list);
      setCompareRange(computeDefaultRange(list));
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
      if (isConfigured() && source === 'local') {
        showToast(`Couldn't reach Supabase (${error || 'unknown error'}) — showing this device's local data only`, 'error');
      }
    }).catch(() => setLoading(false));
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleFile = useCallback(async (kind, file) => {
    setUploadingKind(kind);
    try {
      const parsed = kind === 'hours' ? await parseHoursFile(file)
        : kind === 'sales' ? await parseSalesFile(file)
        : await parseStoreCollectionFile(file);

      // Hours/sales files carry their own date range — match against an
      // existing period with the same range (a correction) or start a new
      // one. Collection-summary files have no date range of their own, so
      // they file under whichever period was most recently touched.
      let matchIdx = -1;
      if (parsed.fromDate && parsed.toDate) {
        matchIdx = reportPeriods.findIndex(p => p.fromDate === parsed.fromDate && p.toDate === parsed.toDate);
      } else if (parsed.dateRangeLabel) {
        matchIdx = reportPeriods.findIndex(p => p.label === parsed.dateRangeLabel);
      } else if (kind === 'collections') {
        matchIdx = reportPeriods.reduce((bestIdx, p, i) => (p.fromDate && (bestIdx === -1 || p.fromDate > reportPeriods[bestIdx].fromDate)) ? i : bestIdx, -1);
      }

      const now = new Date().toISOString();
      let next;
      if (matchIdx >= 0) {
        next = reportPeriods.map((p, i) => i === matchIdx
          ? { ...p, [kind]: parsed, label: p.label || parsed.dateRangeLabel || '', updatedAt: now }
          : p);
      } else {
        next = [...reportPeriods, {
          id: newPeriodId(),
          label: parsed.dateRangeLabel || (kind === 'collections' ? 'Collections upload' : 'Untitled period'),
          fromDate: parsed.fromDate || null,
          toDate: parsed.toDate || null,
          hours: null, sales: null, collections: null,
          [kind]: parsed,
          updatedAt: now,
        }];
      }

      setReportPeriods(next);
      const result = await savePeriod('report_periods', next);
      const desc = kind === 'collections'
        ? `${Object.keys(parsed.stores).length} stores found`
        : `${parsed.employees.length} employees found`;
      if (isConfigured() && !result.ok) {
        showToast(`Loaded ${file.name}, but couldn't sync to Supabase (${result.error}) — only visible on this device`, 'error');
      } else {
        showToast(matchIdx >= 0 ? `Loaded ${file.name} — ${desc}` : `New period added — ${desc}`);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploadingKind(null);
    }
  }, [reportPeriods]);

  const handleRangeChange = useCallback((side, field, value) => {
    setCompareRange(prev => ({ ...prev, [side]: { ...prev[side], [field]: value } }));
  }, []);

  const handleMonthToDate = useCallback(() => {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth();
    const bFrom = toISODate(new Date(y, m, 1));
    const bTo = toISODate(today);
    const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
    const daysInPrevMonth = new Date(py, pm + 1, 0).getDate();
    const aFrom = toISODate(new Date(py, pm, 1));
    const aTo = toISODate(new Date(py, pm, Math.min(today.getDate(), daysInPrevMonth)));
    setCompareRange({ a: { from: aFrom, to: aTo }, b: { from: bFrom, to: bTo } });
  }, []);

  const handleClearAll = async () => {
    if (!window.confirm('Permanently delete every uploaded report and period? This cannot be undone.')) return;
    setReportPeriods([]);
    setCompareRange(emptyRange);
    await savePeriod('report_periods', []);
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

  const periodsA = useMemo(() => periodsOverlappingRange(reportPeriods, compareRange.a), [reportPeriods, compareRange.a]);
  const periodsB = useMemo(() => periodsOverlappingRange(reportPeriods, compareRange.b), [reportPeriods, compareRange.b]);
  const mergedA = useMemo(() => mergePeriod(combineHours(periodsA), combineSales(periodsA)), [periodsA]);
  const mergedB = useMemo(() => mergePeriod(combineHours(periodsB), combineSales(periodsB)), [periodsB]);
  const collectionsB = useMemo(() => combineCollections(periodsB), [periodsB]);
  const labelA = rangeLabel(compareRange.a);
  const labelB = rangeLabel(compareRange.b);
  const hasAnyData = reportPeriods.length > 0;

  if (loading) return <div className="app-loading"><div className="spinner large" /></div>;

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Employee Performance</h1>
          <p className="app-subtitle">
            {mergedA?.location || mergedB?.location || 'Labor hours vs. service sales, side by side'}
          </p>
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
            merged={mergedB} collections={collectionsB}
            fixedExpenses={fixedExpenses} onSaveFixedExpenses={handleSaveFixedExpenses}
          />
        )}
        {tab === 'Weekly Report' && (
          <WeeklyReportTab data={weeklyReportData} onChange={setWeeklyReportData} showToast={showToast} />
        )}
        {tab === 'History' && <HistoryTab reportPeriods={reportPeriods} />}
        {tab === 'Setup' && (
          <SetupTab
            configured={isConfigured()} reportPeriods={reportPeriods} uploadingKind={uploadingKind}
            onFile={handleFile}
          />
        )}
      </main>
    </div>
  );
}

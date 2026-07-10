import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Tooltip, Legend
} from 'chart.js';
import { loadPeriods, savePeriod, clearPeriods, isConfigured } from './db';
import { parseHoursFile, parseSalesFile, normalizeEmployeeName } from './parser';
import { STORE_ROSTER } from './storeRoster';
import { getHourlyRate, laborCost } from './hourlyRates';
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

// ─── Merge one period's hours + sales into a single comparable dataset ─────
function mergePeriod(hours, sales) {
  if (!hours && !sales) return null;
  const map = new Map();

  (hours?.employees || []).forEach(e => {
    map.set(normalizeEmployeeName(e.name), {
      name: e.name, hoursDecimal: e.hoursDecimal, hoursDisplay: e.hoursDisplay, serviceRevenue: null,
    });
  });
  (sales?.employees || []).forEach(e => {
    const key = normalizeEmployeeName(e.name);
    const existing = map.get(key);
    if (existing) existing.serviceRevenue = e.serviceRevenue;
    else map.set(key, { name: e.name, hoursDecimal: null, hoursDisplay: null, serviceRevenue: e.serviceRevenue });
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
  const totalRevPerHour = (totalHours && totalRevenue != null && totalHours > 0) ? totalRevenue / totalHours : null;

  return {
    location: hours?.location || null,
    totalHours,
    totalHoursDisplay: hours?.totalHoursDisplay || null,
    totalRevenue,
    totalRevPerHour,
    otherRevenue: sales?.otherRevenue || 0,
    employees,
    hoursOnly,
    salesOnly,
    hasHours: !!hours,
    hasSales: !!sales,
    complete: !!hours && !!sales,
  };
}

// ─── Signature element: a balance scale that tips toward the more ──────────
// ─── productive period (higher revenue per labor hour) ─────────────────────
function BalanceScale({ leftLabel, rightLabel, leftValue, rightValue }) {
  const lv = leftValue || 0;
  const rv = rightValue || 0;
  const maxV = Math.max(Math.abs(lv), Math.abs(rv), 1);
  const angle = Math.max(-9, Math.min(9, ((rv - lv) / maxV) * 9));

  return (
    <div className="balance">
      <svg viewBox="0 0 320 150" className="balance-svg" aria-hidden="true">
        <polygon points="150,142 170,142 160,116" className="balance-base" />
        <rect x="146" y="140" width="28" height="6" rx="2" className="balance-foot" />
        <line x1="160" y1="18" x2="160" y2="118" className="balance-post" />
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: '160px 32px' }} className="balance-beam-group">
          <line x1="30" y1="32" x2="290" y2="32" className="balance-beam" />
          <circle cx="160" cy="32" r="6" className="balance-hinge" />
          <line x1="30" y1="32" x2="30" y2="62" className="balance-chain" />
          <line x1="290" y1="32" x2="290" y2="62" className="balance-chain" />
          <ellipse cx="30" cy="68" rx="27" ry="9" className="balance-pan" />
          <ellipse cx="290" cy="68" rx="27" ry="9" className="balance-pan" />
        </g>
      </svg>
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

function PeriodPanel({ periodKey, periodNum, period, uploadingSlot, onFile, onLabelChange }) {
  const hours = period?.hours;
  const sales = period?.sales;
  return (
    <div className="period-panel">
      <div className="period-panel-head">
        <span className="period-eyebrow">Period {periodNum}</span>
        <input
          className="period-label-input"
          placeholder="Date range (fills in automatically)"
          value={period?.label || ''}
          onChange={e => onLabelChange(e.target.value)}
        />
      </div>
      <div className="period-slots">
        <UploadSlot
          inputId={`${periodKey}-hours`}
          title="Hours worked"
          hint="Upload the attendance / hours export"
          accent="steel"
          uploading={uploadingSlot === 'hours'}
          fileInfo={hours ? { fileName: hours.fileName, sub: `${hours.employees.length} employees · ${hours.totalHoursDisplay} total` } : null}
          onFile={file => onFile('hours', file)}
        />
        <UploadSlot
          inputId={`${periodKey}-sales`}
          title="Service sales"
          hint="Upload the sales / KPI export"
          accent="sage"
          uploading={uploadingSlot === 'sales'}
          fileInfo={sales ? { fileName: sales.fileName, sub: `${sales.employees.length} employees · ${fmt$(sales.totalServiceRevenue)} total` } : null}
          onFile={file => onFile('sales', file)}
        />
      </div>
    </div>
  );
}

// ─── Overview tab ───────────────────────────────────────────────────────────
function PeriodSummaryCard({ label, data, deltaHours, deltaRevenue, deltaRate }) {
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
        <PeriodSummaryCard label={label2} data={p2} deltaHours={deltaHours} deltaRevenue={deltaRevenue} deltaRate={deltaRate} />
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

function LedgerTable({ rows, label1, label2 }) {
  return (
    <div className="ledger-scroll">
      <table className="ledger-table">
        <thead>
          <tr>
            <th className="ledger-name-col">Employee</th>
            <th>Rate</th>
            <th colSpan={5} className="ledger-group-head ledger-group-head--steel">{label1}</th>
            <th colSpan={5} className="ledger-group-head ledger-group-head--sage">{label2}</th>
            <th>Δ TSTH</th>
          </tr>
          <tr className="ledger-subhead">
            <th></th>
            <th></th>
            <th>Hours</th><th>Revenue</th><th>TSTH</th><th>Labor Cost</th><th>Margin</th>
            <th>Hours</th><th>Revenue</th><th>TSTH</th><th>Labor Cost</th><th>Margin</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const delta = (r.p1?.revPerHour != null && r.p2?.revPerHour != null) ? r.p2.revPerHour - r.p1.revPerHour : null;
            const rate = getHourlyRate(r.name);
            const cost1 = rate != null ? laborCost(r.p1?.hoursDecimal ?? null, rate) : null;
            const cost2 = rate != null ? laborCost(r.p2?.hoursDecimal ?? null, rate) : null;
            const margin1 = (cost1 != null && r.p1?.serviceRevenue != null) ? r.p1.serviceRevenue - cost1 : null;
            const margin2 = (cost2 != null && r.p2?.serviceRevenue != null) ? r.p2.serviceRevenue - cost2 : null;
            return (
              <tr key={r.name}>
                <td className="ledger-name-col">{r.name}</td>
                <td>{rate != null ? `$${rate.toFixed(2)}` : '—'}</td>
                <td>{r.p1?.hoursDisplay || '—'}</td>
                <td>{r.p1?.serviceRevenue != null ? fmt$(r.p1.serviceRevenue) : '—'}</td>
                <td className="ledger-rate">{fmtRate(r.p1?.revPerHour)}</td>
                <td>{cost1 != null ? fmt$(cost1) : '—'}</td>
                <td className={margin1 != null && margin1 < 0 ? 'ledger-margin-neg' : ''}>{margin1 != null ? fmt$(margin1) : '—'}</td>
                <td>{r.p2?.hoursDisplay || '—'}</td>
                <td>{r.p2?.serviceRevenue != null ? fmt$(r.p2.serviceRevenue) : '—'}</td>
                <td className="ledger-rate">{fmtRate(r.p2?.revPerHour)}</td>
                <td>{cost2 != null ? fmt$(cost2) : '—'}</td>
                <td className={margin2 != null && margin2 < 0 ? 'ledger-margin-neg' : ''}>{margin2 != null ? fmt$(margin2) : '—'}</td>
                <td>{delta != null ? <Badge curr={r.p2.revPerHour} prev={r.p1.revPerHour} /> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
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
      { label: label1, data: chartRows.map(r => r.p1?.revPerHour != null ? Math.round(r.p1.revPerHour * 100) / 100 : null), backgroundColor: '#4B6C87', borderRadius: 4 },
      { label: label2, data: chartRows.map(r => r.p2?.revPerHour != null ? Math.round(r.p2.revPerHour * 100) / 100 : null), backgroundColor: '#5C7A63', borderRadius: 4 },
    ],
  };
  const chartOpts = {
    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: '#5b6270', font: { size: 11, family: 'Work Sans' }, boxWidth: 12 } },
      tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtRate(ctx.parsed.x)}` } },
    },
    scales: {
      x: { grid: { color: 'rgba(35,40,47,0.06)' }, ticks: { color: '#5b6270', callback: v => '$' + v, font: { size: 10, family: 'IBM Plex Mono' } } },
      y: { grid: { display: false }, ticks: { color: '#23282f', font: { size: 11, family: 'Work Sans' } } },
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

// ─── Setup tab ──────────────────────────────────────────────────────────────
function SetupTab({ configured }) {
  const steps = [
    { n: 1, title: 'Export your two hours reports', body: 'From your scheduling/POS system, run the attendance (hours) report for each period you want to compare — e.g. this week and last week.' },
    { n: 2, title: 'Export your two sales reports', body: 'Run the service-sales (KPI) report for the exact same two date ranges. The Service Revenue column is the one this app reads.' },
    { n: 3, title: 'Upload all four files', body: 'Tap + on each of the four slots above: Hours and Sales for Period 1, then Hours and Sales for Period 2. The date range label fills in automatically from the file.' },
    { n: 4, title: 'Employees are grouped by store automatically', body: 'The "By Store" tab groups this same comparison by location. The employee → store list is built into the app — no upload needed for it.' },
    { n: 5, title: 'Read the comparison', body: 'Overview shows total productivity (TSTH — revenue per labor hour) for each period. Employee Performance and By Store show the same breakdown per person, including hourly rate, labor cost (with an 8% payroll tax built in), and the margin between what someone produced and what they cost. Only employees with both an hours record and a sales record for a period are included.' },
    { n: 6, title: 'Add to your phone home screen', body: 'On iPhone: open the app URL in Safari → Share → "Add to Home Screen." On Android: Chrome → three dots → "Add to Home Screen."' },
  ];
  return (
    <div className="tab-content setup-tab">
      <div className={`setup-status ${configured ? 'setup-status--ok' : 'setup-status--warn'}`}>
        {configured
          ? '✓ Connected to Supabase — your data syncs across devices.'
          : '⚠ Supabase not connected — data is only saved on this device. See below to enable cross-device sync.'}
      </div>
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
);`}</pre>
          <p className="step-body">Then add <code>REACT_APP_SUPABASE_URL</code> and <code>REACT_APP_SUPABASE_ANON_KEY</code> as environment variables in Vercel, using the values from Supabase → Settings → API.</p>
        </div>
      )}
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────────────
const TABS = ['Overview', 'Employee Performance', 'By Store', 'Setup'];
const emptyPeriod = { label: '', hours: null, sales: null };

export default function App() {
  const [periods, setPeriods] = useState({ period1: emptyPeriod, period2: emptyPeriod });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('Overview');
  const [toast, setToast] = useState(null);
  const [uploadingSlot, setUploadingSlot] = useState({}); // { period1: 'hours'|'sales'|null, ... }
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => {
    loadPeriods().then(saved => {
      setPeriods({
        period1: { ...emptyPeriod, ...(saved.period1 || {}) },
        period2: { ...emptyPeriod, ...(saved.period2 || {}) },
      });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleFile = useCallback(async (periodKey, kind, file) => {
    setUploadingSlot(prev => ({ ...prev, [periodKey]: kind }));
    try {
      const parsed = kind === 'hours' ? await parseHoursFile(file) : await parseSalesFile(file);
      setPeriods(prev => {
        const cur = prev[periodKey] || emptyPeriod;
        const next = { ...cur, [kind]: parsed };
        if (!cur.label && parsed.dateRangeLabel) next.label = parsed.dateRangeLabel;
        savePeriod(periodKey, next);
        return { ...prev, [periodKey]: next };
      });
      showToast(`Loaded ${file.name} — ${parsed.employees.length} employees found`);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploadingSlot(prev => ({ ...prev, [periodKey]: null }));
    }
  }, []);

  const handleLabelChange = useCallback((periodKey, text) => {
    setPeriods(prev => {
      const next = { ...prev[periodKey], label: text };
      savePeriod(periodKey, next);
      return { ...prev, [periodKey]: next };
    });
  }, []);

  const handleClearAll = async () => {
    if (!window.confirm('Clear all uploaded files and start over? This cannot be undone.')) return;
    await clearPeriods();
    setPeriods({ period1: emptyPeriod, period2: emptyPeriod });
    setPanelOpen(true);
    showToast('All data cleared');
  };

  const merged1 = useMemo(() => mergePeriod(periods.period1?.hours, periods.period1?.sales), [periods.period1]);
  const merged2 = useMemo(() => mergePeriod(periods.period2?.hours, periods.period2?.sales), [periods.period2]);
  const label1 = periods.period1?.label || 'Period 1';
  const label2 = periods.period2?.label || 'Period 2';
  const hasAnyData = !!(periods.period1?.hours || periods.period1?.sales || periods.period2?.hours || periods.period2?.sales);
  const bothComplete = merged1?.complete && merged2?.complete;

  if (loading) return <div className="app-loading"><div className="spinner large" /></div>;

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}

      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Employee Performance</h1>
          <p className="app-subtitle">
            {merged1?.location || merged2?.location || 'Labor hours vs. service sales, side by side'}
          </p>
        </div>
        <div className="header-right">
          {hasAnyData && <button className="btn-ghost" onClick={handleClearAll}>Clear all</button>}
        </div>
      </header>

      {(!bothComplete || panelOpen) && (
        <section className="upload-center">
          <div className="upload-center-grid">
            <PeriodPanel
              periodKey="period1" periodNum="1" period={periods.period1}
              uploadingSlot={uploadingSlot.period1}
              onFile={(kind, file) => handleFile('period1', kind, file)}
              onLabelChange={text => handleLabelChange('period1', text)}
            />
            <PeriodPanel
              periodKey="period2" periodNum="2" period={periods.period2}
              uploadingSlot={uploadingSlot.period2}
              onFile={(kind, file) => handleFile('period2', kind, file)}
              onLabelChange={text => handleLabelChange('period2', text)}
            />
          </div>
          {bothComplete && (
            <button className="btn-ghost btn-collapse" onClick={() => setPanelOpen(false)}>Hide file panel ↑</button>
          )}
        </section>
      )}

      {bothComplete && !panelOpen && (
        <button className="manage-files-bar" onClick={() => setPanelOpen(true)}>
          Manage the 4 uploaded files ↓
        </button>
      )}

      {hasAnyData ? (
        <>
          <nav className="tab-nav">
            {TABS.map(t => (
              <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </nav>
          <main className="app-main">
            {tab === 'Overview' && <OverviewTab p1={merged1} p2={merged2} label1={label1} label2={label2} />}
            {tab === 'Employee Performance' && <EmployeesTab p1={merged1} p2={merged2} label1={label1} label2={label2} />}
            {tab === 'By Store' && <ByStoreTab p1={merged1} p2={merged2} label1={label1} label2={label2} />}
            {tab === 'Setup' && <SetupTab configured={isConfigured()} />}
          </main>
        </>
      ) : (
        <main className="app-main">
          <SetupTab configured={isConfigured()} />
        </main>
      )}
    </div>
  );
}

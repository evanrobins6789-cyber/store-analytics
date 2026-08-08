import React, { useState, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  n, money, pct, fmtDate, daysInclusive, combineWeeks, combineMonths,
  buildMonthlyComparison, PACING_PERIODS,
  buildStudioWeekRow, buildStudioMTDRow, buildEmployeeRow, computeBonus,
  upsertByStart, upsertMonthTotal, monthKey, monthLabel,
  buildMembershipSnapshot, buildCollectionsSummary,
} from './compute';
import {
  parseKPI, parseAttendance, parseSalesAccrual, parseCerologistKPI,
  parseMemberships, parseCollections, parseGuestRetention,
} from './parsers';
import { STUDIOS } from './constants';
import { saveWeeklyReportData } from './store';

// Ported from Lauren's wtc-weekly-report app (a separate Next.js site) into
// this app as one self-contained tab. Original: components/Dashboard.jsx,
// GoalThermometer.jsx, PacingCharts.jsx, and the /upload, /memberships,
// /collections, /guest-retention, /supply-costs pages — all folded into
// sub-views here since this app is one tab per feature area, not one page
// per feature. State lives in App.js (`weeklyReportData`) and is persisted
// through ../db.js's existing Supabase `periods` table (see ./store.js).

const SUB_TABS = ['Dashboard', 'Memberships', 'Collections', 'Guest Retention', 'Supply Costs', 'Upload & Goals'];

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

export default function WeeklyReportTab({ data, onChange, showToast }) {
  const [sub, setSub] = useState('Dashboard');

  async function persist(next) {
    onChange(next);
    const result = await saveWeeklyReportData(next);
    if (!result.ok) {
      showToast(`Saved locally, but couldn't sync to Supabase (${result.error})`, 'error');
    }
    return result;
  }

  return (
    <div className="wr-tab">
      <div className="wr-subnav">
        {SUB_TABS.map(t => (
          <button key={t} className={`wr-subtab ${sub === t ? 'active' : ''}`} onClick={() => setSub(t)}>{t}</button>
        ))}
      </div>

      {sub === 'Dashboard' && <DashboardView data={data} persist={persist} />}
      {sub === 'Memberships' && <MembershipsView data={data} />}
      {sub === 'Collections' && <CollectionsView data={data} persist={persist} />}
      {sub === 'Guest Retention' && <GuestRetentionView data={data} persist={persist} showToast={showToast} />}
      {sub === 'Supply Costs' && <SupplyCostsView data={data} persist={persist} showToast={showToast} />}
      {sub === 'Upload & Goals' && <UploadView data={data} persist={persist} showToast={showToast} />}
    </div>
  );
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

const COLS = [
  ['range', 'Date Range'], ['guest_count', 'Guest Count'], ['new_guests', 'New Guests'],
  ['serv_per_guest', 'Serv./Guest'], ['total_services', 'Total Services'], ['sales', 'Sales $'],
  ['sales_per_day', 'Sales/day'], ['total_discounts', 'TOTAL DISCOUNTS'], ['total_collections', 'TOTAL COLLECTIONS'],
  ['at', 'A.T.'], ['tsth', 'TSTH'], ['total_hours', 'Total Hours'], ['retail', 'Retail $'], ['rpg', 'RPG'],
  ['addon', 'Add-On Services'], ['packages_dollars', 'Packages $'], ['packages', 'Packages'],
  ['co_enrollment', 'CO ENROLLMENT'], ['rebooking_pct', 'REBOOKING %'],
];

const EMP_COLS = [
  ['range', 'Date Range'], ['guests', 'Guests'], ['services', 'Services'], ['rebook_pct', 'Rebooking %'],
  ['membership', 'Membership'], ['service_revenue', 'Service Rev.'], ['avg_invoice_value', 'A.T.'],
  ['avg_services_per_invoice', 'Serv./Invoice'], ['product_revenue', 'Product Rev.'],
  ['pct_product_invoices', '% Product/Inv.'], ['total_sales', 'Total Sales'], ['total_hours', 'Total Hours'], ['tsth', 'TSTH'],
];

const GOAL_FIELDS = [
  ['total_collections', 'Total Collections', v => money(v), true, v => money(v, 0)],
  ['retail', 'Retail $', v => money(v), true, v => money(v, 0)],
  ['tsth', 'TSTH', v => money(Math.round(v)), false, null],
  ['addon', 'Add-On Services', v => n(v), true, v => n(v, 1)],
  ['co_enrollment', 'Memberships', v => n(v), true, v => n(v, 1)],
  ['new_guests', 'New Guests', v => n(v), true, v => n(v, 1)],
];

function renderCell(key, row) {
  switch (key) {
    case 'range': return `${fmtDate(row.start)} - ${fmtDate(row.end)}`;
    case 'guest_count': case 'new_guests': case 'total_services': case 'total_hours':
    case 'packages': case 'co_enrollment': return n(row[key]);
    case 'serv_per_guest': return row.serv_per_guest != null ? row.serv_per_guest.toFixed(2) : '';
    case 'at': return money(row.at, 2);
    case 'sales': case 'sales_per_day': case 'total_discounts': case 'total_collections':
    case 'retail': case 'rpg': case 'addon': case 'packages_dollars': return money(row[key]);
    case 'tsth': return money(row.tsth != null ? Math.round(row.tsth) : null);
    case 'rebooking_pct': return pct(row.rebooking_pct);
    default: return '';
  }
}

function renderEmpCell(key, row) {
  switch (key) {
    case 'range': return `${fmtDate(row.start)} - ${fmtDate(row.end)}`;
    case 'guests': case 'services': case 'membership': return n(row[key]);
    case 'total_hours': return row.total_hours != null ? n(row.total_hours, 1) : '';
    case 'avg_services_per_invoice': return row.avg_services_per_invoice != null ? row.avg_services_per_invoice.toFixed(2) : '';
    case 'rebook_pct': case 'pct_product_invoices': return pct(row[key]);
    case 'service_revenue': case 'product_revenue': return money(row[key]);
    case 'total_sales': return row.guests == null ? '' : money(row.total_sales);
    case 'avg_invoice_value': return money(row.avg_invoice_value, 2);
    case 'tsth': return row.tsth != null ? money(Math.round(row.tsth)) : '';
    default: return '';
  }
}

function DashboardView({ data, persist }) {
  const [view, setView] = useState('All Studios');
  const [year, setYear] = useState(null);
  const [busy, setBusy] = useState(null);

  const options = ['All Studios', ...STUDIOS];
  const activeStudios = view === 'All Studios' ? STUDIOS : [view];

  const months = useMemo(() => combineMonths(data.studios, activeStudios), [data.studios, view]);
  const weeks = useMemo(() => combineWeeks(data.studios, activeStudios, data.currentMonthKey), [data.studios, view, data.currentMonthKey]);

  const currentMonthLabel = months.find(m => m.start.slice(0, 7) === data.currentMonthKey)?.label;
  const mtd = months.find(m => m.label === currentMonthLabel) || null;
  const lastReportedWeek = [...weeks].reverse().find(w => w.has_data) || null;
  if (mtd && lastReportedWeek) {
    const daysCompleted = daysInclusive(mtd.start, lastReportedWeek.end);
    mtd.sales_per_day = mtd.sales ? mtd.sales / daysCompleted : null;
  }
  const historyMonths = months.filter(m => m.label !== currentMonthLabel);
  const currentYear = (mtd ? mtd.start.slice(0, 4) : null) || (data.currentMonthKey ? data.currentMonthKey.slice(0, 4) : null);
  const effectiveYear = year ?? currentYear ?? 'All Years';

  const years = ['All Years', ...Array.from(new Set(months.map(m => m.start.slice(0, 4)))).sort((a, b) => b.localeCompare(a))];
  const shownHistoryMonths = effectiveYear === 'All Years' ? historyMonths : historyMonths.filter(m => m.start.slice(0, 4) === effectiveYear);
  const showCurrentPeriod = effectiveYear === 'All Years' || effectiveYear === currentYear;

  function monthLabelFromKey(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
  }
  function goalMonthPropsFor(studio) {
    const now = new Date();
    const goalMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const studioMonths = combineMonths(data.studios, [studio]);
    const goalMonthRow = studioMonths.find(m => m.start.slice(0, 7) === goalMonthKey) || {
      label: monthLabelFromKey(goalMonthKey),
      start: `${goalMonthKey}-01`, end: `${goalMonthKey}-01`,
      total_collections: 0, retail: 0, tsth: 0, addon: 0, co_enrollment: 0, new_guests: 0,
    };
    const studioWeeks = combineWeeks(data.studios, [studio], goalMonthKey);
    const goalMonthLastReportedWeek = [...studioWeeks].reverse().find(w => w.has_data) || null;
    return {
      monthKey: goalMonthKey,
      monthLabel: goalMonthRow.label,
      asOfDate: goalMonthLastReportedWeek?.end,
      mtd: goalMonthRow,
      goals: data.goals?.[studio]?.[goalMonthKey],
    };
  }

  async function handleRemoveMonth(label) {
    if (!window.confirm(`Remove "${label}" from history? This removes it from all studios and can't be undone.`)) return;
    setBusy(label);
    const next = cloneData(data);
    STUDIOS.forEach(s => {
      next.studios[s].month_totals = next.studios[s].month_totals.filter(m => m.label !== label);
    });
    await persist(next);
    setBusy(null);
  }

  async function handleClearPayPeriod(period, label) {
    if (!window.confirm(`Clear ${label} for every employee across all studios? This can't be undone.`)) return;
    setBusy(period);
    const next = cloneData(data);
    STUDIOS.forEach(s => {
      Object.keys(next.employees[s] || {}).forEach(name => {
        const emp = next.employees[s][name];
        if (emp.bonus && emp.bonus[period]) {
          const { start, end } = emp.bonus[period];
          emp.bonus[period] = { available: false, start, end };
        }
      });
    });
    await persist(next);
    setBusy(null);
  }

  return (
    <div className="wr-panel-stack">
      <div className="wr-toolbar">
        <div className="wr-pill-group">
          {years.map(y => (
            <button key={y} className={`wr-pill ${effectiveYear === y ? 'active' : ''}`} onClick={() => setYear(y)}>{y}</button>
          ))}
        </div>
        <div className="wr-pill-group">
          {options.map(o => (
            <button key={o} className={`wr-pill ${view === o ? 'active' : ''}`} onClick={() => setView(o)}>{o}</button>
          ))}
        </div>
      </div>

      <div className="wr-table-scroll">
        <table className="wr-table">
          <thead><tr>{COLS.map(([key, label]) => (
            <th key={key} className={key === 'range' ? 'wr-left' : ''}>{label}</th>
          ))}</tr></thead>
          <tbody>
            {shownHistoryMonths.map(row => (
              <tr key={row.label} className="wr-row-total">
                {COLS.map(([key]) => (
                  <td key={key} className={key === 'range' ? 'wr-left' : ''}>
                    {key === 'range' ? (
                      <>
                        {row.label}
                        <button
                          className="wr-remove-btn"
                          onClick={() => handleRemoveMonth(row.label)}
                          disabled={busy === row.label}
                          title={`Remove ${row.label} from history`}
                        >
                          {busy === row.label ? 'removing...' : 'remove'}
                        </button>
                      </>
                    ) : renderCell(key, row)}
                  </td>
                ))}
              </tr>
            ))}
            {showCurrentPeriod && weeks.map(row => {
              const isCurrent = lastReportedWeek && row.start === lastReportedWeek.start;
              return (
                <tr key={row.start}>
                  {COLS.map(([key]) => (
                    <td key={key} className={`${key === 'range' ? 'wr-left' : ''} ${isCurrent ? 'wr-cell-current' : ''}`}>
                      {key === 'range' ? (<>{fmtDate(row.start)} - {fmtDate(row.end)}{isCurrent && <span className="wr-badge-new">NEW</span>}</>) : renderCell(key, row)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {showCurrentPeriod && mtd && (
              <tr className="wr-row-total">
                {COLS.map(([key]) => <td key={key} className={key === 'range' ? 'wr-left' : ''}>{key === 'range' ? `${mtd.label} (MTD)` : renderCell(key, mtd)}</td>)}
              </tr>
            )}
            {!shownHistoryMonths.length && !(showCurrentPeriod && weeks.length) && !(showCurrentPeriod && mtd) && (
              <tr><td colSpan={COLS.length} className="wr-empty-cell">No data uploaded yet — use the Upload &amp; Goals tab to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {view !== 'All Studios' && activeStudios.map(studio => (
        <div key={studio} className="wr-studio-block">
          <GoalsThermometers studio={studio} fields={GOAL_FIELDS} {...goalMonthPropsFor(studio)} />

          <div className="wr-section-head">
            <div className="wr-section-title">{studio} — Employees</div>
            <button className="wr-link-btn" onClick={() => handleClearPayPeriod('pay_period_1', 'Pay Period 1')} disabled={busy === 'pay_period_1'}>
              {busy === 'pay_period_1' ? 'clearing PP1...' : 'clear PP1 (all employees)'}
            </button>
            <button className="wr-link-btn" onClick={() => handleClearPayPeriod('pay_period_2', 'Pay Period 2')} disabled={busy === 'pay_period_2'}>
              {busy === 'pay_period_2' ? 'clearing PP2...' : 'clear PP2 (all employees)'}
            </button>
          </div>

          {(data.activeEmployees?.[studio] || []).map(empName => {
            const empData = data.employees[studio]?.[empName];
            if (!empData) return null;
            const empMonths = empData.month_totals || [];
            const empMtd = empMonths.find(m => m.start.slice(0, 7) === data.currentMonthKey) || empMonths[empMonths.length - 1] || null;
            const empHistory = empMonths.filter(m => m !== empMtd);
            const empWeeks = empMtd ? (empData.all_weeks || []).filter(w => w.start.slice(0, 7) === data.currentMonthKey || w.end.slice(0, 7) === data.currentMonthKey) : [];
            const empLastReportedWeek = [...empWeeks].reverse().find(w => w.guests !== null && w.guests !== undefined) || null;
            const b = empData.bonus || {};
            return (
              <div key={empName} className="wr-emp-block">
                <div className="wr-emp-name">{empName}</div>
                <div className="wr-table-scroll">
                  <table className="wr-table">
                    <thead><tr>{EMP_COLS.map(([key, label]) => <th key={key} className={key === 'range' ? 'wr-left' : ''}>{label}</th>)}</tr></thead>
                    <tbody>
                      {empHistory.map(row => (
                        <tr key={row.label} className="wr-row-total">
                          {EMP_COLS.map(([key]) => <td key={key} className={key === 'range' ? 'wr-left' : ''}>{key === 'range' ? row.label : renderEmpCell(key, row)}</td>)}
                        </tr>
                      ))}
                      {empWeeks.map(row => {
                        const isCurrent = empLastReportedWeek && row.start === empLastReportedWeek.start;
                        return (
                          <tr key={row.start}>
                            {EMP_COLS.map(([key]) => (
                              <td key={key} className={`${key === 'range' ? 'wr-left' : ''} ${isCurrent ? 'wr-cell-current' : ''}`}>
                                {key === 'range' ? (<>{fmtDate(row.start)} - {fmtDate(row.end)}{isCurrent && <span className="wr-badge-new">NEW</span>}</>) : renderEmpCell(key, row)}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                      {empMtd && (
                        <tr className="wr-row-total">
                          {EMP_COLS.map(([key]) => <td key={key} className={key === 'range' ? 'wr-left' : ''}>{key === 'range' ? `${empMtd.label} (MTD)` : renderEmpCell(key, empMtd)}</td>)}
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <BonusTable bonus={b} />
              </div>
            );
          })}

          <SupServTable rows={data.supserv[studio]} title="Supplies / Services" />
        </div>
      ))}

      {view === 'All Studios' && <PacingCharts data={data} />}

      {view === 'All Studios' && (
        <SupServTable
          rows={[...(data.supserv['Consolidated'] || []), ...(data.supserv['July Goal'] || [])]}
          title="Supplies / Services — Consolidated"
        />
      )}
    </div>
  );
}

function BonusTable({ bonus }) {
  const pp1 = bonus.pay_period_1, pp2 = bonus.pay_period_2;
  if (!pp1 && !pp2) return null;
  const fmtTier = v => {
    if (v == null) return '';
    if (v <= 0) return <span className="wr-hit">Hit (+{money(Math.abs(v))})</span>;
    return money(v);
  };
  const BONUS_COLS = ['Pay Period', 'Service Rev', 'SR Tier 1', 'SR Tier 2', 'SR Tier 3', 'SR Tier 4', 'SR Rate', 'SR Bonus', 'Retail', 'Retail Bonus', 'CO (Month)', 'CO Bonus', 'Total Bonus'];
  return (
    <div className="wr-table-scroll wr-bonus-table">
      <table className="wr-table">
        <thead><tr>{BONUS_COLS.map(label => <th key={label} className={label === 'Pay Period' ? 'wr-left' : ''}>{label}</th>)}</tr></thead>
        <tbody>
          <tr>
            <td className="wr-left">PP1{pp1 ? `: ${fmtDate(pp1.start)}-${fmtDate(pp1.end)}` : ''}</td>
            {pp1?.available ? (
              <>
                <td>{money(pp1.service_rev)}</td>
                <td>{fmtTier(pp1.tier_remaining[0])}</td>
                <td>{fmtTier(pp1.tier_remaining[1])}</td>
                <td>{fmtTier(pp1.tier_remaining[2])}</td>
                <td>{fmtTier(pp1.tier_remaining[3])}</td>
                <td>{pct(pp1.sr_rate)}</td>
                <td>{money(pp1.sr_bonus, 2)}</td>
                <td>{money(pp1.retail)}</td>
                <td>{money(pp1.retail_bonus, 2)}</td>
                <td className="wr-muted">—</td>
                <td className="wr-muted">not paid this period</td>
                <td className="wr-strong">{money(pp1.total_bonus, 2)}</td>
              </>
            ) : (
              <td colSpan={11} className="wr-empty-cell">Not yet on file</td>
            )}
          </tr>
          <tr className="wr-row-total">
            <td className="wr-left">PP2{pp2 ? `: ${fmtDate(pp2.start)}-${fmtDate(pp2.end)}` : ''}</td>
            {pp2?.available ? (
              <>
                <td>{money(pp2.service_rev)}</td>
                <td>{fmtTier(pp2.tier_remaining[0])}</td>
                <td>{fmtTier(pp2.tier_remaining[1])}</td>
                <td>{fmtTier(pp2.tier_remaining[2])}</td>
                <td>{fmtTier(pp2.tier_remaining[3])}</td>
                <td>{pct(pp2.sr_rate)}</td>
                <td>{money(pp2.sr_bonus, 2)}</td>
                <td>{money(pp2.retail)}</td>
                <td>{money(pp2.retail_bonus, 2)}</td>
                <td>{n(pp2.month_co)}</td>
                <td>{money(pp2.co_bonus, 2)}</td>
                <td className="wr-strong">{money(pp2.sr_bonus + pp2.retail_bonus + (pp2.co_bonus || 0), 2)}</td>
              </>
            ) : (
              <td colSpan={11} className="wr-empty-cell">Not yet on file</td>
            )}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function SupServTable({ rows, title }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="wr-block">
      <div className="wr-section-title">{title}</div>
      <div className="wr-table-scroll">
        <table className="wr-table">
          <thead><tr>{['Period', 'Supplies', 'Services', 'Sup/Serv', '$/Serv', 'Ratio'].map(label => (
            <th key={label} className={label === 'Period' ? 'wr-left' : ''}>{label}</th>
          ))}</tr></thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.label + i}>
                <td className="wr-left">{row.label}</td>
                <td>{money(row.supplies)}</td>
                <td>{n(row.services)}</td>
                <td>{row.sup_per_serv != null ? '$' + row.sup_per_serv.toFixed(2) : ''}</td>
                <td>{money(row.dollar_per_serv, 2)}</td>
                <td>{row.ratio != null ? pct(row.ratio) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Goal thermometers ──────────────────────────────────────────────────────

function fillColor(p) {
  if (p === null) return 'var(--line)';
  if (p >= 100) return 'var(--sage)';
  if (p >= 70) return 'var(--brass)';
  return 'var(--rust)';
}

function daysLeftInMonth(mKey, asOfDate) {
  if (!mKey) return null;
  const [y, m] = mKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  if (!asOfDate) return daysInMonth;
  const asOf = new Date(asOfDate + 'T00:00:00');
  const asOfKey = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}`;
  if (asOfKey === mKey) return Math.max(0, daysInMonth - asOf.getDate());
  return asOfKey < mKey ? daysInMonth : 0;
}

function Thermometer({ label, actual, goal, format, trackDaily, dailyFormat, daysLeft }) {
  const hasGoal = typeof goal === 'number' && goal > 0;
  const rawPct = hasGoal ? Math.round(((actual || 0) / goal) * 100) : null;
  const fillPct = hasGoal ? Math.max(0, Math.min(100, rawPct)) : 0;
  const color = fillColor(rawPct);
  const remaining = hasGoal ? Math.max(0, goal - (actual || 0)) : null;
  const hit = hasGoal && (actual || 0) >= goal;

  let paceLine = null;
  if (hasGoal && trackDaily) {
    if (hit) paceLine = 'Goal already hit — no daily pace needed.';
    else if (daysLeft === null) paceLine = null;
    else if (daysLeft <= 0) paceLine = "Month's over — goal wasn't reached.";
    else {
      const perDay = remaining / daysLeft;
      paceLine = `Need ${dailyFormat(perDay)}/day for the next ${daysLeft} day${daysLeft === 1 ? '' : 's'} to hit goal`;
    }
  }

  return (
    <div>
      <div className="wr-therm-row">
        <div className="wr-therm-label">{label}</div>
        <div className="wr-therm-track-wrap">
          <div className="wr-therm-bulb" style={{ background: hasGoal ? color : 'var(--line)' }} />
          <div className="wr-therm-track">
            <div className="wr-therm-fill" style={{ width: `${fillPct}%`, background: color }} />
            <div className="wr-therm-text">{hasGoal ? (hit ? 'Goal hit!' : `${format(remaining)} to go`) : 'No goal set'}</div>
          </div>
        </div>
        <div className="wr-therm-stat">
          {hasGoal ? (
            <>
              <div className="wr-therm-pct" style={{ color }}>{rawPct}%</div>
              <div className="wr-therm-vs">{format(actual || 0)} / {format(goal)}</div>
            </>
          ) : <div className="wr-muted">—</div>}
        </div>
      </div>
      {paceLine && <div className={`wr-therm-pace ${hit ? 'wr-hit' : ''}`}>{paceLine}</div>}
    </div>
  );
}

function GoalsThermometers({ studio, monthLabel: mLabel, monthKey: mKey, asOfDate, mtd, goals, fields }) {
  if (!mtd) return null;
  const daysLeft = daysLeftInMonth(mKey, asOfDate);
  return (
    <div className="wr-block">
      <div className="wr-section-title">Monthly Goals</div>
      <div className="wr-muted" style={{ marginBottom: 14 }}>
        {studio} — {mLabel || 'this month'}, month to date. Set or update goals on the Upload &amp; Goals tab.
      </div>
      <div className="wr-therm-panel">
        {fields.map(([key, label, format, trackDaily, dailyFormat]) => (
          <Thermometer key={key} label={label} actual={mtd[key]} goal={goals?.[key]} format={format} trackDaily={trackDaily} dailyFormat={dailyFormat} daysLeft={daysLeft} />
        ))}
      </div>
    </div>
  );
}

// ─── Pacing charts (chart.js port of Lauren's recharts version) ────────────

const PACING_METRICS = [
  { key: 'tsth', label: 'TSTH', format: v => money(v) },
  { key: 'total_hours', label: 'Total Hours', format: v => n(v, 1) },
  { key: 'new_guests', label: 'New Guests', format: v => n(v) },
  { key: 'total_collections', label: 'Total Collections', format: v => money(v) },
];

function PacingBarCard({ title, comparison, metricKey, formatValue }) {
  const points = PACING_PERIODS
    .map(({ key, color }) => ({ label: comparison[key].label, value: comparison[key].data ? comparison[key].data[metricKey] : null, color }))
    .filter(p => p.value !== null && p.value !== undefined);

  if (!points.length) {
    return (
      <div className="chart-card">
        <p className="chart-title">{title}</p>
        <div className="wr-chart-empty">Not enough data yet to compare.</div>
      </div>
    );
  }

  const chartData = {
    labels: points.map(p => p.label),
    datasets: [{ data: points.map(p => p.value), backgroundColor: points.map(p => p.color), borderRadius: 4 }],
  };
  const chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => ` ${formatValue(ctx.parsed.y)}` } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#6E655D', font: { size: 11, family: 'Work Sans' } } },
      y: { grid: { color: 'rgba(42,36,32,0.06)' }, ticks: { color: '#6E655D', font: { size: 10, family: 'IBM Plex Mono' }, callback: v => formatValue(v) } },
    },
  };

  return (
    <div className="chart-card">
      <p className="chart-title">{title}</p>
      <div style={{ height: 200 }}><Bar data={chartData} options={chartOpts} /></div>
    </div>
  );
}

function PacingCharts({ data }) {
  const currentMonthKey = data.currentMonthKey;
  if (!currentMonthKey) return null;
  const comparison = buildMonthlyComparison(data.studios, STUDIOS, currentMonthKey);

  return (
    <div className="wr-block">
      <div className="wr-section-title">Month Comparison — All Studios</div>
      <div className="wr-legend-row">
        {PACING_PERIODS.map(({ key, color }) => (
          <div key={key} className="wr-legend-item">
            <span className="wr-legend-swatch" style={{ background: color }} />
            {comparison[key].label}
          </div>
        ))}
      </div>
      <div className="wr-chart-grid">
        {PACING_METRICS.map(({ key, label, format }) => (
          <PacingBarCard key={key} title={label} comparison={comparison} metricKey={key} formatValue={format} />
        ))}
      </div>
    </div>
  );
}

// ─── Memberships ────────────────────────────────────────────────────────────

function MembershipsView({ data }) {
  const memberships = data.memberships || { history: [] };
  const history = memberships.history || [];
  const latest = history[history.length - 1];

  if (!latest) {
    return <div className="wr-empty-state">No membership data uploaded yet. Use the Upload &amp; Goals tab's Membership Snapshot section to get started.</div>;
  }

  const newTotal = (latest.newMemberships || []).reduce((sum, c) => sum + (c.sales || 0), 0);
  const cancelledTotal = (latest.newlyCancelled || []).reduce((sum, c) => sum + (c.sales || 0), 0);
  const net = newTotal - cancelledTotal;

  return (
    <div className="wr-panel-stack">
      <div className="wr-muted">
        Snapshot as of {fmtDate(latest.date)} · New and Cancelled below reflect all of <strong>{latest.monthLabel}</strong>, based on each membership's own start/cancellation date.
      </div>

      <div className="wr-table-scroll">
        <table className="wr-table">
          <thead><tr>{['Studio', 'Active', 'Cancelled', 'Suspended', 'Projected Revenue', 'Cancelled $ Revenue'].map(h => (
            <th key={h} className={h === 'Studio' ? 'wr-left' : ''}>{h}</th>
          ))}</tr></thead>
          <tbody>
            {STUDIOS.map(s => {
              const b = latest.byStudio[s] || {};
              return (
                <tr key={s}>
                  <td className="wr-left wr-strong">{s}</td>
                  <td>{n(b.activeCount)}</td>
                  <td>{n(b.cancelledCount)}</td>
                  <td>{n(b.suspendedCount)}</td>
                  <td>{money(b.projectedRevenue)}</td>
                  <td className="wr-bad">{money(b.cancelledRevenue)}</td>
                </tr>
              );
            })}
            <tr className="wr-row-total">
              <td className="wr-left">Total</td>
              <td>{n(latest.total.activeCount)}</td>
              <td>{n(latest.total.cancelledCount)}</td>
              <td>{n(latest.total.suspendedCount)}</td>
              <td>{money(latest.total.projectedRevenue)}</td>
              <td className="wr-bad">{money(latest.total.cancelledRevenue)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <MembershipList title={`Cancelled — ${latest.monthLabel}`} rows={latest.newlyCancelled} tone="bad" empty="None cancelled yet this month." />
      <MembershipList title={`New Memberships — ${latest.monthLabel}`} rows={latest.newMemberships} tone="good" empty="None new yet this month." />

      <div className={`wr-net-line ${net >= 0 ? 'wr-good' : 'wr-bad'}`}>
        Net change for {latest.monthLabel}: {net >= 0 ? '+' : '-'}{money(Math.abs(net))} / month
      </div>

      {history.length > 0 && (
        <div className="wr-block">
          <div className="wr-section-title">History</div>
          <div className="wr-table-scroll">
            <table className="wr-table">
              <thead><tr>{['Date', 'Active', 'Cancelled', 'Suspended', 'Projected Revenue'].map(h => (
                <th key={h} className={h === 'Date' ? 'wr-left' : ''}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.date}>
                    <td className="wr-left wr-strong">{fmtDate(h.date)}</td>
                    <td>{n(h.total.activeCount)}</td>
                    <td>{n(h.total.cancelledCount)}</td>
                    <td>{n(h.total.suspendedCount)}</td>
                    <td>{money(h.total.projectedRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="wr-muted" style={{ marginTop: 12, maxWidth: 640 }}>
            <strong>Projected Revenue</strong> is the total recurring dollar amount across all memberships Active as of that snapshot. It's only as current as the last upload.
          </div>
        </div>
      )}
    </div>
  );
}

function MembershipList({ title, rows, tone, empty }) {
  return (
    <div className="wr-block">
      <div className="wr-section-title">{title}</div>
      {rows && rows.length ? (
        <div className="wr-table-scroll">
          <table className="wr-table">
            <thead><tr>{['Guest', 'Membership', 'Studio', 'Monthly $'].map(h => <th key={h} className={h === 'Monthly $' ? '' : 'wr-left'}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={i}>
                  <td className="wr-left">{c.guestName}</td>
                  <td className="wr-left">{c.membershipName}</td>
                  <td className="wr-left">{c.studio}</td>
                  <td className={tone === 'bad' ? 'wr-bad wr-strong' : 'wr-good wr-strong'}>{money(c.sales)}</td>
                </tr>
              ))}
              <tr className="wr-row-total">
                <td colSpan={3} className="wr-left">Total</td>
                <td className={tone === 'bad' ? 'wr-bad' : 'wr-good'}>{money(rows.reduce((sum, c) => sum + (c.sales || 0), 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : <div className="wr-muted">{empty}</div>}
    </div>
  );
}

// ─── Collections (Club Orange) ──────────────────────────────────────────────

function rateColor(v) {
  if (v === null || v === undefined) return undefined;
  if (v >= 93) return 'var(--sage)';
  if (v >= 88) return 'var(--brass)';
  return 'var(--rust)';
}

function CollectionsRateTable({ title, description, months, field }) {
  return (
    <div className="wr-block">
      <div className="wr-section-title" style={{ marginBottom: 4 }}>{title}</div>
      {description && <div className="wr-muted" style={{ marginBottom: 8 }}>{description}</div>}
      <div className="wr-table-scroll">
        <table className="wr-table">
          <thead><tr>{['Month', 'Billed', 'Collected', 'Missed (Due)', 'Collection Rate'].map(h => (
            <th key={h} className={h === 'Month' ? 'wr-left' : ''}>{h}</th>
          ))}</tr></thead>
          <tbody>
            {months.map(m => {
              const agg = m[field];
              return (
                <tr key={m.key}>
                  <td className="wr-left wr-strong">{m.label}</td>
                  <td>{money(agg.billed)}</td>
                  <td>{money(agg.collected)}</td>
                  <td className={agg.due > 0 ? 'wr-bad wr-strong' : ''}>{money(agg.due)}</td>
                  <td className="wr-strong" style={{ color: rateColor(agg.rate) }}>{agg.rate != null ? agg.rate.toFixed(1) + '%' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CollectionsView({ data, persist }) {
  const [resetting, setResetting] = useState(false);
  const collections = data.collections || { records: [] };
  const records = collections.records || [];
  const summary = useMemo(() => buildCollectionsSummary(records), [records]);
  const { months, declineReasons } = summary;
  const latestMonth = months[months.length - 1];

  async function handleReset() {
    if (!window.confirm('This clears all Club Orange collections data (every uploaded row). Continue?')) return;
    setResetting(true);
    const next = cloneData(data);
    next.collections = { records: [] };
    await persist(next);
    setResetting(false);
  }

  if (!records.length) {
    return <div className="wr-empty-state">No collections data uploaded yet. Use the Upload &amp; Goals tab's Collections section to upload a Memberships Payment export.</div>;
  }

  return (
    <div className="wr-panel-stack">
      <div className="wr-muted" style={{ maxWidth: 720 }}>
        Tracks what Club Orange actually billed vs. what got collected, per calendar month, from {records.length.toLocaleString()} billing attempts on file.
        "1st Pull" and "15th Pull" isolate the days right after each month's two charge dates.
      </div>

      <CollectionsRateTable title="1st Pull (1st–5th of month)" description="What was billed vs. collected in the days right after the 1st-of-month charge went out." months={months} field="pull1" />
      <CollectionsRateTable title="15th Pull (15th–20th of month)" description="Same thing, for the mid-month charge." months={months} field="pull15" />
      <CollectionsRateTable title="Total for the Month (Both Pulls)" description="1st Pull + 15th Pull combined." months={months} field="bothPulls" />
      <CollectionsRateTable title="Full Month" description="Whole month — includes any late-resolving retries." months={months} field="full" />

      {latestMonth && (
        <div className="wr-block">
          <div className="wr-section-title">By Studio — {latestMonth.label}</div>
          <div className="wr-table-scroll">
            <table className="wr-table">
              <thead><tr>{['Studio', 'Billed', 'Collected', 'Missed (Due)', 'Collection Rate'].map(h => <th key={h} className={h === 'Studio' ? 'wr-left' : ''}>{h}</th>)}</tr></thead>
              <tbody>
                {STUDIOS.map(s => {
                  const agg = latestMonth.byStudio[s] || { billed: 0, collected: 0, due: 0, rate: null };
                  return (
                    <tr key={s}>
                      <td className="wr-left wr-strong">{s}</td>
                      <td>{money(agg.billed)}</td>
                      <td>{money(agg.collected)}</td>
                      <td className={agg.due > 0 ? 'wr-bad wr-strong' : ''}>{money(agg.due)}</td>
                      <td className="wr-strong" style={{ color: rateColor(agg.rate) }}>{agg.rate != null ? agg.rate.toFixed(1) + '%' : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {declineReasons.length > 0 && (
        <div className="wr-block">
          <div className="wr-section-title">Decline Reasons (failed &amp; pending, all months on file)</div>
          <div className="wr-table-scroll" style={{ maxWidth: 480 }}>
            <table className="wr-table">
              <thead><tr>{['Reason', 'Count'].map(h => <th key={h} className={h === 'Reason' ? 'wr-left' : ''}>{h}</th>)}</tr></thead>
              <tbody>
                {declineReasons.map(d => (
                  <tr key={d.reason}><td className="wr-left">{d.reason}</td><td>{d.count}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <button className="wr-link-btn wr-link-btn--warn" onClick={handleReset} disabled={resetting}>
        {resetting ? 'Clearing…' : 'Clear all collections data'}
      </button>
    </div>
  );
}

// ─── Guest Retention ─────────────────────────────────────────────────────────

function GuestRetentionView({ data, persist, showToast }) {
  const [removingKey, setRemovingKey] = useState(null);
  const history = data.guestRetention?.history || [];
  const latest = history[history.length - 1];
  const isPending = latest && new Date(latest.windowCloseDate + 'T00:00:00') > new Date();

  async function handleDelete(entry) {
    const key = entry.cohortStart + entry.cohortEnd + entry.retentionDays;
    if (!window.confirm(`Remove the ${fmtDate(entry.cohortStart)}–${fmtDate(entry.cohortEnd)} snapshot?`)) return;
    setRemovingKey(key);
    const next = cloneData(data);
    next.guestRetention.history = next.guestRetention.history.filter(h => !(h.cohortStart === entry.cohortStart && h.cohortEnd === entry.cohortEnd && h.retentionDays === entry.retentionDays));
    await persist(next);
    setRemovingKey(null);
  }

  if (!latest) {
    return <div className="wr-empty-state">No guest retention data uploaded yet. Use the Upload &amp; Goals tab's Guest Retention section to get started.</div>;
  }

  return (
    <div className="wr-panel-stack">
      <div className="wr-muted">
        Cohort: {fmtDate(latest.cohortStart)}–{fmtDate(latest.cohortEnd)} · {latest.retentionDays}-day retention window
        {isPending && <span className="wr-pending-badge">STILL FINALIZING — window closes {fmtDate(latest.windowCloseDate)}</span>}
      </div>

      {STUDIOS.map(studio => {
        const rows = latest.byStudio[studio] || [];
        if (!rows.length) return null;
        const totalNew = rows.reduce((s, r) => s + r.newGuests, 0);
        const totalNewRetained = rows.reduce((s, r) => s + r.newRetainedSame + r.newRetainedOther, 0);
        const totalRepeat = rows.reduce((s, r) => s + r.repeatGuests, 0);
        const totalRepeatRetained = rows.reduce((s, r) => s + r.repeatRetainedSame + r.repeatRetainedOther, 0);
        const avgNewPct = totalNew ? (totalNewRetained / totalNew) * 100 : 0;
        const avgRepeatPct = totalRepeat ? (totalRepeatRetained / totalRepeat) * 100 : 0;
        const sorted = [...rows].sort((a, b) => b.repeatRetentionPct - a.repeatRetentionPct);

        return (
          <div key={studio} className="wr-block">
            <div className="wr-section-title">{studio}</div>
            <div className="wr-table-scroll">
              <table className="wr-table">
                <thead><tr>{['Cerologist', 'New Guests', 'Ret. (Same)', 'Ret. (Other)', 'New Retention %', 'Repeat Guests', 'Ret. (Same)', 'Ret. (Other)', 'Repeat Retention %'].map(h => (
                  <th key={h} className={h === 'Cerologist' ? 'wr-left' : ''}>{h}</th>
                ))}</tr></thead>
                <tbody>
                  {sorted.map(r => (
                    <tr key={r.cerologistName}>
                      <td className="wr-left wr-strong">{r.cerologistName}</td>
                      <td>{n(r.newGuests)}</td>
                      <td>{n(r.newRetainedSame)}</td>
                      <td className="wr-muted">{n(r.newRetainedOther)}</td>
                      <td className="wr-strong" style={{ color: r.newGuests === 0 ? undefined : (r.newRetentionPct >= avgNewPct ? 'var(--sage)' : 'var(--rust)') }}>
                        {r.newGuests === 0 ? '—' : r.newRetentionPct.toFixed(1) + '%'}
                      </td>
                      <td>{n(r.repeatGuests)}</td>
                      <td>{n(r.repeatRetainedSame)}</td>
                      <td className="wr-muted">{n(r.repeatRetainedOther)}</td>
                      <td className="wr-strong" style={{ color: r.repeatGuests === 0 ? undefined : (r.repeatRetentionPct >= avgRepeatPct ? 'var(--sage)' : 'var(--rust)') }}>
                        {r.repeatGuests === 0 ? '—' : r.repeatRetentionPct.toFixed(1) + '%'}
                      </td>
                    </tr>
                  ))}
                  <tr className="wr-row-total">
                    <td className="wr-left">Studio Average</td>
                    <td>{n(totalNew)}</td>
                    <td colSpan={2}></td>
                    <td>{avgNewPct.toFixed(1)}%</td>
                    <td>{n(totalRepeat)}</td>
                    <td colSpan={2}></td>
                    <td>{avgRepeatPct.toFixed(1)}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <div className="wr-muted" style={{ maxWidth: 640 }}>
        Colors are relative to that studio's own average for this snapshot. "Retained (Same)" is a guest who came back to this same cerologist;
        "Retained (Other)" came back to the business but saw someone else. Sorted by Repeat Retention %, highest first.
      </div>

      {history.length > 0 && (
        <div className="wr-block">
          <div className="wr-section-title">History</div>
          <div className="wr-table-scroll">
            <table className="wr-table">
              <thead><tr>{['Cohort Period', 'Retention Window', ''].map(h => <th key={h} className="wr-left">{h}</th>)}</tr></thead>
              <tbody>
                {[...history].reverse().map(h => {
                  const key = h.cohortStart + h.cohortEnd + h.retentionDays;
                  return (
                    <tr key={key}>
                      <td className="wr-left wr-strong">{fmtDate(h.cohortStart)}–{fmtDate(h.cohortEnd)}</td>
                      <td className="wr-left">{h.retentionDays} days</td>
                      <td className="wr-left">
                        <button className="wr-link-btn" onClick={() => handleDelete(h)} disabled={removingKey === key}>
                          {removingKey === key ? 'removing...' : 'remove'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Supply Costs ────────────────────────────────────────────────────────────

function SupplyCostsView({ data, persist, showToast }) {
  const [studio, setStudio] = useState(STUDIOS[0]);
  const [label, setLabel] = useState('');
  const [supplies, setSupplies] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const currentMonthLabel = data.studios[studio]?.month_totals?.find(m => m.start.slice(0, 7) === data.currentMonthKey)?.label;
    const mtdRow = data.studios[studio]?.month_totals?.find(m => m.label === currentMonthLabel);
    if (!mtdRow) {
      showToast(`No current-month KPI data on file yet for ${studio} — upload this month's studio report first.`, 'error');
      return;
    }
    setSaving(true);
    const services = mtdRow.total_services;
    const serviceRevenue = mtdRow.service_revenue ?? mtdRow.sales;
    const suppliesNum = Number(supplies);
    const row = {
      label,
      supplies: suppliesNum,
      services,
      sup_per_serv: services ? Math.round((suppliesNum / services) * 10000) / 10000 : null,
      dollar_per_serv: services ? Math.round((serviceRevenue / services) * 10000) / 10000 : null,
      ratio: null,
    };

    const next = cloneData(data);
    const list = next.supserv[studio] || (next.supserv[studio] = []);
    const idx = list.findIndex(r => r.label === label);
    if (idx === -1) list.push(row); else list[idx] = row;

    // Recompute the Consolidated row as the sum across all three studios for this period, if all three are on file.
    const consRow = { label, supplies: 0, services: 0 };
    let hasAll = true;
    for (const s of STUDIOS) {
      const r = (next.supserv[s] || []).find(x => x.label === label);
      if (!r) { hasAll = false; break; }
      consRow.supplies += r.supplies;
      consRow.services += r.services;
    }
    if (hasAll) {
      consRow.sup_per_serv = Math.round((consRow.supplies / consRow.services) * 10000) / 10000;
      const totalServiceRev = STUDIOS.reduce((sum, s) => {
        const mLabel = next.studios[s]?.month_totals?.find(m => m.start.slice(0, 7) === next.currentMonthKey)?.label;
        const row2 = next.studios[s]?.month_totals?.find(m => m.label === mLabel);
        return sum + (row2?.service_revenue ?? row2?.sales ?? 0);
      }, 0);
      consRow.dollar_per_serv = Math.round((totalServiceRev / consRow.services) * 10000) / 10000;
      consRow.ratio = null;
      const consList = next.supserv['Consolidated'] || (next.supserv['Consolidated'] = []);
      const cIdx = consList.findIndex(r => r.label === label);
      if (cIdx === -1) consList.push(consRow); else consList[cIdx] = consRow;
    }

    await persist(next);
    setSaving(false);
    showToast(`Saved supply costs for ${studio}`);
    setLabel('');
    setSupplies('');
  }

  return (
    <div className="wr-panel-stack">
      <form className="wr-form wr-panel" onSubmit={handleSubmit} style={{ maxWidth: 420 }}>
        <div className="wr-muted" style={{ marginBottom: 16 }}>
          Services count and $/Serv are pulled automatically from that studio's current-month KPI data — just enter what was spent on supplies.
        </div>
        <label className="wr-field">
          Studio
          <select value={studio} onChange={e => setStudio(e.target.value)}>
            {STUDIOS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="wr-field">
          Period label
          <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder='e.g. "June Final" or "7/1 - 7/20 (MTD)"' required />
        </label>
        <label className="wr-field">
          Supplies ($)
          <input type="number" step="0.01" value={supplies} onChange={e => setSupplies(e.target.value)} required />
        </label>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </form>

      <div className="wr-block">
        <div className="wr-section-title">Currently on file</div>
        {STUDIOS.map(s => (
          <div key={s} className="wr-muted" style={{ marginBottom: 6 }}>
            <strong>{s}:</strong> {(data.supserv[s] || []).map(r => `${r.label} ($${r.supplies})`).join(', ') || 'none yet'}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Upload & Goals ──────────────────────────────────────────────────────────

function UploadSection({ title, description, period, needsFull, data, persist, showToast }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [files, setFiles] = useState({});
  const [uploading, setUploading] = useState(false);

  const fileFields = needsFull
    ? [['kpi', 'KPI_s report'], ['attendance', 'Attendance report'], ['salesAccrual', 'Sales-Accrual report'], ['cerologist', 'Cerologist Journey Sheet KPIs']]
    : [['cerologist', 'Cerologist Journey Sheet KPIs']];

  async function handleSubmit(e) {
    e.preventDefault();
    setUploading(true);
    try {
      const next = cloneData(data);

      if (period === 'pay_period_1' || period === 'pay_period_2') {
        const cerologistFile = files.cerologist;
        if (!cerologistFile) throw new Error('Pay period bonus needs the Cerologist Journey Sheet KPIs file.');
        const cerologist = await parseCerologistKPI(cerologistFile);
        let count = 0;
        for (const [name, cero] of Object.entries(cerologist)) {
          const studio = cero.studio;
          if (!next.employees[studio]?.[name]) continue; // must already exist from a weekly/MTD upload
          const emp = next.employees[studio][name];
          const bonus = computeBonus({ serviceRev: cero.serviceRevenue, retail: cero.productRevenue });
          if (period === 'pay_period_1') {
            emp.bonus.pay_period_1 = { available: true, start, end, co: cero.membership, service_rev: cero.serviceRevenue, ...bonus };
          } else {
            const currentMonthLabel = next.studios[studio]?.month_totals?.find(m => monthKey(m.start) === next.currentMonthKey)?.label;
            const mtdRow = next.employees[studio][name].month_totals.find(m => m.label === currentMonthLabel);
            const monthCo = mtdRow ? mtdRow.membership : null;
            emp.bonus.pay_period_2 = {
              available: true, start, end, co: cero.membership, service_rev: cero.serviceRevenue, ...bonus,
              month_co: monthCo, co_bonus: monthCo != null ? Math.round(monthCo * 10 * 100) / 100 : null,
            };
          }
          count += 1;
        }
        await persist(next);
        showToast(`Uploaded — ${count} employees updated.`);
      } else {
        const kpi = files.kpi ? await parseKPI(files.kpi) : null;
        const attendance = files.attendance ? await parseAttendance(files.attendance) : null;
        const salesAccrual = files.salesAccrual ? await parseSalesAccrual(files.salesAccrual) : null;
        const cerologist = files.cerologist ? await parseCerologistKPI(files.cerologist) : null;

        let studioCount = 0, empCount = 0;

        if (kpi) {
          for (const s of STUDIOS) {
            if (!kpi[s]) continue;
            const inputs = { kpi: kpi[s], attendanceHours: attendance?.byStudio?.[s] ?? null, addon: salesAccrual?.addonByStudio?.[s] ?? null };
            const row = period === 'week' ? buildStudioWeekRow(inputs, start, end) : buildStudioMTDRow(inputs, start, end);
            if (period === 'week') {
              upsertByStart(next.studios[s].all_weeks, row);
            } else {
              upsertMonthTotal(next.studios[s].month_totals, row);
              next.currentMonthKey = monthKey(start);
            }
            studioCount += 1;
          }
        }

        if (cerologist) {
          const activeThisUpload = {};
          for (const [name, cero] of Object.entries(cerologist)) {
            const s = cero.studio;
            if (!next.employees[s]) next.employees[s] = {};
            if (!next.employees[s][name]) next.employees[s][name] = { all_weeks: [], month_totals: [], bonus: {} };
            const emp = next.employees[s][name];
            const hours = attendance?.byEmployee?.[name] ?? null;
            if (period === 'week') {
              upsertByStart(emp.all_weeks, buildEmployeeRow(cero, hours, start, end));
            } else {
              upsertMonthTotal(emp.month_totals, buildEmployeeRow(cero, hours, start, end, { label: monthLabel(start) }));
            }
            (activeThisUpload[s] ||= []).push(name);
            empCount += 1;
          }
          Object.keys(activeThisUpload).forEach(s => { next.activeEmployees[s] = activeThisUpload[s]; });
        }

        await persist(next);
        showToast(`Uploaded — ${studioCount} studios, ${empCount} employees.`);
      }

      setFiles({});
      setStart(''); setEnd('');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form className="wr-form wr-panel" onSubmit={handleSubmit}>
      <div className="wr-section-title">{title}</div>
      <div className="wr-muted" style={{ marginBottom: 16 }}>{description}</div>
      <div className="wr-form-row">
        <label className="wr-field">Start date<input type="date" value={start} onChange={e => setStart(e.target.value)} required /></label>
        <label className="wr-field">End date<input type="date" value={end} onChange={e => setEnd(e.target.value)} required /></label>
      </div>
      <div className="wr-form-grid">
        {fileFields.map(([key, flabel]) => (
          <label key={key} className="wr-field">
            {flabel}
            <input type="file" accept=".csv,.xlsx,.xls" onChange={e => setFiles(f => ({ ...f, [key]: e.target.files[0] }))} />
          </label>
        ))}
      </div>
      <button type="submit" className="btn-primary" disabled={uploading}>{uploading ? 'Uploading...' : 'Upload'}</button>
    </form>
  );
}

function MembershipUploadSection({ data, persist, showToast }) {
  const [date, setDate] = useState('');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) { showToast('Choose a Memberships export first.', 'error'); return; }
    setUploading(true);
    try {
      const records = await parseMemberships(file);
      const snapshot = buildMembershipSnapshot(records, date);
      const { monthLabel: mLabel, byStudio, total, newlyCancelled, newMemberships, recordCount } = snapshot;
      const historyEntry = { date, monthLabel: mLabel, byStudio, total, newlyCancelled, newMemberships, recordCount };

      const next = cloneData(data);
      if (!next.memberships) next.memberships = { history: [] };
      next.memberships.history = next.memberships.history.filter(h => h.date !== date);
      next.memberships.history.push(historyEntry);
      next.memberships.history.sort((a, b) => (a.date < b.date ? -1 : 1));

      await persist(next);
      showToast('Uploaded — check the Memberships tab.');
      setFile(null);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form className="wr-form wr-panel" onSubmit={handleSubmit}>
      <div className="wr-section-title">Membership Snapshot</div>
      <div className="wr-muted" style={{ marginBottom: 16 }}>
        Upload the Memberships export whenever you pull one. This is a full point-in-time snapshot (not a date range) — each upload is compared against the snapshot's own calendar month to catch newly cancelled and brand-new memberships automatically.
      </div>
      <label className="wr-field" style={{ maxWidth: 240 }}>Snapshot date<input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
      <label className="wr-field" style={{ maxWidth: 320 }}>Memberships report<input type="file" accept=".csv,.xlsx,.xls" onChange={e => setFile(e.target.files[0])} /></label>
      <button type="submit" className="btn-primary" disabled={uploading}>{uploading ? 'Uploading...' : 'Upload'}</button>
    </form>
  );
}

function CollectionsUploadSection({ data, persist, showToast }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) { showToast('Choose a Memberships Payment export first.', 'error'); return; }
    setUploading(true);
    try {
      const records = await parseCollections(file);
      if (!records.length) throw new Error('No recognizable rows found. Is this the Memberships Payment (Collections) export?');
      const next = cloneData(data);
      if (!next.collections) next.collections = { records: [] };
      const byKey = new Map(next.collections.records.map(r => [r.key, r]));
      for (const r of records) byKey.set(r.key, r);
      next.collections.records = Array.from(byKey.values());
      await persist(next);
      showToast(`Uploaded — ${next.collections.records.length} rows on file. Check the Collections tab.`);
      setFile(null);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form className="wr-form wr-panel" onSubmit={handleSubmit}>
      <div className="wr-section-title">Club Orange Collections</div>
      <div className="wr-muted" style={{ marginBottom: 16 }}>
        Upload the Memberships Payment export (per-charge billing detail) whenever you pull one. No date range needed — rows are matched by invoice and sale date, so re-uploading is safe and lets a "Pending" charge update to its final outcome once it resolves.
      </div>
      <label className="wr-field" style={{ maxWidth: 320 }}>Memberships Payment report<input type="file" accept=".csv,.xlsx,.xls" onChange={e => setFile(e.target.files[0])} /></label>
      <button type="submit" className="btn-primary" disabled={uploading}>{uploading ? 'Uploading...' : 'Upload'}</button>
    </form>
  );
}

function GuestRetentionUploadSection({ data, persist, showToast }) {
  const [cohortStart, setCohortStart] = useState('');
  const [cohortEnd, setCohortEnd] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);

  function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) { showToast('Choose a Guest Retention export first.', 'error'); return; }
    setUploading(true);
    try {
      const byStudio = await parseGuestRetention(file);
      const days = Number(retentionDays);
      const windowCloseDate = addDays(cohortEnd, days + 1);
      const next = cloneData(data);
      if (!next.guestRetention) next.guestRetention = { history: [] };
      const entry = { cohortStart, cohortEnd, retentionDays: days, windowCloseDate, byStudio };
      next.guestRetention.history = next.guestRetention.history.filter(h => !(h.cohortStart === cohortStart && h.cohortEnd === cohortEnd && h.retentionDays === days));
      next.guestRetention.history.push(entry);
      next.guestRetention.history.sort((a, b) => (a.cohortStart < b.cohortStart ? -1 : 1));
      await persist(next);
      showToast('Uploaded — check the Guest Retention tab.');
      setFile(null);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form className="wr-form wr-panel" onSubmit={handleSubmit}>
      <div className="wr-section-title">Guest Retention</div>
      <div className="wr-muted" style={{ marginBottom: 16 }}>
        Upload a Zenoti Guest Retention export (Retention By = Cerologist), along with the cohort date range it covers and the retention window (days) it was run with.
      </div>
      <div className="wr-form-row">
        <label className="wr-field">Cohort start<input type="date" value={cohortStart} onChange={e => setCohortStart(e.target.value)} required /></label>
        <label className="wr-field">Cohort end<input type="date" value={cohortEnd} onChange={e => setCohortEnd(e.target.value)} required /></label>
        <label className="wr-field">Retention window (days)<input type="number" min="1" value={retentionDays} onChange={e => setRetentionDays(e.target.value)} required /></label>
      </div>
      <label className="wr-field" style={{ maxWidth: 320 }}>Guest Retention report<input type="file" accept=".csv,.xlsx,.xls" onChange={e => setFile(e.target.files[0])} /></label>
      <button type="submit" className="btn-primary" disabled={uploading}>{uploading ? 'Uploading...' : 'Upload'}</button>
    </form>
  );
}

const UPLOAD_GOAL_FIELDS = [
  ['total_collections', 'Total Collections'], ['retail', 'Retail $'], ['tsth', 'TSTH'],
  ['addon', 'Add-On Services'], ['co_enrollment', 'Memberships'], ['new_guests', 'New Guests'],
];

function currentMonthValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Split in two: GoalsSection owns the studio/month picker (must persist as
// the user changes it), GoalsForm owns the actual field values and is keyed
// by studio+month so it remounts — with freshly lazy-initialized state —
// only when the picker changes. That keeps it isolated from unrelated
// `data` updates elsewhere on this page (e.g. a Weekly/MTD upload finishing
// while someone is mid-edit here), without needing an effect that
// re-syncs from `data` on every render.
function GoalsSection({ data, persist, showToast }) {
  const [studio, setStudio] = useState(STUDIOS[0]);
  const [month, setMonth] = useState(currentMonthValue());
  return (
    <GoalsForm
      key={`${studio}|${month}`}
      studio={studio} month={month} data={data} persist={persist} showToast={showToast}
      onStudioChange={setStudio} onMonthChange={setMonth}
    />
  );
}

function GoalsForm({ studio, month, data, persist, showToast, onStudioChange, onMonthChange }) {
  const [values, setValues] = useState(() => {
    const existing = data?.goals?.[studio]?.[month] || {};
    const initial = {};
    UPLOAD_GOAL_FIELDS.forEach(([key]) => { initial[key] = existing[key] != null ? String(existing[key]) : ''; });
    return initial;
  });
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    const cleanGoals = {};
    for (const [key] of UPLOAD_GOAL_FIELDS) {
      const raw = values[key];
      if (raw === '' || raw == null) continue;
      const num = Number(raw);
      if (Number.isFinite(num)) cleanGoals[key] = num;
    }
    const next = cloneData(data);
    if (!next.goals) next.goals = {};
    if (!next.goals[studio]) next.goals[studio] = {};
    next.goals[studio][month] = { ...(next.goals[studio][month] || {}), ...cleanGoals };
    await persist(next);
    setSaving(false);
    showToast(`Saved — check the ${studio} tab on the dashboard.`);
  }

  return (
    <form className="wr-form wr-panel" onSubmit={handleSubmit}>
      <div className="wr-section-title">Monthly Studio Goals</div>
      <div className="wr-muted" style={{ marginBottom: 16 }}>
        Set this studio's goals for the month — they show up as thermometers on that studio's Dashboard view. Pick a studio and month; existing goals will fill in so you can adjust them.
      </div>
      <div className="wr-form-row">
        <label className="wr-field">
          Studio
          <select value={studio} onChange={e => onStudioChange(e.target.value)}>{STUDIOS.map(s => <option key={s} value={s}>{s}</option>)}</select>
        </label>
        <label className="wr-field">Month<input type="month" value={month} onChange={e => onMonthChange(e.target.value)} required /></label>
      </div>
      <div className="wr-form-grid">
        {UPLOAD_GOAL_FIELDS.map(([key, label]) => (
          <label key={key} className="wr-field">
            {label}
            <input type="number" min="0" step="any" value={values[key] ?? ''} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} placeholder="—" />
          </label>
        ))}
      </div>
      <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save Goals'}</button>
    </form>
  );
}

function UploadView({ data, persist, showToast }) {
  return (
    <div className="wr-panel-stack">
      <UploadSection title="Weekly Upload" period="week" needsFull
        description="Every Monday: upload this week's KPI, Attendance, Sales-Accrual, and Cerologist Journey Sheet reports together. Start/end should match the week's date range (e.g. 7/13 – 7/19)."
        data={data} persist={persist} showToast={showToast} />

      <UploadSection title="Month-to-Date Upload" period="mtd" needsFull
        description="Whenever you pull a fresh MTD snapshot (KPI, Attendance, Sales-Accrual, Cerologist — all as MTD exports). This refreshes the current month's total row and folds the prior month into history once a new month's MTD comes in."
        data={data} persist={persist} showToast={showToast} />

      <UploadSection title="Pay Period 1 Bonus (1st – 15th)" period="pay_period_1"
        description="Upload the Cerologist Journey Sheet KPIs scoped to the 1st–15th. Only needs that one report — Service Revenue and Retail drive the SR/Retail bonus for this half of the month."
        data={data} persist={persist} showToast={showToast} />

      <UploadSection title="Pay Period 2 Bonus (16th – End of Month)" period="pay_period_2"
        description="Upload the Cerologist Journey Sheet KPIs scoped to the 16th–EOM. The CO Bonus for this period automatically uses the full month's membership count from the latest MTD upload."
        data={data} persist={persist} showToast={showToast} />

      <MembershipUploadSection data={data} persist={persist} showToast={showToast} />
      <CollectionsUploadSection data={data} persist={persist} showToast={showToast} />
      <GuestRetentionUploadSection data={data} persist={persist} showToast={showToast} />
      <GoalsSection data={data} persist={persist} showToast={showToast} />
    </div>
  );
}

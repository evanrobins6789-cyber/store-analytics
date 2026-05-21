import React, { useEffect, useRef, useState } from 'react';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

function fmt$(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function useChart(ref, config, deps) {
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(ref.current, config);
    return () => { if (chartRef.current) chartRef.current.destroy(); };
    // eslint-disable-next-line
  }, deps);
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555450', font: { size: 10, family: 'DM Mono' }, maxTicksLimit: 8 } },
    y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555450', font: { size: 10, family: 'DM Mono' } } }
  }
};

export default function TrendsTab({ days }) {
  const [range, setRange] = useState('14');

  const filtered = range === 'all' ? days : days.slice(-parseInt(range));
  const labels   = filtered.map(d => d.date.slice(5));
  const revs     = filtered.map(d => Math.round(d.revenue));
  const cuts     = filtered.map(d => d.cuts);
  const tsths    = filtered.map(d => Math.round(d.tsth * 100) / 100);

  const revRef  = useRef(); const cutsRef = useRef(); const tsthRef = useRef();

  useChart(revRef, {
    type: 'line',
    data: { labels, datasets: [{ data: revs, borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,0.1)', fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: '#4f8ef7' }] },
    options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => '$' + Math.round(v).toLocaleString() } } } }
  }, [filtered.length, range]);

  useChart(cutsRef, {
    type: 'bar',
    data: { labels, datasets: [{ data: cuts, backgroundColor: '#2ecc8a', borderRadius: 4 }] },
    options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, stepSize: 1 } } } }
  }, [filtered.length, range]);

  useChart(tsthRef, {
    type: 'line',
    data: { labels, datasets: [{ data: tsths, borderColor: '#f0a03a', backgroundColor: 'rgba(240,160,58,0.1)', fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: '#f0a03a' }] },
    options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, y: { ...CHART_DEFAULTS.scales.y, ticks: { ...CHART_DEFAULTS.scales.y.ticks, callback: v => '$' + (Math.round(v * 100) / 100).toFixed(2) } } } }
  }, [filtered.length, range]);

  if (days.length < 2) {
    return (
      <div className="empty">
        <div className="empty-icon">📈</div>
        <h3>Not enough data yet</h3>
        <p>Upload at least 2 days of data to see trends.</p>
      </div>
    );
  }

  const totalRev = filtered.reduce((s, d) => s + d.revenue, 0);
  const avgRev   = totalRev / filtered.length;
  const avgCuts  = filtered.reduce((s, d) => s + d.cuts, 0) / filtered.length;
  const avgTsth  = filtered.reduce((s, d) => s + d.tsth, 0) / filtered.length;
  const best     = filtered.reduce((a, b) => b.revenue > a.revenue ? b : a);

  return (
    <>
      <div style={{ padding: '0 16px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="section-heading">Trends</div>
        <select value={range} onChange={e => setRange(e.target.value)}>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="all">All time</option>
        </select>
      </div>

      <div className="card">
        <div className="card-label">Revenue</div>
        <div className="chart-outer" style={{ height: 180 }}>
          <canvas ref={revRef} role="img" aria-label="Daily revenue trend" />
        </div>
      </div>

      <div className="card">
        <div className="card-label">Total cuts</div>
        <div className="chart-outer" style={{ height: 140 }}>
          <canvas ref={cutsRef} role="img" aria-label="Daily cuts trend" />
        </div>
      </div>

      <div className="card">
        <div className="card-label">Avg TSTH</div>
        <div className="chart-outer" style={{ height: 140 }}>
          <canvas ref={tsthRef} role="img" aria-label="Daily TSTH trend" />
        </div>
      </div>

      <div className="card">
        <div className="card-label">Period summary</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { label: 'Total revenue', val: fmt$(Math.round(totalRev)) },
            { label: 'Daily avg rev', val: fmt$(Math.round(avgRev)) },
            { label: 'Avg cuts/day',  val: Math.round(avgCuts) },
            { label: 'Avg TSTH',      val: fmt$(Math.round(avgTsth * 100) / 100) },
            { label: 'Best day',      val: fmt$(Math.round(best.revenue)) },
            { label: 'Best date',     val: best.date },
          ].map(({ label, val }) => (
            <div key={label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

import React, { useRef, useState } from 'react';

function fmt$(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function VsTag({ curr, prev }) {
  if (prev === undefined || prev === null) return null;
  const pct = ((curr - prev) / (prev || 1) * 100).toFixed(1);
  const up  = curr >= prev;
  return <span className={`badge ${up ? 'badge-up' : 'badge-down'}`}>{up ? '+' : ''}{pct}%</span>;
}

function buildNarrative(day, prev) {
  const d   = new Date(day.date + 'T12:00:00');
  const ds  = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const stores = day.stores || {};
  const top    = Object.entries(stores).sort((a, b) => b[1].revenue - a[1].revenue)[0];
  let parts = [
    `${ds} —`,
    `Total revenue was ${fmt$(day.revenue)} with ${day.cuts} cuts performed.`
  ];
  if (day.tsth) parts.push(`Average TSTH was ${fmt$(day.tsth)}.`);
  if (top) parts.push(`Top location: ${top[0]} at ${fmt$(top[1].revenue)}.`);
  if (prev) {
    const diff = day.revenue - prev.revenue;
    const pct  = Math.abs((diff / (prev.revenue || 1)) * 100).toFixed(1);
    parts.push(`Revenue was ${diff >= 0 ? 'up' : 'down'} ${pct}% from the prior day (${fmt$(prev.revenue)}).`);
  }
  return parts.join(' ');
}

export default function TodayTab({ today, prev, onFile, uploading }) {
  const inputRef = useRef();
  const [drag, setDrag]  = useState(false);

  const handleDrop = e => {
    e.preventDefault(); setDrag(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  if (!today) {
    return (
      <>
        <div
          className={`upload-zone ${drag ? 'drag' : ''}`}
          onClick={() => inputRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
        >
          <div className="icon">📂</div>
          <p><strong>Upload your Zenoti export</strong></p>
          <p>Tap to choose a file, or drag & drop</p>
          <p style={{ fontSize: 12, marginTop: 8, color: 'var(--text3)' }}>.xlsx or .csv</p>
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
            onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }} />
        </div>
        <div className="empty">
          <div className="empty-icon">📊</div>
          <h3>No data yet</h3>
          <p>Upload your first Zenoti daily export above.<br />Go to the Setup tab for step-by-step instructions.</p>
        </div>
      </>
    );
  }

  const stores  = today.stores || {};
  const sorted  = Object.entries(stores).sort((a, b) => b[1].revenue - a[1].revenue);
  const maxRev  = sorted.length ? sorted[0][1].revenue : 1;

  return (
    <>
      {/* Upload button strip */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 16px 12px', gap: 8 }}>
        <button className="btn btn-sm btn-primary" onClick={() => inputRef.current.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : '⬆ Upload file'}
        </button>
        <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
          onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }} />
      </div>

      {/* Narrative */}
      <div className="narrative">{buildNarrative(today, prev)}</div>

      {/* Key metrics */}
      <div className="metric-grid">
        <div className="metric-card">
          <div className="label">Revenue</div>
          <div className="value">{fmt$(today.revenue)}</div>
          <div className="sub"><VsTag curr={today.revenue} prev={prev?.revenue} /></div>
        </div>
        <div className="metric-card">
          <div className="label">Cuts</div>
          <div className="value">{today.cuts}</div>
          <div className="sub"><VsTag curr={today.cuts} prev={prev?.cuts} /></div>
        </div>
        <div className="metric-card">
          <div className="label">Avg TSTH</div>
          <div className="value">{fmt$(today.tsth)}</div>
          <div className="sub" style={{ fontSize: 10, color: 'var(--text3)' }}>avg of column</div>
        </div>
      </div>

      {/* Store breakdown */}
      {sorted.length > 0 && (
        <div className="card">
          <div className="card-label">Revenue by store</div>
          <div className="store-list">
            {sorted.map(([name, data]) => (
              <div key={name} className="store-row">
                <div className="store-row-header">
                  <span className="store-row-name">{name}</span>
                  <span className="store-row-val">{fmt$(data.revenue)}</span>
                </div>
                <div className="store-bar-bg">
                  <div className="store-bar-fill" style={{ width: `${(data.revenue / maxRev) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

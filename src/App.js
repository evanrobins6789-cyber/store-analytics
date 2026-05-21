import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Bar, Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, Filler, Tooltip
} from 'chart.js';
import { loadDays, saveDay, clearDays, isConfigured } from './db';
import { parseFile } from './parser';
import './App.css';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Filler, Tooltip);

const fmt$ = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) { const [,m,d,y] = mdy; return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`; }
  const iso = s.split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return s;
}

function getDayOfWeek(dateStr) {
  const norm = normalizeDate(dateStr);
  const d = new Date(norm + 'T12:00:00');
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

function formatDisplayDate(dateStr) {
  const norm = normalizeDate(dateStr);
  const d = new Date(norm + 'T12:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function getYearMonth(dateStr) {
  return normalizeDate(dateStr).slice(0, 7);
}

function pctChange(curr, prev) {
  if (!prev) return null;
  return ((curr - prev) / prev * 100).toFixed(1);
}

function Badge({ curr, prev }) {
  const pct = pctChange(curr, prev);
  if (pct === null) return null;
  const up = parseFloat(pct) >= 0;
  return <span className={`badge ${up ? 'badge-up' : 'badge-dn'}`}>{up?'+':''}{pct}%</span>;
}

const METRICS = [
  { key: 'revenue',    label: 'Net Sales',    fmt: fmt$ },
  { key: 'cuts',       label: 'Haircut Count', fmt: n => String(n) },
  { key: 'tsth',       label: 'Avg TSTH',     fmt: fmt$ },
  { key: 'productNet', label: 'Product Net',  fmt: fmt$ },
  { key: 'colorNet',   label: 'Color Net',    fmt: fmt$ },
];

function MetricCard({ metric, value, prev, active, onClick }) {
  const numVal = parseFloat(String(value).replace(/[$,]/g, ''));
  return (
    <div className={`metric-card ${active ? 'metric-card-active' : ''}`} onClick={onClick} style={{ cursor: 'pointer' }}>
      <p className="metric-label">{metric.label}</p>
      <p className="metric-value">{value}</p>
      <div className="metric-sub">
        {prev != null && <Badge curr={numVal} prev={prev} />}
        {active && <span className="active-hint">viewing ↓</span>}
      </div>
    </div>
  );
}

function StoreDataTab({ days }) {
  const [activeMetric, setActiveMetric] = useState('revenue');
  const [selectedDate, setSelectedDate] = useState(days[days.length - 1]?.date || '');

  const dayIndex = days.findIndex(d => d.date === selectedDate);
  const day  = days[dayIndex] || days[days.length - 1];
  const prev = dayIndex > 0 ? days[dayIndex - 1] : null;

  const stores = day?.stores || {};
  const names  = Object.keys(stores).sort((a, b) => (stores[b][activeMetric] ?? 0) - (stores[a][activeMetric] ?? 0));
  const isCurrency = activeMetric !== 'cuts';
  const activeM    = METRICS.find(m => m.key === activeMetric);
  const chartVals  = names.map(n => Math.round(stores[n][activeMetric] ?? 0));

  const storeChartData = {
    labels: names,
    datasets: [{ data: chartVals, backgroundColor: names.map((_, i) => i === 0 ? '#c8f04a' : 'rgba(200,240,74,0.25)'), borderRadius: 4, borderSkipped: false }]
  };
  const storeChartOpts = {
    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + (isCurrency ? fmt$(ctx.parsed.x) : ctx.parsed.x) } } },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#666', callback: v => isCurrency ? fmt$(v) : v, font: { size: 11, family: 'DM Mono' } } },
      y: { grid: { display: false }, ticks: { color: '#ccc', font: { size: 12, family: 'Syne' } } }
    }
  };

  return (
    <div className="tab-content">
      <div className="date-selector-row">
        <p className="section-label" style={{ margin: 0 }}>Viewing</p>
        <select className="date-select" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}>
          {[...days].reverse().map(d => (
            <option key={d.date} value={d.date}>{getDayOfWeek(d.date)}, {normalizeDate(d.date)}</option>
          ))}
        </select>
      </div>
      <div className="narrative">
        <span className="narrative-date">{formatDisplayDate(day.date)}</span>
        {' — '}Net Sales <strong>{fmt$(day.revenue)}</strong> across <strong>{day.cuts}</strong> haircuts.
        {day.tsth > 0 && <> Avg TSTH <strong>{fmt$(day.tsth)}</strong>.</>}
        {day.productNet > 0 && <> Product Net <strong>{fmt$(day.productNet)}</strong>.</>}
        {day.colorNet > 0 && <> Color Net <strong>{fmt$(day.colorNet)}</strong>.</>}
        {names[0] && <> Top store: <strong>{names[0]}</strong>.</>}
        {prev && (() => { const diff = day.revenue - prev.revenue; const pct = Math.abs((diff/(prev.revenue||1))*100).toFixed(1); return <> Net Sales {diff>=0?'up':'down'} <strong>{pct}%</strong> vs prior day.</>; })()}
      </div>
      <div className="metric-row">
        {METRICS.map(m => (
          <MetricCard key={m.key} metric={m} value={m.fmt(day[m.key]??0)} prev={prev ? (prev[m.key] ?? null) : null} active={activeMetric===m.key} onClick={()=>setActiveMetric(m.key)} />
        ))}
      </div>
      {names.length > 0 && (
        <div className="chart-card">
          <p className="chart-title">{activeM.label} by store</p>
          <div style={{ height: Math.max(220, names.length * 42 + 60) }}>
            <Bar data={storeChartData} options={storeChartOpts} />
          </div>
        </div>
      )}
    </div>
  );
}

function TrendsTab({ days }) {
  const [range, setRange]       = useState('14');
  const [contribPct, setContribPct] = useState('20');
  const filtered = range === 'all' ? days : days.slice(-parseInt(range));

  const now       = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthDays = days.filter(d => getYearMonth(d.date) === thisMonth);
  const monthRev  = monthDays.reduce((s,d) => s+(d.revenue??0), 0);
  const pct       = parseFloat(contribPct) || 0;
  const contribEst    = monthRev * (pct/100);
  const daysInMonth   = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const remainingDays = daysInMonth - now.getDate();
  const avgDaily      = monthDays.length > 0 ? monthRev / monthDays.length : 0;
  const projectedRev  = monthRev + (avgDaily * remainingDays);
  const projContrib   = projectedRev * (pct/100);

  if (filtered.length < 2) return <div className="empty-state"><p className="empty-title">Not enough data yet</p><p>Upload at least 2 days.</p></div>;

  const labels = filtered.map(d => normalizeDate(d.date).slice(5));
  const lineOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' '+fmt$(ctx.parsed.y) } } },
    scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#666', font: { size: 10, family: 'DM Mono' }, maxTicksLimit: 10 } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#666', callback: v => fmt$(v), font: { size: 10, family: 'DM Mono' } } } }
  };
  const barOpts = {
    responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false }, ticks: { color: '#666', font: { size: 10, family: 'DM Mono' }, maxTicksLimit: 10 } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#666', font: { size: 10 }, stepSize: 1 } } }
  };

  const totalRev   = filtered.reduce((s,d)=>s+(d.revenue??0),0);
  const avgCuts    = Math.round(filtered.reduce((s,d)=>s+(d.cuts??0),0)/filtered.length);
  const avgTsth    = filtered.reduce((s,d)=>s+(d.tsth??0),0)/filtered.length;
  const totalProd  = filtered.reduce((s,d)=>s+(d.productNet??0),0);
  const totalColor = filtered.reduce((s,d)=>s+(d.colorNet??0),0);
  const best       = filtered.reduce((a,b)=>(b.revenue??0)>(a.revenue??0)?b:a);

  return (
    <div className="tab-content">
      <div className="trends-header">
        <p className="section-label">Performance over time</p>
        <select value={range} onChange={e=>setRange(e.target.value)} className="range-select">
          <option value="7">Last 7 days</option><option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option><option value="all">All time</option>
        </select>
      </div>
      <div className="chart-card">
        <p className="chart-title">Daily net sales</p>
        <div style={{height:200}}><Line data={{labels,datasets:[{data:filtered.map(d=>Math.round(d.revenue??0)),borderColor:'#c8f04a',backgroundColor:'rgba(200,240,74,0.08)',fill:true,tension:0.35,pointRadius:3,pointBackgroundColor:'#c8f04a'}]}} options={lineOpts}/></div>
      </div>
      <div className="chart-row">
        <div className="chart-card"><p className="chart-title">Haircuts / day</p><div style={{height:160}}><Bar data={{labels,datasets:[{data:filtered.map(d=>d.cuts??0),backgroundColor:'rgba(200,240,74,0.4)',borderRadius:3}]}} options={barOpts}/></div></div>
        <div className="chart-card"><p className="chart-title">Avg TSTH / day</p><div style={{height:160}}><Line data={{labels,datasets:[{data:filtered.map(d=>Math.round((d.tsth??0)*100)/100),borderColor:'#7eb8f7',backgroundColor:'rgba(126,184,247,0.08)',fill:true,tension:0.35,pointRadius:3,pointBackgroundColor:'#7eb8f7'}]}} options={lineOpts}/></div></div>
        <div className="chart-card"><p className="chart-title">Product Net / day</p><div style={{height:160}}><Line data={{labels,datasets:[{data:filtered.map(d=>Math.round(d.productNet??0)),borderColor:'#f7a97e',backgroundColor:'rgba(247,169,126,0.08)',fill:true,tension:0.35,pointRadius:3,pointBackgroundColor:'#f7a97e'}]}} options={lineOpts}/></div></div>
        <div className="chart-card"><p className="chart-title">Color Net / day</p><div style={{height:160}}><Line data={{labels,datasets:[{data:filtered.map(d=>Math.round(d.colorNet??0)),borderColor:'#c47ef7',backgroundColor:'rgba(196,126,247,0.08)',fill:true,tension:0.35,pointRadius:3,pointBackgroundColor:'#c47ef7'}]}} options={lineOpts}/></div></div>
      </div>
      <div className="summary-grid">
        <div className="summary-card"><p className="metric-label">Period net sales</p><p className="metric-value">{fmt$(Math.round(totalRev))}</p><p className="metric-sub"><span>{filtered.length} days</span></p></div>
        <div className="summary-card"><p className="metric-label">Avg haircuts / day</p><p className="metric-value">{avgCuts}</p></div>
        <div className="summary-card"><p className="metric-label">Avg TSTH</p><p className="metric-value">{fmt$(Math.round(avgTsth*100)/100)}</p></div>
        <div className="summary-card"><p className="metric-label">Product Net</p><p className="metric-value">{fmt$(Math.round(totalProd))}</p></div>
        <div className="summary-card"><p className="metric-label">Color Net</p><p className="metric-value">{fmt$(Math.round(totalColor))}</p></div>
        <div className="summary-card"><p className="metric-label">Best day</p><p className="metric-value" style={{fontSize:18}}>{fmt$(Math.round(best.revenue??0))}</p><p className="metric-sub"><span>{normalizeDate(best.date)}</span></p></div>
      </div>
      <div className="contrib-card">
        <div className="contrib-header">
          <p className="chart-title" style={{margin:0}}>Contribution Est — {thisMonth}</p>
          <div className="contrib-pct-row">
            <span className="contrib-pct-label">Contribution %</span>
            <input className="contrib-pct-input" type="number" min="1" max="100" value={contribPct} onChange={e=>setContribPct(e.target.value)}/>
            <span className="contrib-pct-symbol">%</span>
          </div>
        </div>
        {monthDays.length === 0 ? (
          <p className="contrib-empty">No data for {thisMonth} yet. Upload files from this month to see estimates.</p>
        ) : (
          <div className="contrib-grid">
            <div className="contrib-item"><p className="metric-label">Month net sales so far</p><p className="metric-value">{fmt$(Math.round(monthRev))}</p><p className="metric-sub"><span>{monthDays.length} days uploaded</span></p></div>
            <div className="contrib-item"><p className="metric-label">Contribution est (actual)</p><p className="metric-value contrib-value">{fmt$(Math.round(contribEst))}</p><p className="metric-sub"><span>{pct}% of {fmt$(Math.round(monthRev))}</span></p></div>
            <div className="contrib-item"><p className="metric-label">Projected month-end</p><p className="metric-value">{fmt$(Math.round(projectedRev))}</p><p className="metric-sub"><span>{fmt$(Math.round(avgDaily))}/day × {remainingDays} days left</span></p></div>
            <div className="contrib-item"><p className="metric-label">Projected contribution</p><p className="metric-value contrib-value">{fmt$(Math.round(projContrib))}</p><p className="metric-sub"><span>{pct}% of projected</span></p></div>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryTab({ days }) {
  if (!days.length) return <div className="empty-state"><p>No history yet.</p></div>;
  return (
    <div className="tab-content">
      <div className="history-list">
        {[...days].reverse().map(d => (
          <div key={d.date} className="history-row">
            <div className="history-date-col">
              <span className="history-date">{normalizeDate(d.date)}</span>
              <span className="history-dow">{getDayOfWeek(d.date)}</span>
            </div>
            <span className="history-stat">{d.cuts} cuts</span>
            <span className="history-rev">{fmt$(d.revenue)}</span>
            <span className="history-tsth">TSTH {fmt$(d.tsth)}</span>
            <span className="history-tsth">Prod {fmt$(d.productNet??0)}</span>
            <span className="history-tsth">Color {fmt$(d.colorNet??0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Chatbot ────────────────────────────────────────────────────────────────

function buildDataSummary(days) {
  if (!days.length) return 'No data uploaded yet.';
  const lines = [];
  days.forEach(d => {
    const norm = normalizeDate(d.date);
    const dow  = getDayOfWeek(d.date);
    lines.push(`Date: ${norm} (${dow}) | Net Sales: $${d.revenue} | Haircuts: ${d.cuts} | TSTH: $${d.tsth} | Product Net: $${d.productNet??0} | Color Net: $${d.colorNet??0}`);
    const stores = d.stores || {};
    Object.entries(stores).forEach(([name, s]) => {
      lines.push(`  Store: ${name} | Net Sales: $${s.revenue} | Haircuts: ${s.cuts} | Product Net: $${s.productNet??0} | Color Net: $${s.colorNet??0}`);
    });
  });
  return lines.join('\n');
}

function ChatBot({ days }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', text: "Hi! Ask me anything about your store data — like \"who sold the most retail last Monday\" or \"what was my best day this month\"." }
  ]);
  const [input, setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: q }]);
    setLoading(true);

    try {
      const dataSummary = buildDataSummary(days);
      const systemPrompt = `You are a helpful store analytics assistant for a hair salon business. You have access to daily sales data shown below. Answer questions clearly and concisely. When referencing dollar amounts use $ formatting. When asked about specific stores, days of the week, or date ranges, look through the data carefully.\n\nDATA:\n${dataSummary}`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: systemPrompt,
          messages: [
            ...messages.filter(m => m.role !== 'assistant' || messages.indexOf(m) > 0).map(m => ({ role: m.role, content: m.text })),
            { role: 'user', content: q }
          ]
        })
      });

      const data = await res.json();
      const text = data.content?.map(c => c.text || '').join('') || 'Sorry, I could not get a response.';
      setMessages(prev => [...prev, { role: 'assistant', text }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Something went wrong. Please try again.' }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tab-content chatbot-wrap">
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role}`}>
            <p>{m.text}</p>
          </div>
        ))}
        {loading && <div className="chat-bubble assistant"><p className="chat-thinking">Thinking<span className="dots">...</span></p></div>}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input
          className="chat-input"
          placeholder="Ask about your data..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
        />
        <button className="chat-send" onClick={send} disabled={loading || !input.trim()}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  );
}

function SetupTab() {
  return (
    <div className="tab-content setup-tab">
      <div className="setup-section">
        {[
          { n: 1, title: 'Set up your Zenoti export', body: 'In Zenoti, go to Reports → Daily Sales Summary. Schedule an automated daily email in Excel format to a dedicated inbox.' },
          { n: 2, title: 'Upload each morning', body: 'Download the Excel attachment from your email and tap Upload. The last row (grand total) and leading numbers on store names are handled automatically.' },
          { n: 3, title: 'Use the chatbot', body: 'Tap the Chat tab and ask questions like "who sold the most retail on Monday" or "what was my best day this month." It reads all your uploaded data.' },
          { n: 4, title: 'Add to your phone home screen', body: 'On iPhone: open the app URL in Safari → Share → "Add to Home Screen." On Android: Chrome → three dots → "Add to Home Screen."' },
        ].map(s => (
          <div key={s.n} className="setup-step">
            <div className="step-num">{s.n}</div>
            <div><p className="step-title">{s.title}</p><p className="step-body">{s.body}</p></div>
          </div>
        ))}
      </div>
    </div>
  );
}

const TABS = ['Store Data', 'Trends', 'History', 'Chat', 'Setup'];

export default function App() {
  const [days, setDays]           = useState([]);
  const [tab, setTab]             = useState('Store Data');
  const [loading, setLoading]     = useState(true);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast]         = useState(null);
  const [colMap, setColMap]       = useState(null);

  useEffect(() => {
    loadDays().then(d => { setDays(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleFile = useCallback(async file => {
    setUploading(true);
    try {
      const entry = await parseFile(file);
      await saveDay(entry);
      setDays(prev => {
        const next = [...prev.filter(d => d.date !== entry.date), entry];
        next.sort((a,b) => normalizeDate(a.date).localeCompare(normalizeDate(b.date)));
        return next;
      });
      setColMap(entry.detectedCols);
      setTab('Store Data');
      showToast(`Loaded ${entry.date} — ${Object.keys(entry.stores).length} stores`);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleClear = async () => {
    if (!window.confirm('Clear all stored data? This cannot be undone.')) return;
    await clearDays();
    setDays([]);
    setColMap(null);
    showToast('All data cleared');
  };

  if (loading) return <div className="app-loading"><div className="spinner large"/></div>;

  const hasData = days.length > 0;

  return (
    <div className="app">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">Store Analytics</h1>
          {!isConfigured() && <span className="local-badge">local</span>}
        </div>
        <div className="header-right">
          {hasData && <button className="btn-ghost" onClick={handleClear}>Clear</button>}
          <label className="btn-upload">
            {uploading ? <span className="spinner small"/> : '+ Upload'}
            <input type="file" accept=".xlsx,.xls,.csv" onChange={e => { if(e.target.files[0]) handleFile(e.target.files[0]); e.target.value=''; }} style={{display:'none'}}/>
          </label>
        </div>
      </header>

      {colMap && (
        <div className="col-map-bar">
          <span>Detected — </span>
          {colMap.storeCol      && <span>Store: <strong>{colMap.storeCol}</strong></span>}
          {colMap.revCol        && <span>Net Sales: <strong>{colMap.revCol}</strong></span>}
          {colMap.cutsCol       && <span>Haircuts: <strong>{colMap.cutsCol}</strong></span>}
          {colMap.tsthCol       && <span>TSTH: <strong>{colMap.tsthCol}</strong></span>}
          {colMap.productNetCol && <span>Product Net: <strong>{colMap.productNetCol}</strong></span>}
          {colMap.colorNetCol   && <span>Color Net: <strong>{colMap.colorNetCol}</strong></span>}
        </div>
      )}

      <nav className="tab-nav">
        {TABS.map(t => (
          <button key={t} className={`tab-btn ${tab===t?'active':''}`} onClick={()=>setTab(t)}>{t}</button>
        ))}
      </nav>

      <main className="app-main">
        {!hasData && tab !== 'Setup' && tab !== 'Chat' ? (
          <div className="welcome">
            <div className="upload-zone" onClick={() => document.getElementById('main-upload').click()}>
              <div className="upload-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <p className="upload-title">{uploading ? 'Processing...' : 'Upload daily file'}</p>
              <p className="upload-sub">Click or drag your Zenoti Excel export here</p>
              <input id="main-upload" type="file" accept=".xlsx,.xls,.csv" onChange={e => { if(e.target.files[0]) handleFile(e.target.files[0]); e.target.value=''; }} style={{display:'none'}}/>
            </div>
            <p className="welcome-hint">or <button className="link-btn" onClick={()=>setTab('Setup')}>read the setup guide</button></p>
          </div>
        ) : (
          <>
            {tab==='Store Data' && <StoreDataTab days={days}/>}
            {tab==='Trends'     && <TrendsTab    days={days}/>}
            {tab==='History'    && <HistoryTab   days={days}/>}
            {tab==='Chat'       && <ChatBot      days={days}/>}
            {tab==='Setup'      && <SetupTab/>}
          </>
        )}
      </main>
    </div>
  );
}

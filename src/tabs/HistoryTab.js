import React from 'react';

function fmt$(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function HistoryTab({ days }) {
  if (!days.length) {
    return (
      <div className="empty">
        <div className="empty-icon">🕐</div>
        <h3>No history yet</h3>
        <p>Every file you upload gets saved here permanently.</p>
      </div>
    );
  }

  return (
    <>
      <div className="section-pad">
        <div className="section-heading">{days.length} days on record</div>
      </div>
      <div className="card">
        {[...days].reverse().map(d => (
          <div key={d.date} className="history-row">
            <div>
              <div className="history-date">{d.date}</div>
              <div className="history-meta">{d.cuts} cuts · TSTH {fmt$(d.tsth)}</div>
            </div>
            <div className="history-rev">{fmt$(d.revenue)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

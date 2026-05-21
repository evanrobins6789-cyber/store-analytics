import React, { useState } from 'react';

export default function SetupTab({ onSample, configured }) {
  const [showSQL, setShowSQL] = useState(false);

  const sql = `create table daily_metrics (
  id    bigint generated always as identity primary key,
  date  text unique not null,
  payload jsonb not null
);`;

  return (
    <>
      {!configured && (
        <div style={{ margin: '0 16px 12px', background: 'var(--red2)', border: '1px solid var(--red)', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: 'var(--red)' }}>
          ⚠ Supabase not connected — data saves to this device only. Follow the steps below to enable cross-device sync.
        </div>
      )}
      {configured && (
        <div style={{ margin: '0 16px 12px', background: 'var(--green2)', border: '1px solid var(--green)', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: 'var(--green)' }}>
          ✓ Supabase connected — your data syncs across all devices.
        </div>
      )}

      <div className="card">
        <div className="card-label">Try it first</div>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12, lineHeight: 1.6 }}>
          Load 14 days of fake store data to see all the dashboard features before connecting your real data.
        </p>
        <button className="btn btn-primary" onClick={onSample}>Load sample data</button>
      </div>

      <div className="card">
        <div className="card-label">Daily workflow</div>
        <div className="setup-step">
          <div className="step-num">1</div>
          <div className="step-body">
            <h4>Zenoti sends you the file</h4>
            <p>In Zenoti, go to <strong>Reports → Daily Sales Summary</strong>. Schedule it to auto-email to you each morning as an Excel attachment.</p>
          </div>
        </div>
        <div className="setup-step">
          <div className="step-num">2</div>
          <div className="step-body">
            <h4>Open this app, tap Upload</h4>
            <p>Download the attachment from your email, open this app, tap <strong>Upload file</strong> on the Today tab. Done — takes 10 seconds.</p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-label" style={{ marginBottom: 4 }}>Deploy this app (one time setup)</div>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>Follow these steps once to get your own live URL. Everything is free.</p>

        <div className="setup-step">
          <div className="step-num">1</div>
          <div className="step-body">
            <h4>Create a GitHub account</h4>
            <p>Go to <a href="https://github.com" target="_blank" rel="noreferrer">github.com</a> and sign up for a free account. GitHub is where your app code lives.</p>
          </div>
        </div>

        <div className="setup-step">
          <div className="step-num">2</div>
          <div className="step-body">
            <h4>Upload the app files to GitHub</h4>
            <p>Create a new repository (click the <strong>+</strong> button → New repository). Name it <code>store-analytics</code>. Then drag the entire unzipped project folder into it.</p>
          </div>
        </div>

        <div className="setup-step">
          <div className="step-num">3</div>
          <div className="step-body">
            <h4>Create a free Supabase account</h4>
            <p>Go to <a href="https://supabase.com" target="_blank" rel="noreferrer">supabase.com</a>, sign up, and create a new project. Pick any name and region close to you. Wait ~2 minutes for it to spin up.</p>
          </div>
        </div>

        <div className="setup-step">
          <div className="step-num">4</div>
          <div className="step-body">
            <h4>Create the database table</h4>
            <p>In your Supabase project, click <strong>SQL Editor</strong> in the left sidebar. Paste this and click Run:</p>
            <div style={{ margin: '8px 0', background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 8, padding: '10px 12px', position: 'relative' }}>
              <pre style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--amber)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{sql}</pre>
              <button className="btn btn-sm" style={{ position: 'absolute', top: 8, right: 8 }}
                onClick={() => { navigator.clipboard.writeText(sql); }}>Copy</button>
            </div>
          </div>
        </div>

        <div className="setup-step">
          <div className="step-num">5</div>
          <div className="step-body">
            <h4>Get your Supabase keys</h4>
            <p>In Supabase, go to <strong>Project Settings → API</strong>. Copy two things: your <code>Project URL</code> and your <code>anon public</code> key. Keep these handy for the next step.</p>
          </div>
        </div>

        <div className="setup-step">
          <div className="step-num">6</div>
          <div className="step-body">
            <h4>Create a free Vercel account</h4>
            <p>Go to <a href="https://vercel.com" target="_blank" rel="noreferrer">vercel.com</a> and sign up using your GitHub account. This is where your app will be hosted.</p>
          </div>
        </div>

        <div className="setup-step">
          <div className="step-num">7</div>
          <div className="step-body">
            <h4>Deploy on Vercel</h4>
            <p>Click <strong>Add New → Project</strong>. Select your <code>store-analytics</code> GitHub repo. Before you click Deploy, click <strong>Environment Variables</strong> and add two variables:</p>
            <div style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 6, padding: '8px 10px', fontFamily: 'DM Mono', fontSize: 11 }}>
                <span style={{ color: 'var(--text2)' }}>Name: </span><span style={{ color: 'var(--amber)' }}>REACT_APP_SUPABASE_URL</span><br />
                <span style={{ color: 'var(--text2)' }}>Value: </span><span style={{ color: 'var(--green)' }}>your Project URL from step 5</span>
              </div>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 6, padding: '8px 10px', fontFamily: 'DM Mono', fontSize: 11 }}>
                <span style={{ color: 'var(--text2)' }}>Name: </span><span style={{ color: 'var(--amber)' }}>REACT_APP_SUPABASE_ANON_KEY</span><br />
                <span style={{ color: 'var(--text2)' }}>Value: </span><span style={{ color: 'var(--green)' }}>your anon key from step 5</span>
              </div>
            </div>
            <p>Then click <strong>Deploy</strong>. Vercel will build and give you a live URL in about 2 minutes.</p>
          </div>
        </div>

        <div className="setup-step">
          <div className="step-num">8</div>
          <div className="step-body">
            <h4>Add it to your phone's home screen</h4>
            <p><strong>iPhone:</strong> Open your Vercel URL in Safari → tap the Share button (box with arrow) → tap <strong>Add to Home Screen</strong> → tap Add.</p>
            <p style={{ marginTop: 6 }}><strong>Android:</strong> Open in Chrome → tap the three dots menu → tap <strong>Add to Home Screen</strong>.</p>
            <p style={{ marginTop: 6 }}>It will appear as an app icon and open full screen with no browser bars.</p>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-label">Need help?</div>
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.7 }}>
          If you get stuck on any step, come back to this chat and describe exactly where you are — I can walk you through it. The most common issue is forgetting to add the environment variables in step 7.
        </p>
      </div>
    </>
  );
}

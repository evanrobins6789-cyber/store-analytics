import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

export const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const isConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

// Load all days from Supabase or localStorage fallback
export async function loadDays() {
  if (supabase) {
    const { data, error } = await supabase
      .from('daily_metrics')
      .select('*')
      .order('date', { ascending: true });
    if (!error && data) return data.map(r => ({ ...r.payload, date: r.date }));
  }
  try {
    const raw = localStorage.getItem('zenoti_days_v1');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Save a single day entry
export async function saveDay(entry) {
  if (supabase) {
    const { error } = await supabase
      .from('daily_metrics')
      .upsert({ date: entry.date, payload: entry }, { onConflict: 'date' });
    if (error) console.error('Supabase save error', error);
  }
  // Always keep localStorage as fallback
  try {
    const raw = localStorage.getItem('zenoti_days_v1');
    let days = raw ? JSON.parse(raw) : [];
    const idx = days.findIndex(d => d.date === entry.date);
    if (idx >= 0) days[idx] = entry; else days.push(entry);
    days.sort((a, b) => a.date.localeCompare(b.date));
    localStorage.setItem('zenoti_days_v1', JSON.stringify(days));
  } catch {}
}

export async function clearDays() {
  if (supabase) {
    await supabase.from('daily_metrics').delete().neq('date', '');
  }
  localStorage.removeItem('zenoti_days_v1');
}

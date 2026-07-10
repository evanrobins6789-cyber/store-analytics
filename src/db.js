import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

export const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const isConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

const LOCAL_KEY = 'time_and_till_periods_v1';

// Load both periods. Returns { period1: payload|undefined, period2: payload|undefined }
export async function loadPeriods() {
  if (supabase) {
    const { data, error } = await supabase.from('periods').select('*');
    if (!error && data) {
      const out = {};
      data.forEach(row => { out[row.period_id] = row.payload; });
      return out;
    }
  }
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// Save one period's payload ({ label, hours, sales })
export async function savePeriod(periodId, payload) {
  if (supabase) {
    const { error } = await supabase
      .from('periods')
      .upsert({ period_id: periodId, payload }, { onConflict: 'period_id' });
    if (error) console.error('Supabase save error', error);
  }
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[periodId] = payload;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {}
}

export async function clearPeriods() {
  if (supabase) {
    await supabase.from('periods').delete().neq('period_id', '');
  }
  localStorage.removeItem(LOCAL_KEY);
}

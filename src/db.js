import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY || '';

export const supabase = SUPABASE_URL
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const isConfigured = () => !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

const LOCAL_KEY = 'time_and_till_periods_v1';

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Load both periods. Returns { data, source: 'supabase'|'local', error }
// source/error let the caller warn the user when shared sync isn't actually
// working (e.g. Supabase configured but the table/policy isn't set up right).
export async function loadPeriods() {
  if (supabase) {
    const { data, error } = await supabase.from('periods').select('*');
    if (!error && data) {
      const out = {};
      data.forEach(row => { out[row.period_id] = row.payload; });
      return { data: out, source: 'supabase', error: null };
    }
    return { data: readLocal(), source: 'local', error: error?.message || 'Unknown Supabase error' };
  }
  return { data: readLocal(), source: 'local', error: null };
}

// Save one period's payload ({ label, hours, sales }). Returns { ok, error }
// — ok is true only if it actually reached Supabase when Supabase is configured.
export async function savePeriod(periodId, payload) {
  let error = null;
  if (supabase) {
    const res = await supabase
      .from('periods')
      .upsert({ period_id: periodId, payload }, { onConflict: 'period_id' });
    if (res.error) { error = res.error.message; console.error('Supabase save error', res.error); }
  }
  try {
    const all = readLocal();
    all[periodId] = payload;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
  } catch {}
  return { ok: !error, error };
}

export async function clearPeriods() {
  if (supabase) {
    await supabase.from('periods').delete().neq('period_id', '');
  }
  localStorage.removeItem(LOCAL_KEY);
}

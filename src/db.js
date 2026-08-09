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
  if (payload == null) {
    console.error('savePeriod called with no payload for', periodId);
    return { ok: false, error: 'Internal error: no data to save' };
  }
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

// ─── Attendance / Sales entries: row-level, permanent, ever-growing ────────
// Unlike `periods` (a handful of small JSON blobs, rewritten whole on every
// save), these two datasets are meant to grow forever as weekly reports get
// uploaded — so they live in their own real Supabase tables (queryable and
// filterable by date) instead of one JSON blob that would otherwise need to
// be re-uploaded in full every single time. The local-storage fallback
// still uses plain arrays under their own keys, mirroring the same
// replace-a-date-range-then-append semantics.

const LOCAL_ATTENDANCE_KEY = 'wtc_attendance_entries_v1';
const LOCAL_SALES_KEY = 'wtc_sales_entries_v1';

function readLocalArray(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function writeLocalArray(key, rows) {
  try { localStorage.setItem(key, JSON.stringify(rows)); } catch {}
}

// Camel-case row shape (as produced by parser.js) <-> snake_case Supabase
// column shape.
function attendanceRowToDb(row, sourceFile) {
  return { work_date: row.workDate, employee_name: row.employeeName, hours_decimal: row.hoursDecimal, source_file: sourceFile };
}
function attendanceRowFromDb(row) {
  return { workDate: row.work_date, employeeName: row.employee_name, hoursDecimal: Number(row.hours_decimal) };
}
function salesRowToDb(row, sourceFile) {
  return {
    sale_date: row.saleDate, employee_name: row.employeeName, store_name: row.storeName,
    invoice_no: row.invoiceNo, item_code: row.itemCode, item_type: row.itemType, item_name: row.itemName,
    sale_amount: row.saleAmount, payment_type: row.paymentType, status: row.status, source_file: sourceFile,
  };
}
function salesRowFromDb(row) {
  return {
    saleDate: row.sale_date, employeeName: row.employee_name, storeName: row.store_name,
    invoiceNo: row.invoice_no, itemCode: row.item_code, itemType: row.item_type, itemName: row.item_name,
    saleAmount: Number(row.sale_amount), paymentType: row.payment_type, status: row.status,
  };
}

export async function loadAttendanceEntries() {
  if (supabase) {
    const { data, error } = await supabase.from('attendance_entries').select('*').order('work_date');
    if (!error && data) return { data: data.map(attendanceRowFromDb), source: 'supabase', error: null };
    return { data: readLocalArray(LOCAL_ATTENDANCE_KEY), source: 'local', error: error?.message || 'Unknown Supabase error' };
  }
  return { data: readLocalArray(LOCAL_ATTENDANCE_KEY), source: 'local', error: null };
}

export async function loadSalesEntries() {
  if (supabase) {
    const { data, error } = await supabase.from('sales_entries').select('*').order('sale_date');
    if (!error && data) return { data: data.map(salesRowFromDb), source: 'supabase', error: null };
    return { data: readLocalArray(LOCAL_SALES_KEY), source: 'local', error: error?.message || 'Unknown Supabase error' };
  }
  return { data: readLocalArray(LOCAL_SALES_KEY), source: 'local', error: null };
}

// Deletes every existing row whose date falls in [fromDate, toDate], then
// inserts the freshly-parsed rows for that same range — a re-upload of a
// week you already loaded corrects it in place instead of duplicating.
export async function replaceAttendanceRange(fromDate, toDate, rows, sourceFile) {
  let error = null;
  if (supabase) {
    const del = await supabase.from('attendance_entries').delete().gte('work_date', fromDate).lte('work_date', toDate);
    if (del.error) error = del.error.message;
    else if (rows.length) {
      const ins = await supabase.from('attendance_entries').insert(rows.map(r => attendanceRowToDb(r, sourceFile)));
      if (ins.error) error = ins.error.message;
    }
  }
  const local = readLocalArray(LOCAL_ATTENDANCE_KEY).filter(r => r.workDate < fromDate || r.workDate > toDate);
  writeLocalArray(LOCAL_ATTENDANCE_KEY, [...local, ...rows]);
  return { ok: !error, error };
}

export async function replaceSalesRange(fromDate, toDate, rows, sourceFile) {
  let error = null;
  if (supabase) {
    const del = await supabase.from('sales_entries').delete().gte('sale_date', fromDate).lte('sale_date', toDate);
    if (del.error) error = del.error.message;
    else if (rows.length) {
      const ins = await supabase.from('sales_entries').insert(rows.map(r => salesRowToDb(r, sourceFile)));
      if (ins.error) error = ins.error.message;
    }
  }
  const local = readLocalArray(LOCAL_SALES_KEY).filter(r => r.saleDate < fromDate || r.saleDate > toDate);
  writeLocalArray(LOCAL_SALES_KEY, [...local, ...rows]);
  return { ok: !error, error };
}

export async function deleteAllAttendance() {
  if (supabase) await supabase.from('attendance_entries').delete().gte('work_date', '1900-01-01');
  writeLocalArray(LOCAL_ATTENDANCE_KEY, []);
}

export async function deleteAllSales() {
  if (supabase) await supabase.from('sales_entries').delete().gte('sale_date', '1900-01-01');
  writeLocalArray(LOCAL_SALES_KEY, []);
}

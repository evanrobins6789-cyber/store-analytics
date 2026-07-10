import * as XLSX from 'xlsx';

// ─── Grid helpers ───────────────────────────────────────────────────────────
// We read the sheet cell-by-cell (rather than sheet_to_json) because these
// reports don't have a fixed header row — the date range and location sit in
// free-floating text rows above the real table, and we need both the raw
// value (.v) and the display text (.w, e.g. "45:08") for each cell.

function sheetToGrid(ws) {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) { row.push({ v: '', w: '' }); continue; }
      const v = cell.v !== undefined ? cell.v : '';
      const w = cell.w !== undefined ? String(cell.w) : String(v);
      row.push({ v, w });
    }
    grid.push(row);
  }
  return grid;
}

function cellText(cell) {
  return String(cell?.w ?? '').trim();
}

function rowHasData(row) {
  return row.some(c => cellText(c) !== '');
}

// Find the first "From : ... To : ..." style date range anywhere near the top
function findDateRange(grid) {
  const re = /from\s*:?\s*(.+?)\s+to\s*:?\s*(.+?)(?:\s{2,}|\s+by\s*:|\s+report\b|$)/i;
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    for (const cell of grid[r]) {
      const t = cellText(cell);
      const m = t.match(re);
      if (m) {
        const from = m[1].trim();
        const to = m[2].trim();
        return { from, to, label: `${from} – ${to}` };
      }
    }
  }
  return null;
}

// Find the {row, col} of the first cell whose display text matches a matcher,
// trying each matcher (in priority order) as a full pass over the whole grid.
function findHeaderCol(grid, matchers) {
  for (const matcher of matchers) {
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const t = cellText(grid[r][c]).toLowerCase();
        if (t && matcher(t)) return { row: r, col: c };
      }
    }
  }
  return null;
}

export function cleanEmployeeName(raw) {
  return String(raw).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

// Names that should never show up as an individual employee — managers we
// don't want in the productivity comparison, and system/house buckets that
// aren't a real staff member.
const EXCLUDED_EXACT_NAMES = ['ciana santiago', 'house sale'];
function isExcludedName(cleanName) {
  const n = cleanName.toLowerCase();
  if (EXCLUDED_EXACT_NAMES.includes(n)) return true;
  if (/\bpos\b/.test(n)) return true;
  return false;
}

export function normalizeEmployeeName(raw) {
  return cleanEmployeeName(raw).toLowerCase();
}

// Convert a decimal hours value back into a "45h 08m" style display string
export function decimalToHoursDisplay(decimal) {
  if (decimal == null || isNaN(decimal)) return '—';
  const totalMinutes = Math.round(decimal * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// Parse an "Actual Hours" cell. These are stored as Excel elapsed-time values
// ([h]:mm format), so a value over 24 hours shows as e.g. "45:08" rather than
// wrapping — SheetJS renders that correctly into cell.w, so we parse the text
// directly. If for some reason no formatted text is available, we fall back
// to treating the raw numeric value as a day-fraction (Excel's native storage
// for elapsed time).
function parseHoursCell(cell) {
  const text = cellText(cell);
  const m = text.match(/^(\d{1,5}):(\d{2})(?::\d{2})?$/);
  if (m) {
    const hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    return { hours, minutes, decimal: hours + minutes / 60 };
  }
  const num = Number(cell?.v);
  if (!isNaN(num) && cell?.v !== '') {
    const totalMinutes = Math.round(num * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return { hours, minutes, decimal: hours + minutes / 60 };
  }
  return null;
}

function readWorkbookGrid(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const grid = sheetToGrid(ws);
        if (!grid.length) { reject(new Error('No data found in file.')); return; }
        resolve(grid);
      } catch (err) {
        reject(new Error('Could not read this file. Make sure it is a valid Excel export.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

// ─── Hours / Attendance report ──────────────────────────────────────────────
// Expected shape: a location name, a "From : ... To : ..." line, then a table
// of Employee Name | Actual Hours, ending in a "Total:" row.
export async function parseHoursFile(file) {
  const grid = await readWorkbookGrid(file);

  const dateRange = findDateRange(grid);

  let location = null;
  for (let r = 0; r < Math.min(grid.length, 3) && !location; r++) {
    for (const cell of grid[r]) {
      const t = cellText(cell);
      if (t && !/from\s*:/i.test(t)) { location = t; break; }
    }
  }

  const hdr = findHeaderCol(grid, [
    t => t === 'actual hours',
    t => t.includes('actual') && t.includes('hour'),
    t => t.includes('hour'),
  ]);
  if (!hdr) throw new Error('Could not find an "Actual Hours" column in this file. Make sure it is an hours/attendance export.');

  const nameCol = 0;
  const hoursCol = hdr.col;
  const employees = [];
  let totalFromFooter = null;

  for (let r = hdr.row + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const nameText = cellText(row[nameCol]);

    if (/^(grand\s*)?total\s*:?$/i.test(nameText)) {
      const parsed = parseHoursCell(row[hoursCol]);
      if (parsed) totalFromFooter = parsed.decimal;
      continue;
    }
    if (!nameText) continue;

    const parsed = parseHoursCell(row[hoursCol]);
    if (!parsed) continue;

    const cleanName = cleanEmployeeName(nameText);
    if (isExcludedName(cleanName)) continue;

    employees.push({
      name: cleanName,
      hoursDecimal: Math.round(parsed.decimal * 100) / 100,
      hoursDisplay: `${parsed.hours}h ${String(parsed.minutes).padStart(2, '0')}m`,
    });
  }

  const totalHoursDecimal = totalFromFooter != null
    ? Math.round(totalFromFooter * 100) / 100
    : Math.round(employees.reduce((s, e) => s + e.hoursDecimal, 0) * 100) / 100;

  return {
    location,
    dateRangeLabel: dateRange ? dateRange.label : null,
    totalHoursDecimal,
    totalHoursDisplay: decimalToHoursDisplay(totalHoursDecimal),
    employees,
    fileName: file.name,
  };
}

// ─── Sales / KPI report ─────────────────────────────────────────────────────
// Expected shape: a wide KPI table, one row per employee, first column is the
// employee identifier, ending in a "Grand Total" row. We only care about the
// "Service Revenue" column.
export async function parseSalesFile(file) {
  const grid = await readWorkbookGrid(file);

  const dateRange = findDateRange(grid);

  const hdr = findHeaderCol(grid, [
    t => t === 'service revenue',
    t => t.includes('service') && t.includes('revenue') && !t.includes('average') && !t.includes('invoice') && !t.includes('collection'),
  ]);
  if (!hdr) throw new Error('Could not find a "Service Revenue" column in this file. Make sure it is a sales/KPI export.');

  const nameCol = 0;
  const revCol = hdr.col;
  const employees = [];
  let otherRevenue = 0;
  let grandTotal = null;

  for (let r = hdr.row + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const nameText = cellText(row[nameCol]);

    const rawRev = row[revCol]?.v;
    const rev = typeof rawRev === 'number'
      ? rawRev
      : (parseFloat(String(rawRev).replace(/[$,]/g, '')) || 0);

    if (/^grand\s*total\s*:?$/i.test(nameText)) { grandTotal = rev; continue; }

    const cleanName = cleanEmployeeName(nameText);
    if (!cleanName || isExcludedName(cleanName)) { otherRevenue += rev; continue; }

    employees.push({ name: cleanName, serviceRevenue: Math.round(rev * 100) / 100 });
  }

  const totalServiceRevenue = grandTotal != null
    ? Math.round(grandTotal * 100) / 100
    : Math.round((employees.reduce((s, e) => s + e.serviceRevenue, 0) + otherRevenue) * 100) / 100;

  return {
    dateRangeLabel: dateRange ? dateRange.label : null,
    totalServiceRevenue,
    otherRevenue: Math.round(otherRevenue * 100) / 100,
    employees,
    fileName: file.name,
  };
}

// ─── Store roster ───────────────────────────────────────────────────────────
// A single-column list like:
//   STORE NAME: PIKE CREEK
//   Alicia Petrucci
//   Jaylynn Muniz
//   (blank line)
//   STORE NAME: MEDIA
//   ...
export async function parseRosterFile(file) {
  const grid = await readWorkbookGrid(file);

  const stores = [];
  let current = null;

  for (const row of grid) {
    const text = cellText(row[0]);
    if (!text) continue;

    const m = text.match(/^store\s*name\s*:\s*(.+)$/i);
    if (m) {
      current = { name: m[1].trim(), employees: [] };
      stores.push(current);
      continue;
    }
    if (!current) continue;

    const name = cleanEmployeeName(text);
    if (name) current.employees.push(name);
  }

  if (!stores.length) throw new Error('Could not find any "STORE NAME:" sections in this file.');

  const storeByName = {};
  stores.forEach(s => {
    s.employees.forEach(n => { storeByName[normalizeEmployeeName(n)] = s.name; });
  });

  return {
    stores: stores.map(s => ({ name: s.name, employees: s.employees })),
    storeByName,
    fileName: file.name,
  };
}

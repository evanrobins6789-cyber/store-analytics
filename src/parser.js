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

// Parse a loose date string ("07/01/2026", "7/1/2026 12:00 AM", ...) into an
// ISO YYYY-MM-DD string built from local calendar fields, or null if it
// doesn't parse. Deliberately not d.toISOString() — that round-trips through
// UTC and can shift the date by a day right around midnight.
export function parseLooseDate(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\s*$/i, '').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  return cleanEmployeeName(raw).toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
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

// ─── Attendance report (row-level) ──────────────────────────────────────────
// Expected shape: a "From : ... To : ..." line, then a table of Date |
// Employee Name | Actual Hours, ending in a "Total:" row. One row per shift
// worked, not one row per employee — the same name can repeat on the same
// date (e.g. a manager clocking in/out more than once). Every row is kept as
// its own entry with its own date; summing per employee happens later, at
// aggregation time over whatever date range is picked, not here.
export async function parseAttendanceFile(file) {
  const grid = await readWorkbookGrid(file);

  const hdr = findHeaderCol(grid, [
    t => t === 'actual hours',
    t => t.includes('actual') && t.includes('hour'),
    t => t.includes('hour'),
  ]);
  if (!hdr) throw new Error('Could not find an "Actual Hours" column in this file. Make sure it is an hours/attendance export.');

  const dateCol = 0;
  const nameCol = 1;
  const hoursCol = hdr.col;
  const rows = [];

  for (let r = hdr.row + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const nameText = cellText(row[nameCol]);
    if (/^(grand\s*)?total\s*:?$/i.test(nameText) || !nameText) continue;

    const parsedHours = parseHoursCell(row[hoursCol]);
    if (!parsedHours) continue;

    const cleanName = cleanEmployeeName(nameText);
    if (isExcludedName(cleanName)) continue;

    const workDate = parseLooseDate(cellText(row[dateCol]));
    if (!workDate) continue;

    rows.push({
      workDate,
      employeeName: cleanName,
      hoursDecimal: Math.round(parsedHours.decimal * 100) / 100,
    });
  }

  if (!rows.length) throw new Error('No usable attendance rows found in this file.');

  const dates = rows.map(r => r.workDate).sort();

  return {
    fileName: file.name,
    fromDate: dates[0],
    toDate: dates[dates.length - 1],
    rows,
  };
}

// ─── Employee Sales report (row-level) ──────────────────────────────────────
// Expected shape: a single header row (Employee Name, Sale Center Code, Sale
// Center, Sale Date, Employee Code, Job, Invoice No, Item Code, Item Type,
// Item Name, Sale Type, Sales, Sales(Inc. Tax), Split Commission, Employee
// Sale Value, Commissionable Discount, Payment Type, Status), one row per
// line item, ending in a "Total:" row. Every closed line item is kept as its
// own entry with its own date — a service, product, membership, package, or
// gift card sale all come through as whatever their real Item Type says.
export async function parseEmployeeSalesFile(file) {
  const grid = await readWorkbookGrid(file);

  let headerRow = -1;
  for (let r = 0; r < grid.length; r++) {
    const texts = grid[r].map(c => cellText(c).toLowerCase());
    if (texts.includes('employee name') && texts.includes('sale date')) { headerRow = r; break; }
  }
  if (headerRow === -1) throw new Error('Could not find the header row (Employee Name / Sale Date) in this file. Make sure it is an Employee Sales export.');

  const colIndex = {};
  grid[headerRow].forEach((cell, c) => { colIndex[cellText(cell).toLowerCase()] = c; });

  const need = (name) => {
    if (!(name in colIndex)) throw new Error(`Could not find a "${name}" column in this file. Make sure it is an Employee Sales export.`);
    return colIndex[name];
  };
  const nameCol = need('employee name');
  const saleDateCol = need('sale date');
  const saleCenterCol = colIndex['sale center'];
  const invoiceCol = colIndex['invoice no'];
  const itemCodeCol = colIndex['item code'];
  const itemTypeCol = need('item type');
  const itemNameCol = colIndex['item name'];
  const salesCol = need('sales');
  const paymentTypeCol = colIndex['payment type'];
  const statusCol = colIndex['status'];

  const numAt = (row, col) => {
    if (col == null) return 0;
    const raw = row[col]?.v;
    return typeof raw === 'number' ? raw : (parseFloat(String(raw).replace(/[$,]/g, '')) || 0);
  };

  const rows = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const nameText = cellText(row[nameCol]);
    if (/^(grand\s*)?total\s*:?$/i.test(nameText) || !nameText) continue;

    const status = statusCol != null ? cellText(row[statusCol]) : 'Closed';
    if (status && status.toLowerCase() !== 'closed') continue;

    const cleanName = cleanEmployeeName(nameText);
    if (isExcludedName(cleanName)) continue;

    const saleDate = parseLooseDate(cellText(row[saleDateCol]));
    if (!saleDate) continue;

    rows.push({
      saleDate,
      employeeName: cleanName,
      storeName: saleCenterCol != null ? matchStoreName(cellText(row[saleCenterCol])) : null,
      invoiceNo: invoiceCol != null ? cellText(row[invoiceCol]) : null,
      itemCode: itemCodeCol != null ? cellText(row[itemCodeCol]) : null,
      itemType: cellText(row[itemTypeCol]),
      itemName: itemNameCol != null ? cellText(row[itemNameCol]) : null,
      saleAmount: Math.round(numAt(row, salesCol) * 100) / 100,
      paymentType: paymentTypeCol != null ? cellText(row[paymentTypeCol]) : null,
      status: status || 'Closed',
    });
  }

  if (!rows.length) throw new Error('No usable sales rows found in this file.');

  const dates = rows.map(r => r.saleDate).sort();

  return {
    fileName: file.name,
    fromDate: dates[0],
    toDate: dates[dates.length - 1],
    rows,
  };
}

// ─── Store collection summary (for the P&L's Income) ───────────────────────
// Expected shape: a wide KPI export, one row per store (plus a "Grand Total"
// row), with columns including "Service Collection", "Product Collection",
// "Membership Collection", "Package Collection", "Gift Card Collection",
// "Prepaid Collection" and "Total Collection" — the six category columns
// sum to the total (verified against a real export: e.g. Concord's Service
// + Product + Membership + Package + Gift Card + Prepaid Collection ==
// its Total Collection, to the cent).
const COLLECTION_CATEGORIES = [
  { key: 'serviceCollection', header: 'Service Collection', label: 'Service' },
  { key: 'productCollection', header: 'Product Collection', label: 'Product / Retail' },
  { key: 'membershipCollection', header: 'Membership Collection', label: 'Membership' },
  { key: 'packageCollection', header: 'Package Collection', label: 'Package' },
  { key: 'giftCardCollection', header: 'Gift Card Collection', label: 'Gift Card' },
  { key: 'prepaidCollection', header: 'Prepaid Collection', label: 'Prepaid' },
];

export { COLLECTION_CATEGORIES };

function matchStoreName(label) {
  const l = String(label || '').toLowerCase();
  if (l.includes('concord')) return 'CONCORD';
  if (l.includes('pike creek')) return 'PIKE CREEK';
  if (l.includes('media')) return 'MEDIA';
  return null;
}

export async function parseStoreCollectionFile(file) {
  const grid = await readWorkbookGrid(file);

  const findCol = header => {
    const hdr = findHeaderCol(grid, [t => t === header.toLowerCase()]);
    if (!hdr) throw new Error(`Could not find a "${header}" column in this file. Make sure it is a store KPI / collection summary export.`);
    return hdr;
  };

  const categoryCols = COLLECTION_CATEGORIES.map(c => ({ ...c, col: findCol(c.header) }));
  const totalCol = findCol('Total Collection');
  const headerRow = totalCol.row;
  const nameCol = 0;

  const numAt = (row, hdr) => {
    const raw = row[hdr.col]?.v;
    return typeof raw === 'number' ? raw : (parseFloat(String(raw).replace(/[$,]/g, '')) || 0);
  };

  const readEntry = row => {
    const entry = { totalCollection: numAt(row, totalCol) };
    categoryCols.forEach(c => { entry[c.key] = numAt(row, c.col); });
    return entry;
  };

  const stores = {};
  let grandTotal = null;

  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!rowHasData(row)) continue;
    const label = cellText(row[nameCol]);
    if (!label) continue;

    if (/^grand\s*total$/i.test(label)) { grandTotal = readEntry(row); continue; }

    const storeName = matchStoreName(label);
    if (storeName) stores[storeName] = readEntry(row);
  }

  if (!Object.keys(stores).length) throw new Error('Could not match any store names (Concord, Media, Pike Creek) in this file.');

  return { fileName: file.name, stores, grandTotal };
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

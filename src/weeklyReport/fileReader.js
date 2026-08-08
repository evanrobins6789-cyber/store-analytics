import * as XLSX from 'xlsx';

// Browser-adapted from Lauren's wtc-weekly-report app (lib/parse/fileReader.js),
// which ran server-side against a Node Buffer — here we read a browser File
// into an ArrayBuffer instead.

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => resolve(ev.target.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsArrayBuffer(file);
  });
}

// Splits one line of delimited text into cells, respecting double-quoted fields.
function splitLine(line, delimiter) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map(c => c.trim().replace(/^"|"$/g, ''));
}

function decodeText(buffer) {
  const bytes = new Uint8Array(buffer);
  // UTF-16 LE BOM (Zenoti's "KPI" and "Cerologist Journey Sheet" exports)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.slice(2));
  }
  // UTF-8 BOM or plain UTF-8 (Zenoti's "Sales-Accrual" and "Attendance" CSV exports)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.slice(3));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// Reads any supported report file (.csv in either encoding, or .xlsx) into a
// simple array-of-arrays of cell values, dropping fully blank rows.
export function readRows(arrayBuffer, filename) {
  const isXlsx = /\.xlsx?$/i.test(filename || '');

  if (isXlsx) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    return rows.filter(r => r.some(c => c !== null && c !== ''));
  }

  const text = decodeText(arrayBuffer);
  const delimiter = text.split('\n')[0].includes('\t') ? '\t' : ',';
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  return lines.map(l => splitLine(l, delimiter));
}

// Finds the header row by looking for one of the given expected column names,
// and returns { headerIndex, headers, dataRows }. This lets the same parser
// handle both a plain CSV (header on row 1) and an XLSX export with title
// rows above the real header (Zenoti's MTD exports do this).
export function findHeaderAndData(rows, expectedHeaderCell) {
  const headerIndex = rows.findIndex(r =>
    r.some(c => typeof c === 'string' && c.trim() === expectedHeaderCell)
  );
  if (headerIndex === -1) {
    throw new Error(`Could not find expected header "${expectedHeaderCell}" in this file. Is this the right report?`);
  }
  const headers = rows[headerIndex].map(c => (typeof c === 'string' ? c.trim() : c));
  const dataRows = rows.slice(headerIndex + 1);
  return { headers, dataRows };
}

export function cellByHeader(headers, row, name) {
  const idx = headers.indexOf(name);
  return idx === -1 ? null : row[idx];
}

export function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// Converts an "H:MM" string or an Excel time-of-day fraction/Date into decimal hours.
export function toHours(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'string' && v.includes(':')) {
    const [h, m] = v.split(':').map(Number);
    return h + m / 60;
  }
  if (v instanceof Date) {
    return v.getHours() + v.getMinutes() / 60 + v.getSeconds() / 3600;
  }
  if (typeof v === 'number') {
    // Excel stores a time-of-day as a fraction of 24 hours when cellDates
    // can't resolve it to a Date (rare, but guard for it).
    return v * 24;
  }
  return 0;
}

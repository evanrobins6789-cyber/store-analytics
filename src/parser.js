import * as XLSX from 'xlsx';

function findCol(keys, candidates) {
  for (const c of candidates) {
    const found = keys.find(k =>
      k.toLowerCase().replace(/[\s_\-]/g, '').includes(c.toLowerCase().replace(/[\s_\-]/g, ''))
    );
    if (found !== undefined) return found;
  }
  return null;
}

function parseNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,%]/g, '').trim());
  return isNaN(n) ? null : n;
}

function cleanStoreName(name) {
  return String(name).replace(/^\d+[\s\-–—:\.]*/, '').trim();
}

function isGrandTotalRow(row, keys) {
  for (const k of keys.slice(0, 4)) {
    const val = String(row[k] || '').toLowerCase().trim();
    if (['total', 'grand total', 'totals', 'subtotal'].includes(val)) return true;
  }
  return false;
}

// Normalize any date format to YYYY-MM-DD
function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // DD/MM/YYYY (less common but handle it)
  const dmy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Excel serial number (number of days since 1900-01-01)
  const serial = parseFloat(s);
  if (!isNaN(serial) && serial > 40000) {
    const date = new Date((serial - 25569) * 86400 * 1000);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ISO with time component
  const iso = s.split('T')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;

  return null;
}

export function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!raw.length) { reject(new Error('No data found in file.')); return; }

        const keys = Object.keys(raw[0]);
        const storeCol      = findCol(keys, ['store', 'location', 'centre', 'center', 'site', 'branch', 'name']);
        const revCol        = findCol(keys, ['revenue', 'netsales', 'totalsales', 'sales', 'amount', 'gross']);
        const cutsCol       = findCol(keys, ['cuts', 'services', 'appointments', 'appts', 'visits', 'bookings', 'count']);
        const tsthCol       = findCol(keys, ['tsth', 'salestohour', 'salesperhour', 'sph', 'sth']);
        const productNetCol = findCol(keys, ['productnet', 'prodnet', 'productrevenue']);
        const colorNetCol   = findCol(keys, ['colornet', 'colournet', 'colorrevenue']);
        const dateCol       = findCol(keys, ['date', 'day']);

        const dataRows = raw.slice(0, -1).filter(row => !isGrandTotalRow(row, keys));

        // Determine file date from first data row or filename
        let fileDate = null;
        if (dateCol && dataRows[0]) {
          fileDate = normalizeDate(dataRows[0][dateCol]);
        }
        if (!fileDate) {
          fileDate = normalizeDate(file.name.replace(/\.[^.]+$/, '').trim());
        }
        if (!fileDate) {
          fileDate = new Date().toISOString().split('T')[0];
        }

        let storeMap = {};
        let totalRev = 0, totalCuts = 0, tsthVals = [];
        let totalProductNet = 0, totalColorNet = 0;

        dataRows.forEach(row => {
          const rawName    = storeCol ? String(row[storeCol]) : 'Unknown';
          const name       = cleanStoreName(rawName);
          const rev        = revCol        ? (parseNum(row[revCol])        ?? 0) : 0;
          const cuts       = cutsCol       ? (parseNum(row[cutsCol])       ?? 0) : 0;
          const tsth       = tsthCol       ? parseNum(row[tsthCol])             : null;
          const productNet = productNetCol ? (parseNum(row[productNetCol]) ?? 0) : 0;
          const colorNet   = colorNetCol   ? (parseNum(row[colorNetCol])   ?? 0) : 0;

          if (!storeMap[name]) storeMap[name] = { revenue: 0, cuts: 0, tsth: 0, productNet: 0, colorNet: 0 };
          storeMap[name].revenue    += rev;
          storeMap[name].cuts       += cuts;
          storeMap[name].productNet += productNet;
          storeMap[name].colorNet   += colorNet;

          totalRev        += rev;
          totalCuts       += cuts;
          totalProductNet += productNet;
          totalColorNet   += colorNet;
          if (tsth !== null && tsth > 0) tsthVals.push(tsth);
        });

        const tsthAvg = tsthVals.length > 0
          ? tsthVals.reduce((a, v) => a + v, 0) / tsthVals.length
          : 0;

        Object.keys(storeMap).forEach(name => {
          storeMap[name].revenue    = Math.round(storeMap[name].revenue    * 100) / 100;
          storeMap[name].cuts       = Math.round(storeMap[name].cuts);
          storeMap[name].productNet = Math.round(storeMap[name].productNet * 100) / 100;
          storeMap[name].colorNet   = Math.round(storeMap[name].colorNet   * 100) / 100;
        });

        const entry = {
          date:       fileDate,
          revenue:    Math.round(totalRev        * 100) / 100,
          cuts:       Math.round(totalCuts),
          tsth:       Math.round(tsthAvg         * 100) / 100,
          productNet: Math.round(totalProductNet * 100) / 100,
          colorNet:   Math.round(totalColorNet   * 100) / 100,
          stores:     storeMap,
          detectedCols: { storeCol, revCol, cutsCol, tsthCol, productNetCol, colorNetCol, dateCol },
          uploadedAt: new Date().toISOString()
        };

        resolve(entry);
      } catch (err) {
        reject(new Error('Could not parse file. Make sure it is a Zenoti Excel export.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

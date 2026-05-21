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
        const storeCol = findCol(keys, ['store', 'location', 'centre', 'center', 'site', 'branch', 'name']);
        const revCol   = findCol(keys, ['revenue', 'netsales', 'totalsales', 'sales', 'amount', 'gross']);
        const cutsCol  = findCol(keys, ['cuts', 'services', 'appointments', 'appts', 'visits', 'bookings', 'count']);
        const tsthCol  = findCol(keys, ['tsth', 'salestohour', 'salesperhour', 'sph', 'sth']);
        const dateCol  = findCol(keys, ['date', 'day']);

        const dataRows = raw.slice(0, -1).filter(row => !isGrandTotalRow(row, keys));

        let fileDate = dateCol
          ? String(dataRows[0]?.[dateCol] || '').split('T')[0].trim()
          : file.name.replace(/\.[^.]+$/, '').trim();
        if (!fileDate || fileDate === 'undefined') fileDate = new Date().toISOString().split('T')[0];

        let storeMap = {};
        let totalRev = 0, totalCuts = 0, tsthVals = [];

        dataRows.forEach(row => {
          const rawName = storeCol ? String(row[storeCol]) : 'Unknown';
          const name    = cleanStoreName(rawName);
          const rev     = revCol  ? (parseNum(row[revCol])  ?? 0) : 0;
          const cuts    = cutsCol ? (parseNum(row[cutsCol]) ?? 0) : 0;
          const tsth    = tsthCol ? parseNum(row[tsthCol])        : null;

          if (!storeMap[name]) storeMap[name] = { revenue: 0, cuts: 0 };
          storeMap[name].revenue += rev;
          storeMap[name].cuts    += cuts;
          totalRev  += rev;
          totalCuts += cuts;
          if (tsth !== null && tsth > 0) tsthVals.push(tsth);
        });

        const tsthAvg = tsthVals.length > 0
          ? tsthVals.reduce((a, v) => a + v, 0) / tsthVals.length
          : 0;

        const entry = {
          date:      fileDate,
          revenue:   Math.round(totalRev * 100) / 100,
          cuts:      Math.round(totalCuts),
          tsth:      Math.round(tsthAvg * 100) / 100,
          stores:    Object.fromEntries(
                       Object.entries(storeMap).map(([k, v]) => [k, {
                         revenue: Math.round(v.revenue * 100) / 100,
                         cuts:    Math.round(v.cuts)
                       }])
                     ),
          detectedCols: { storeCol, revCol, cutsCol, tsthCol, dateCol },
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

import { readWorkbookGrid, cellText } from './parser';

// ─── P&L / Contribution Report ──────────────────────────────────────────────
// Expected shape (a QuickBooks-style "Contribution Report" export): one header
// block of 3 rows spanning many columns — a location name, then either a
// "(parent group)" tag or (for the grand-total columns) the location name
// again, then a row of "Mon YY" / "Mon YY" / "% of Income" column headers
// repeated once per location. Below that, indented line-item rows for
// Income, Expense, and their subtotals, one value per location per column.
//
// The column layout (how many locations, how wide each one is, whether a
// store was added or removed) is never assumed — everything is located by
// scanning for the "Mon YY" / "% of Income" text and the first non-blank
// label cell on each row, so a new month's file only needs to match this
// general shape, not a fixed set of columns.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function isMonthYearText(t) {
  return /^[A-Za-z]{3}\s*\d{2,4}$/.test(t.trim());
}

function parseMonthLabel(label) {
  const m = String(label || '').trim().match(/^([A-Za-z]{3})\s*(\d{2,4})$/);
  if (!m) return { key: label || 'unknown', display: label };
  const mon = MONTHS[m[1].toLowerCase()];
  let year = parseInt(m[2], 10);
  if (m[2].length === 2) year += year < 70 ? 2000 : 1900;
  if (mon == null) return { key: label, display: label };
  return { key: `${year}-${String(mon + 1).padStart(2, '0')}`, display: label };
}

function numAt(row, col) {
  if (col == null) return null;
  const cell = row[col];
  return typeof cell?.v === 'number' ? cell.v : null;
}

const TOTAL_LABELS = ['gross profit', 'net ordinary income', 'net income'];

export async function parsePLFile(file) {
  const grid = await readWorkbookGrid(file);

  // ── Find the "Mon YY" / "% of Income" header row ──
  let headerRow = null;
  for (let r = 0; r < Math.min(grid.length, 6); r++) {
    if (grid[r].some(c => isMonthYearText(cellText(c)))) { headerRow = r; break; }
  }
  if (headerRow == null || headerRow < 2) {
    throw new Error('Could not find the "Mon YY" / "% of Income" column headers in this file. Make sure it is a Contribution Report / P&L export.');
  }
  const nameRow = headerRow - 2;
  const groupRow = headerRow - 1;
  const width = grid[headerRow].length;

  // ── Locate each location's starting column: row(name) has the location's
  // own name, OR row(group) has it directly (used for the grand-total
  // columns, which have no separate parent-group tag) ──
  const isParenTag = t => /^\(.*\)$/.test(t);
  const locStarts = [];
  for (let c = 0; c < width; c++) {
    const t1 = cellText(grid[nameRow][c]);
    const t2 = cellText(grid[groupRow][c]);
    if (t1) locStarts.push({ col: c, name: t1, group: isParenTag(t2) ? t2 : null });
    else if (t2 && !isParenTag(t2)) locStarts.push({ col: c, name: t2, group: null });
  }
  if (!locStarts.length) throw new Error('Could not find any location columns in this file.');

  const locations = locStarts.map((loc, i) => {
    const endCol = (i + 1 < locStarts.length ? locStarts[i + 1].col : width) - 1;
    const monthCols = [];
    let pctCol = null;
    for (let c = loc.col; c <= endCol; c++) {
      const t = cellText(grid[headerRow][c]);
      if (!t) continue;
      if (isMonthYearText(t)) monthCols.push({ col: c, label: t });
      else if (/% of income/i.test(t)) pctCol = c;
    }
    return {
      key: loc.name,
      label: loc.name,
      group: loc.group,
      curCol: monthCols[0]?.col ?? null,
      priorCol: monthCols[1]?.col ?? null,
      pctCol,
      currentLabel: monthCols[0]?.label ?? null,
      priorLabel: monthCols[1]?.label ?? null,
    };
  });

  const currentLabel = locations.find(l => l.currentLabel)?.currentLabel || null;
  const priorLabel = locations.find(l => l.priorLabel)?.priorLabel || null;
  const period = parseMonthLabel(currentLabel);

  // ── Everything left of the first location's own column is the line-item
  // label area; how far right the label starts in a given row is its
  // indent level in the original statement ──
  const labelScanEnd = Math.min(...locStarts.map(l => l.col)) - 1;

  const rows = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r];
    let label = null, indent = null;
    for (let c = 0; c <= labelScanEnd; c++) {
      const t = cellText(row[c]);
      if (t) { label = t; indent = c; break; }
    }
    if (!label) continue;

    const values = {};
    let hasData = false;
    locations.forEach(loc => {
      const current = numAt(row, loc.curCol);
      const prior = numAt(row, loc.priorCol);
      const pct = numAt(row, loc.pctCol);
      if (current != null || prior != null) hasData = true;
      values[loc.key] = { current, prior, pct };
    });

    // Pure wrapper row ("Ordinary Income/Expense") carries no data of its
    // own and isn't a useful section divider — skip it.
    if (!hasData && label === 'Ordinary Income/Expense') continue;

    const isTotal = /^total\b/i.test(label) || TOTAL_LABELS.includes(label.toLowerCase());
    rows.push({ label, indent, isTotal, isSectionHeader: !hasData && !isTotal, values });
  }

  if (!rows.length) throw new Error('Found the column headers but no line items underneath — check this is a full P&L export.');

  return {
    fileName: file.name,
    currentLabel,
    priorLabel,
    monthKey: period.key,
    monthDisplay: currentLabel || period.key,
    locations: locations.map(({ key, label, group }) => ({ key, label, group })),
    rows,
  };
}

import XLSX from 'xlsx';

const MAX_ROWS = 200;
const MAX_COLS = 50;
const MAX_CHARS_PER_FILE = 50_000;

/**
 * Extract text content from an XLSX buffer.
 * @param {Buffer} buffer - The XLSX file buffer
 * @param {string} fileName - Original file name for header
 * @returns {string} Extracted text (never throws)
 */
export function extractXlsxText(buffer, fileName) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts = [`--- Extracted from: ${fileName} ---`];

    for (const sheetName of workbook.SheetNames) {
      parts.push(`\n=== Sheet: ${sheetName} ===`);
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      const limitedRows = rows.slice(0, MAX_ROWS);
      for (const row of limitedRows) {
        const limitedCols = row.slice(0, MAX_COLS);
        // Skip empty rows
        if (limitedCols.every(cell => cell === '' || cell === null || cell === undefined)) continue;
        parts.push(limitedCols.map(cell => String(cell ?? '')).join('\t'));
      }

      if (rows.length > MAX_ROWS) {
        parts.push(`...[${rows.length - MAX_ROWS} rows truncated]`);
      }
    }

    let text = parts.join('\n');
    if (text.length > MAX_CHARS_PER_FILE) {
      text = text.slice(0, MAX_CHARS_PER_FILE) + '\n...[truncated]';
    }
    return text;
  } catch (err) {
    return `[XLSX extraction failed for ${fileName}: ${err.message}]`;
  }
}

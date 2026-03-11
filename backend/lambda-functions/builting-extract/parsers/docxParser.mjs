import mammoth from 'mammoth';

const MAX_CHARS_PER_FILE = 50_000;

/**
 * Extract text content from a DOCX buffer.
 * @param {Buffer} buffer - The DOCX file buffer
 * @param {string} fileName - Original file name for header
 * @returns {Promise<string>} Extracted text (never throws)
 */
export async function extractDocxText(buffer, fileName) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    let text = `--- Extracted from: ${fileName} ---\n${result.value}`;
    if (text.length > MAX_CHARS_PER_FILE) {
      text = text.slice(0, MAX_CHARS_PER_FILE) + '\n...[truncated]';
    }
    return text;
  } catch (err) {
    return `[DOCX extraction failed for ${fileName}: ${err.message}]`;
  }
}

import sanitizeHtml from "sanitize-html";

const TELEGRAM_ALLOWED_TAGS = [
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "a",
];

const TABLE_COLUMN_MAX_WIDTH = 24;
const TABLE_GRID_MAX_WIDTH = 92;

interface TableRow {
  cells: string[];
  isHeader: boolean;
}

const TELEGRAM_EXCLUSIVE_FILTER = (frame: { tag: string }): boolean =>
  frame.tag === "script" || frame.tag === "style";

export function sanitizeTelegramHtml(html: string): string {
  return sanitizeHtml(normalizeTelegramHtmlInput(html), {
    allowedTags: TELEGRAM_ALLOWED_TAGS,
    allowedAttributes: { a: ["href"] },
    exclusiveFilter: TELEGRAM_EXCLUSIVE_FILTER,
  });
}

export function stripHtml(html: string): string {
  return sanitizeHtml(normalizeTelegramHtmlInput(html), {
    allowedTags: [],
    allowedAttributes: {},
    exclusiveFilter: TELEGRAM_EXCLUSIVE_FILTER,
  });
}

function normalizeTelegramHtmlInput(html: string): string {
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => renderHtmlTable(tableHtml))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(?:p|div|section|article|header|footer|blockquote|ul|ol|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderHtmlTable(tableHtml: string): string {
  const rows = compactTableColumns(extractTableRows(tableHtml));
  if (rows.length === 0) {
    return sanitizeHtml(tableHtml, {
      allowedTags: [],
      allowedAttributes: {},
      exclusiveFilter: TELEGRAM_EXCLUSIVE_FILTER,
    });
  }

  return shouldUseStackedTable(rows) ? renderStackedTable(rows) : renderGridTable(rows);
}

function extractTableRows(tableHtml: string): TableRow[] {
  const rows: TableRow[] = [];
  const rowMatches = tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);

  for (const rowMatch of rowMatches) {
    const rowHtml = rowMatch[1] ?? "";
    const cellMatches = [...rowHtml.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
    if (cellMatches.length === 0) continue;

    rows.push({
      isHeader: cellMatches.every((cellMatch) => (cellMatch[1] ?? "").toLowerCase() === "th"),
      cells: cellMatches.map((cellMatch) => htmlTableCellToText(cellMatch[2] ?? "")),
    });
  }

  return rows.filter((row) => row.cells.some((cell) => cell.length > 0));
}

function htmlTableCellToText(cellHtml: string): string {
  const normalized = cellHtml
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(?:p|div|section|article|header|footer|blockquote|ul|ol|h[1-6])\b[^>]*>/gi, "\n");

  const stripped = sanitizeHtml(normalized, {
    allowedTags: [],
    allowedAttributes: {},
    exclusiveFilter: TELEGRAM_EXCLUSIVE_FILTER,
  });

  return decodeHtmlEntities(stripped)
    .split("\n")
    .map((line) => line.replace(/[\t \u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
}

function compactTableColumns(rows: TableRow[]): TableRow[] {
  const columnCount = Math.max(...rows.map((row) => row.cells.length), 0);
  const keepIndices = Array.from({ length: columnCount }, (_, index) => index).filter((index) =>
    rows.some((row) => (row.cells[index] ?? "").trim().length > 0),
  );

  if (keepIndices.length === 0) return [];

  return rows.map((row) => ({
    isHeader: row.isHeader,
    cells: keepIndices.map((index) => row.cells[index] ?? ""),
  }));
}

function shouldUseStackedTable(rows: TableRow[]): boolean {
  const columnCount = Math.max(...rows.map((row) => row.cells.length), 0);
  if (columnCount > 5) return true;

  const widths = measureColumnWidths(rows);
  const estimatedWidth =
    widths.reduce((sum, width) => sum + width, 0) + Math.max(0, (widths.length - 1) * 3);

  return estimatedWidth > TABLE_GRID_MAX_WIDTH;
}

function renderGridTable(rows: TableRow[]): string {
  const widths = measureColumnWidths(rows);
  const lines: string[] = [];

  rows.forEach((row, index) => {
    lines.push(
      row.cells
        .map((cell, cellIndex) => truncateCell(cell, widths[cellIndex] ?? TABLE_COLUMN_MAX_WIDTH))
        .map((cell, cellIndex) => cell.padEnd(widths[cellIndex] ?? TABLE_COLUMN_MAX_WIDTH))
        .join(" | ")
        .trimEnd(),
    );

    if (index === 0 && row.isHeader) {
      lines.push(widths.map((width) => "-".repeat(width)).join("-+-"));
    }
  });

  return `\n<pre>${escapeHtml(lines.join("\n"))}</pre>\n`;
}

function renderStackedTable(rows: TableRow[]): string {
  const headerLabels = rows[0]?.isHeader
    ? rows[0].cells.map((cell, index) => cell || `Column ${index + 1}`)
    : (rows[0]?.cells.map((_cell, index) => `Column ${index + 1}`) ?? []);
  const dataRows = rows[0]?.isHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0) {
    return renderGridTable(rows);
  }
  const lines: string[] = [];

  dataRows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push("");
    row.cells.forEach((cell, cellIndex) => {
      if (!cell) return;
      const label = truncateCell(headerLabels[cellIndex] ?? `Column ${cellIndex + 1}`, 24);
      lines.push(`${label}: ${truncateCell(cell, 72)}`);
    });
  });

  return `\n<pre>${escapeHtml(lines.join("\n").trim())}</pre>\n`;
}

function measureColumnWidths(rows: TableRow[]): number[] {
  const columnCount = Math.max(...rows.map((row) => row.cells.length), 0);
  return Array.from({ length: columnCount }, (_, index) =>
    Math.min(
      TABLE_COLUMN_MAX_WIDTH,
      Math.max(3, ...rows.map((row) => (row.cells[index] ?? "").length)),
    ),
  );
}

function truncateCell(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 1)}…`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeNumericEntity(hex, 16))
    .replace(/&#(\d+);/g, (_match, dec: string) => decodeNumericEntity(dec, 10));
}

function decodeNumericEntity(value: string, radix: 10 | 16): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}

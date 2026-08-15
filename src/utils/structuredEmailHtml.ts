import { Parser } from "htmlparser2";
import { DomHandler, isTag, isText, type ChildNode, type Document, type Element } from "domhandler";
import { escapeHtml, escapeHtmlAttribute } from "./html.js";

const MAX_INPUT_CHARACTERS = 1_000_000;
const MAX_DOM_NODES = 20_000;
const MAX_VISITED_NODES = 20_000;
const MAX_INPUT_DEPTH = 32;
const MAX_MODEL_BLOCKS = 600;
const MAX_RICH_TEXT_CHARACTERS = 32_768;
const MAX_RICH_BLOCKS = 500;
const MAX_RICH_TABLE_COLUMNS = 20;
const OMITTED_NOTICE = "[... content omitted]";

const DROPPED_ELEMENTS = new Set([
  "applet",
  "audio",
  "button",
  "canvas",
  "embed",
  "form",
  "head",
  "iframe",
  "img",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "textarea",
  "title",
  "track",
  "video",
]);

const BLOCK_CONTAINERS = new Set([
  "address",
  "article",
  "aside",
  "body",
  "center",
  "div",
  "header",
  "html",
  "main",
  "nav",
  "p",
  "section",
]);

const INLINE_TAGS: Record<string, string> = {
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
};

type TableKind = "key_value" | "records" | "grid";

interface InlineContent {
  text: string;
  classicHtml: string;
  richHtml: string;
  hasLinks: boolean;
  maxDepth: number;
  containsCode: boolean;
  containsAnchor: boolean;
}

interface TableCell extends InlineContent {
  isHeader: boolean;
  isStrong: boolean;
  colspan: number;
  rowspan: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
}

interface PositionedTableCell {
  cell: TableCell;
  column: number;
}

interface StructuredTable {
  rows: TableCell[][];
  caption: InlineContent | null;
  kind: TableKind;
  logicalColumns: number;
}

type StructuredBlock =
  | { kind: "paragraph"; content: InlineContent }
  | { kind: "heading"; level: number; content: InlineContent }
  | { kind: "pre"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: InlineContent[] }
  | { kind: "quote"; content: InlineContent }
  | { kind: "divider" }
  | { kind: "footer"; content: InlineContent }
  | { kind: "table"; table: StructuredTable };

interface ParseContext {
  visitedNodes: number;
  sourceTruncated: boolean;
  domTruncated: boolean;
  nodeLimitExceeded: boolean;
  depthLimitExceeded: boolean;
  modelTruncated: boolean;
}

export interface StructuredHtmlStats {
  textCharacters: number;
  blocks: number;
  maxTableColumns: number;
  outputDepth: number;
}

export interface StructuredHtmlResult {
  classicHtml: string;
  plainText: string;
  richHtml: string | null;
  hasLinks: boolean;
  /** True when source HTML produced visible content before any synthetic notice. */
  hasVisibleContent: boolean;
  richIneligibleReason:
    | "input_limit"
    | "text_limit"
    | "block_limit"
    | "column_limit"
    | "depth_limit"
    | null;
  stats: StructuredHtmlStats;
}

class BoundedDomHandler extends DomHandler {
  private parserRef: Parser | null = null;
  private nodeCount = 0;
  truncated = false;

  override onparserinit(parser: Parser): void {
    this.parserRef = parser;
    super.onparserinit(parser);
  }

  protected override addNode(node: ChildNode): void {
    this.nodeCount++;
    if (this.nodeCount > MAX_DOM_NODES) {
      this.truncated = true;
      this.parserRef?.pause();
      return;
    }
    super.addNode(node);
  }

  finishPartialDocument(): void {
    if (this.truncated) super.onend();
  }
}

function parseBoundedDocument(input: string): { document: Document; truncated: boolean } {
  const handler = new BoundedDomHandler();
  const parser = new Parser(handler, { decodeEntities: true });
  parser.end(input);
  handler.finishPartialDocument();
  return { document: handler.root, truncated: handler.truncated };
}

/**
 * Parse untrusted email HTML once into a closed, bounded model and render both
 * Telegram formats from that model. No source tag or attribute is passed
 * through verbatim.
 */
export function renderStructuredEmailHtml(source: string): StructuredHtmlResult {
  const input = source.slice(0, MAX_INPUT_CHARACTERS);
  const parsed = parseBoundedDocument(input);
  const context: ParseContext = {
    visitedNodes: 0,
    sourceTruncated: source.length > input.length,
    domTruncated: parsed.truncated,
    nodeLimitExceeded: false,
    depthLimitExceeded: false,
    modelTruncated: false,
  };
  const blocks = parseBlocks(parsed.document.children, context, 0);
  const hasVisibleContent = blocks.length > 0;

  if (inputWasTruncated(context)) {
    const notice: StructuredBlock = {
      kind: "paragraph",
      content: inlineText(OMITTED_NOTICE),
    };
    if (blocks.length >= MAX_MODEL_BLOCKS) blocks[MAX_MODEL_BLOCKS - 1] = notice;
    else blocks.push(notice);
  }

  const stats = measureRichStats(blocks);
  const richIneligibleReason = richEligibilityReason(context, stats);

  return {
    classicHtml: renderClassicBlocks(blocks),
    plainText: renderPlainBlocks(blocks),
    richHtml: richIneligibleReason === null ? renderRichBlocks(blocks) : null,
    hasLinks: blocks.some(blockHasLinks),
    hasVisibleContent,
    richIneligibleReason,
    stats,
  };
}

function parseBlocks(nodes: ChildNode[], context: ParseContext, depth: number): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  let inlineRun: ChildNode[] = [];

  const pushBlock = (block: StructuredBlock): void => {
    if (blocks.length >= MAX_MODEL_BLOCKS) {
      context.modelTruncated = true;
      return;
    }
    blocks.push(block);
  };

  const flushInlineRun = (): void => {
    if (inlineRun.length === 0) return;
    const content = parseInline(inlineRun, context, depth + 1);
    inlineRun = [];
    if (content.text) pushBlock({ kind: "paragraph", content });
  };

  for (const node of nodes) {
    if (!enterNode(context, depth)) {
      if (context.nodeLimitExceeded) break;
      continue;
    }
    if (isText(node)) {
      if (node.data.trim()) inlineRun.push(node);
      continue;
    }
    if (!isTag(node)) continue;

    const name = node.name.toLowerCase();
    if (DROPPED_ELEMENTS.has(name)) continue;

    if (!isBlockElement(name)) {
      if (containsBlockChild(node)) {
        flushInlineRun();
        for (const block of parseBlocks(node.children, context, depth + 1)) pushBlock(block);
      } else {
        inlineRun.push(node);
      }
      continue;
    }

    flushInlineRun();

    if (/^h[1-6]$/.test(name)) {
      const content = parseInline(node.children, context, depth + 1);
      if (content.text) {
        pushBlock({ kind: "heading", level: Number(name.slice(1)), content });
      }
      continue;
    }

    if (name === "pre") {
      const text = collectText(node.children, context, depth + 1, true).trimEnd();
      if (text) pushBlock({ kind: "pre", text });
      continue;
    }

    if (name === "hr") {
      pushBlock({ kind: "divider" });
      continue;
    }

    if (name === "ul" || name === "ol") {
      const items = directChildrenNamed(node, "li")
        .map((item) => parseInline(item.children, context, depth + 1))
        .filter((item) => item.text);
      if (items.length > 0) {
        pushBlock({
          kind: "list",
          ordered: name === "ol",
          start: name === "ol" ? boundedListStart(node.attribs["start"]) : 1,
          items,
        });
      }
      continue;
    }

    if (name === "blockquote") {
      const content = parseInline(node.children, context, depth + 1);
      if (content.text) pushBlock({ kind: "quote", content });
      continue;
    }

    if (name === "footer") {
      const content = parseInline(node.children, context, depth + 1);
      if (content.text) pushBlock({ kind: "footer", content });
      continue;
    }

    if (name === "table") {
      for (const block of parseTableElement(node, context, depth + 1)) pushBlock(block);
      continue;
    }

    if (containsBlockChild(node)) {
      for (const block of parseBlocks(node.children, context, depth + 1)) pushBlock(block);
    } else {
      const content = parseInline(node.children, context, depth + 1);
      if (content.text) pushBlock({ kind: "paragraph", content });
    }
  }

  flushInlineRun();
  return blocks;
}

function parseTableElement(
  tableElement: Element,
  context: ParseContext,
  depth: number,
): StructuredBlock[] {
  const rowElements = directTableRows(tableElement);
  const hasNestedTable = containsNestedTable(tableElement, context, depth + 1);
  const role = (tableElement.attribs["role"] ?? "").trim().toLowerCase();

  if (role === "presentation" || hasNestedTable) {
    return flattenLayoutTable(tableElement, rowElements, context, depth + 1);
  }

  let rows = rowElements
    .map((row) =>
      row.children
        .filter((node): node is Element => isTag(node) && /^(td|th)$/i.test(node.name))
        .map((cell) => parseTableCell(cell, context, depth + 1)),
    )
    .filter((row) => row.some((cell) => cell.text));

  if (rows.length === 0) return flattenLayoutTable(tableElement, rowElements, context, depth + 1);
  rows = removeEmptyUnspannedColumns(rows);

  const logicalColumns = measureLogicalTableColumns(rows);
  if (logicalColumns <= 1) {
    return flattenLayoutTable(tableElement, rowElements, context, depth + 1);
  }

  const captionElement = directChildrenNamed(tableElement, "caption")[0];
  const caption = captionElement ? parseInline(captionElement.children, context, depth + 1) : null;
  const inferredHeader = isHeaderRow(rows[0] ?? [], rows.slice(1));
  if (inferredHeader) {
    rows[0] = (rows[0] ?? []).map((cell) => ({ ...cell, isHeader: true }));
  }

  const headerRowCount = countLeadingHeaderRows(rows);
  const kind: TableKind =
    headerRowCount > 1
      ? "grid"
      : inferredHeader
        ? "records"
        : isKeyValueTable(rows)
          ? "key_value"
          : "grid";
  if (kind === "key_value") {
    rows = rows.map((row) =>
      row.map((cell, index) => (index % 2 === 0 ? { ...cell, isHeader: true } : cell)),
    );
  }

  return [{ kind: "table", table: { rows, caption, kind, logicalColumns } }];
}

function flattenLayoutTable(
  tableElement: Element,
  rowElements: Element[],
  context: ParseContext,
  depth: number,
): StructuredBlock[] {
  const blocks: StructuredBlock[] = [];
  const rows = rowElements.length > 0 ? rowElements : [tableElement];

  for (const row of rows) {
    const cells =
      row === tableElement
        ? [tableElement]
        : row.children.filter(
            (node): node is Element => isTag(node) && /^(td|th)$/i.test(node.name),
          );
    for (const cell of cells) {
      const cellBlocks = parseBlocks(cell.children, context, depth + 1);
      if (cellBlocks.length > 0) {
        blocks.push(...cellBlocks);
      } else {
        const content = parseInline(cell.children, context, depth + 1);
        if (content.text) blocks.push({ kind: "paragraph", content });
      }
    }
  }

  return blocks;
}

function parseTableCell(cell: Element, context: ParseContext, depth: number): TableCell {
  const content = parseInline(cell.children, context, depth + 1);
  const name = cell.name.toLowerCase();
  return {
    ...content,
    isHeader: name === "th",
    isStrong: name === "th" || isEntireCellStrong(cell, context, depth + 1),
    colspan: boundedSpan(cell.attribs["colspan"]),
    rowspan: boundedSpan(cell.attribs["rowspan"]),
    align: safeAlign(cell.attribs["align"]),
    valign: safeVAlign(cell.attribs["valign"]),
  };
}

function parseInline(
  nodes: ChildNode[],
  context: ParseContext,
  depth: number,
  trimBoundary = true,
): InlineContent {
  const parts = nodes.map((node) => parseInlineNode(node, context, depth));
  const text = normalizeInlineText(parts.map((part) => part.text).join(""), trimBoundary);
  let classicHtml = normalizeInlineClassicHtml(
    parts.map((part) => part.classicHtml).join(""),
    trimBoundary,
  );
  let richHtml = normalizeInlineRichHtml(parts.map((part) => part.richHtml).join(""), trimBoundary);
  if (!text) {
    classicHtml = "";
    richHtml = "";
  }
  return {
    text,
    classicHtml,
    richHtml,
    hasLinks: parts.some((part) => part.hasLinks) || /(?:https?:\/\/|mailto:)\S+/iu.test(text),
    maxDepth: Math.max(0, ...parts.map((part) => part.maxDepth)),
    containsCode: parts.some((part) => part.containsCode),
    containsAnchor: parts.some((part) => part.containsAnchor),
  };
}

function parseInlineNode(node: ChildNode, context: ParseContext, depth: number): InlineContent {
  if (!enterNode(context, depth)) return emptyInline();
  if (isText(node)) {
    const text = node.data.replace(/\r\n?/g, "\n").replace(/[\t\f\v\u00a0]+/g, " ");
    return inlineText(text);
  }
  if (!isTag(node)) return emptyInline();

  const name = node.name.toLowerCase();
  if (DROPPED_ELEMENTS.has(name)) return emptyInline();
  if (name === "br") {
    return {
      text: "\n",
      classicHtml: "\n",
      richHtml: "<br>",
      hasLinks: false,
      maxDepth: 0,
      containsCode: false,
      containsAnchor: false,
    };
  }

  if (name === "table") {
    const text = collectText([node], context, depth + 1, false);
    return inlineText(text);
  }

  const child = parseInline(node.children, context, depth + 1, false);
  if (!child.text) return emptyInline();

  if (name === "li") {
    const prefix = listItemPrefix(node);
    return {
      ...child,
      text: `\n${prefix}${child.text}\n`,
      classicHtml: `\n${prefix}${child.classicHtml}\n`,
      richHtml: `<br>${prefix}${child.richHtml}<br>`,
    };
  }

  if (name === "dt" || name === "dd") {
    return {
      ...child,
      text: `\n${child.text}\n`,
      classicHtml: `\n${child.classicHtml}\n`,
      richHtml: `<br>${child.richHtml}<br>`,
    };
  }

  if (name === "a") {
    const href = safeHref(node.attribs["href"]);
    if (!href) return child;
    // Malformed email HTML can nest anchors. Keep the already-normalized
    // inner link and discard the outer destination; Telegram link entities
    // cannot contain another link entity.
    if (child.containsAnchor) return { ...child, hasLinks: true };
    const classicContent = child.containsCode ? escapeHtml(child.text) : child.classicHtml;
    const richContent = child.containsCode ? escapeHtml(child.text) : child.richHtml;
    return {
      text: child.text,
      classicHtml: `<a href="${escapeHtmlAttribute(href)}">${classicContent}</a>`,
      richHtml: `<a href="${escapeHtmlAttribute(href)}">${richContent}</a>`,
      hasLinks: true,
      maxDepth: child.containsCode ? 1 : child.maxDepth + 1,
      containsCode: false,
      containsAnchor: true,
    };
  }

  const safeTag = INLINE_TAGS[name];
  if (safeTag) {
    if (safeTag === "code") {
      if (child.containsAnchor) return { ...child, containsCode: false };
      const escaped = escapeHtml(child.text);
      return {
        text: child.text,
        classicHtml: `<code>${escaped}</code>`,
        richHtml: `<code>${escaped}</code>`,
        hasLinks: child.hasLinks,
        maxDepth: 1,
        containsCode: true,
        containsAnchor: false,
      };
    }
    if (child.containsCode) return child;
    return {
      ...child,
      classicHtml: `<${safeTag}>${child.classicHtml}</${safeTag}>`,
      richHtml: `<${safeTag}>${child.richHtml}</${safeTag}>`,
      maxDepth: child.maxDepth + 1,
    };
  }

  if (isBlockElement(name)) {
    return {
      ...child,
      text: `\n${child.text}\n`,
      classicHtml: `\n${child.classicHtml}\n`,
      richHtml: `<br>${child.richHtml}<br>`,
    };
  }

  return child;
}

function renderClassicBlocks(blocks: StructuredBlock[]): string {
  return blocks
    .map((block) => renderClassicBlock(block))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function renderClassicBlock(block: StructuredBlock): string {
  switch (block.kind) {
    case "paragraph":
      return block.content.classicHtml;
    case "heading":
      return renderClassicBold(block.content);
    case "pre":
      return `<pre>${escapeHtml(block.text)}</pre>`;
    case "list":
      return block.items
        .map(
          (item, index) => `${block.ordered ? `${block.start + index}.` : "•"} ${item.classicHtml}`,
        )
        .join("\n");
    case "quote":
      return `&gt; ${block.content.classicHtml.replace(/\n/g, "\n&gt; ")}`;
    case "divider":
      return "────────";
    case "footer":
      return block.content.classicHtml;
    case "table":
      return renderClassicTable(block.table);
  }
}

function renderClassicBold(content: InlineContent): string {
  return content.containsCode ? content.classicHtml : `<b>${content.classicHtml}</b>`;
}

function renderClassicTable(table: StructuredTable): string {
  const caption = table.caption?.classicHtml ? `${renderClassicBold(table.caption)}\n` : "";

  if (table.kind === "key_value") {
    const rows = table.rows.map((row) => {
      const pairs: string[] = [];
      for (let index = 0; index < row.length; index += 2) {
        const label = row[index];
        const value = row[index + 1];
        if (!label?.text && !value?.text) continue;
        if (!value?.text) {
          pairs.push(label?.classicHtml ?? "");
          continue;
        }
        pairs.push(
          `<b>${label?.text ? escapeHtml(label.text) : `Field ${index / 2 + 1}`}:</b> ${value.classicHtml}`,
        );
      }
      return pairs.join(" · ");
    });
    return caption + rows.join("\n");
  }

  if (table.kind === "records" && table.rows.length > 1) {
    const positionedRows = positionTableRows(table.rows).rows;
    const headers = expandHeaderCells(positionedRows[0] ?? []);
    const records = positionedRows.slice(1).map((row) => {
      const titleCell = row.find(({ column }) => column === 0)?.cell;
      const title = titleCell?.classicHtml ? renderClassicBold(titleCell) : "";
      const fields = row.flatMap(({ cell, column }) => {
        if (column === 0 || !cell.text) return [];
        const label = headers.get(column)?.text
          ? escapeHtml(headers.get(column)?.text ?? "")
          : `Column ${column + 1}`;
        return [`${label}: ${cell.classicHtml}`];
      });
      return [title, fields.join(" · ")].filter(Boolean).join("\n");
    });
    return caption + records.join("\n\n");
  }

  const rows = table.rows.map((row) =>
    row.flatMap((cell) => (cell.text ? [cell.classicHtml] : [])).join(" · "),
  );
  return caption + rows.join("\n");
}

function renderPlainBlocks(blocks: StructuredBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
        case "heading":
        case "quote":
        case "footer":
          return block.content.text;
        case "pre":
          return block.text;
        case "divider":
          return "────────";
        case "list":
          return block.items
            .map((item, index) => `${block.ordered ? `${block.start + index}.` : "•"} ${item.text}`)
            .join("\n");
        case "table":
          return renderPlainTable(block.table);
      }
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function renderPlainTable(table: StructuredTable): string {
  const caption = table.caption?.text ? `${table.caption.text}\n` : "";
  if (table.kind === "key_value") {
    return (
      caption +
      table.rows
        .map((row) => {
          const pairs: string[] = [];
          for (let index = 0; index < row.length; index += 2) {
            const label = row[index]?.text;
            const value = row[index + 1]?.text;
            if (label && value) pairs.push(`${label}: ${value}`);
            else if (label || value) pairs.push(label || value || "");
          }
          return pairs.join(" · ");
        })
        .join("\n")
    );
  }
  if (table.kind === "records" && table.rows.length > 1) {
    const positionedRows = positionTableRows(table.rows).rows;
    const headers = expandHeaderCells(positionedRows[0] ?? []);
    return (
      caption +
      positionedRows
        .slice(1)
        .map((row) => {
          const title = row.find(({ column }) => column === 0)?.cell.text ?? "";
          const fields = row.flatMap(({ cell, column }) =>
            column > 0 && cell.text
              ? [`${headers.get(column)?.text || `Column ${column + 1}`}: ${cell.text}`]
              : [],
          );
          return [title, fields.join(" · ")].filter(Boolean).join("\n");
        })
        .join("\n\n")
    );
  }
  return (
    caption +
    table.rows
      .map((row) => row.flatMap((cell) => (cell.text ? [cell.text] : [])).join(" · "))
      .join("\n")
  );
}

function renderRichBlocks(blocks: StructuredBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
          return `<p>${block.content.richHtml}</p>`;
        case "heading":
          return `<h${block.level}>${block.content.richHtml}</h${block.level}>`;
        case "pre":
          return `<pre>${escapeHtml(block.text)}</pre>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
          return `<${tag}${start}>${block.items.map((item) => `<li>${item.richHtml}</li>`).join("")}</${tag}>`;
        }
        case "quote":
          return `<blockquote>${block.content.richHtml}</blockquote>`;
        case "divider":
          return "<hr>";
        case "footer":
          return `<footer>${block.content.richHtml}</footer>`;
        case "table":
          return renderRichTable(block.table);
      }
    })
    .join("");
}

function renderRichTable(table: StructuredTable): string {
  const caption = table.caption?.richHtml ? `<caption>${table.caption.richHtml}</caption>` : "";
  const rows = table.rows
    .map((row) => {
      const cells = row
        .map((cell) => {
          const tag = cell.isHeader ? "th" : "td";
          const attrs = [
            cell.colspan > 1 ? `colspan="${cell.colspan}"` : "",
            cell.rowspan > 1 ? `rowspan="${cell.rowspan}"` : "",
            cell.align ? `align="${cell.align}"` : "",
            cell.valign ? `valign="${cell.valign}"` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `<${tag}${attrs ? ` ${attrs}` : ""}>${cell.richHtml}</${tag}>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table>${caption}${rows}</table>`;
}

function measureRichStats(blocks: StructuredBlock[]): StructuredHtmlStats {
  let textCharacters = 0;
  let blockCount = 0;
  let maxTableColumns = 0;
  let outputDepth = 0;

  for (const block of blocks) {
    blockCount += 1;
    switch (block.kind) {
      case "paragraph":
      case "heading":
      case "quote":
      case "footer":
        textCharacters += codePointLength(block.content.text);
        outputDepth = Math.max(outputDepth, 1 + block.content.maxDepth);
        break;
      case "pre":
        textCharacters += codePointLength(block.text);
        outputDepth = Math.max(outputDepth, 1);
        break;
      case "list":
        blockCount += block.items.length;
        textCharacters += block.items.reduce((sum, item) => sum + codePointLength(item.text), 0);
        outputDepth = Math.max(
          outputDepth,
          2 + Math.max(0, ...block.items.map((item) => item.maxDepth)),
        );
        break;
      case "divider":
        outputDepth = Math.max(outputDepth, 1);
        break;
      case "table":
        blockCount += block.table.rows.length;
        maxTableColumns = Math.max(maxTableColumns, block.table.logicalColumns);
        textCharacters += block.table.rows.reduce(
          (sum, row) => sum + row.reduce((rowSum, cell) => rowSum + codePointLength(cell.text), 0),
          block.table.caption ? codePointLength(block.table.caption.text) : 0,
        );
        outputDepth = Math.max(
          outputDepth,
          3 + Math.max(0, ...block.table.rows.flatMap((row) => row.map((cell) => cell.maxDepth))),
          block.table.caption ? 2 + block.table.caption.maxDepth : 0,
        );
        break;
    }
  }

  return { textCharacters, blocks: blockCount, maxTableColumns, outputDepth };
}

function richEligibilityReason(
  context: ParseContext,
  stats: StructuredHtmlStats,
): StructuredHtmlResult["richIneligibleReason"] {
  if (inputWasTruncated(context)) return "input_limit";
  if (stats.textCharacters > MAX_RICH_TEXT_CHARACTERS) return "text_limit";
  if (stats.blocks > MAX_RICH_BLOCKS) return "block_limit";
  if (stats.maxTableColumns > MAX_RICH_TABLE_COLUMNS) return "column_limit";
  if (stats.outputDepth > 16) return "depth_limit";
  return null;
}

function inputWasTruncated(context: ParseContext): boolean {
  return (
    context.sourceTruncated ||
    context.domTruncated ||
    context.nodeLimitExceeded ||
    context.depthLimitExceeded ||
    context.modelTruncated
  );
}

function blockHasLinks(block: StructuredBlock): boolean {
  switch (block.kind) {
    case "paragraph":
    case "heading":
    case "quote":
    case "footer":
      return block.content.hasLinks;
    case "list":
      return block.items.some((item) => item.hasLinks);
    case "table":
      return (
        Boolean(block.table.caption?.hasLinks) ||
        block.table.rows.some((row) => row.some((cell) => cell.hasLinks))
      );
    case "pre":
      return /(?:https?:\/\/|mailto:)\S+/iu.test(block.text);
    default:
      return false;
  }
}

function isBlockElement(name: string): boolean {
  return (
    BLOCK_CONTAINERS.has(name) || /^(?:h[1-6]|blockquote|footer|hr|ol|pre|table|ul)$/.test(name)
  );
}

function containsBlockChild(element: Element): boolean {
  return element.children.some((child) => isTag(child) && isBlockElement(child.name.toLowerCase()));
}

function directChildrenNamed(element: Element, name: string): Element[] {
  return element.children.filter(
    (child): child is Element => isTag(child) && child.name.toLowerCase() === name,
  );
}

function directTableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of table.children) {
    if (!isTag(child)) continue;
    const name = child.name.toLowerCase();
    if (name === "tr") rows.push(child);
    if (name === "thead" || name === "tbody" || name === "tfoot") {
      rows.push(...directChildrenNamed(child, "tr"));
    }
  }
  return rows;
}

function containsNestedTable(element: Element, context: ParseContext, depth: number): boolean {
  for (const child of element.children) {
    if (!enterNode(context, depth)) {
      if (context.nodeLimitExceeded) return false;
      continue;
    }
    if (!isTag(child)) continue;
    if (child.name.toLowerCase() === "table") return true;
    if (containsNestedTable(child, context, depth + 1)) return true;
  }
  return false;
}

function collectText(
  nodes: ChildNode[],
  context: ParseContext,
  depth: number,
  preserveWhitespace: boolean,
): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (!enterNode(context, depth)) {
      if (context.nodeLimitExceeded) break;
      continue;
    }
    if (isText(node)) {
      parts.push(node.data);
      continue;
    }
    if (!isTag(node)) continue;
    const name = node.name.toLowerCase();
    if (DROPPED_ELEMENTS.has(name)) continue;
    if (name === "br") {
      parts.push("\n");
      continue;
    }
    const nested = collectText(node.children, context, depth + 1, preserveWhitespace);
    if (nested) parts.push(isBlockElement(name) ? `\n${nested}\n` : nested);
  }
  const text = parts.join("").replace(/\r\n?/g, "\n");
  return preserveWhitespace ? text : normalizeInlineText(text, true);
}

function isEntireCellStrong(element: Element, context: ParseContext, depth: number): boolean {
  const pending = element.children.map((node) => ({
    node,
    depth,
    strong: resolveStrongState(false, element),
  }));
  let hasVisibleText = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (!enterNode(context, current.depth)) {
      return false;
    }
    if (isText(current.node)) {
      if (!current.node.data.trim()) continue;
      hasVisibleText = true;
      if (!current.strong) return false;
      continue;
    }
    if (!isTag(current.node)) continue;
    const name = current.node.name.toLowerCase();
    if (DROPPED_ELEMENTS.has(name)) continue;
    const strong = resolveStrongState(current.strong, current.node);
    for (const child of current.node.children) {
      pending.push({ node: child, depth: current.depth + 1, strong });
    }
  }
  return hasVisibleText;
}

function resolveStrongState(inherited: boolean, element: Element): boolean {
  const name = element.name.toLowerCase();
  let strong = inherited || name === "b" || name === "strong";
  const inlineWeight = lastFontWeight(element.attribs["style"]);
  if (inlineWeight === "bold") strong = true;
  if (inlineWeight === "normal") strong = false;
  return strong;
}

function lastFontWeight(style: string | undefined): "bold" | "normal" | null {
  let result: "bold" | "normal" | null = null;
  for (const declaration of (style ?? "").split(";")) {
    const match = declaration.match(/^\s*font-weight\s*:\s*([^!]+?)(?:\s*!important)?\s*$/iu);
    const value = match?.[1]?.trim().toLowerCase();
    if (!value) continue;
    if (value === "bold" || value === "bolder") {
      result = "bold";
      continue;
    }
    if (value === "normal" || value === "lighter") {
      result = "normal";
      continue;
    }
    if (/^\d{3,4}$/.test(value)) {
      const numeric = Number(value);
      if (numeric >= 600 && numeric <= 1000) result = "bold";
      else if (numeric >= 100 && numeric <= 500) result = "normal";
    }
  }
  return result;
}

function removeEmptyUnspannedColumns(rows: TableCell[][]): TableCell[][] {
  if (rows.some((row) => row.some((cell) => cell.colspan > 1 || cell.rowspan > 1))) return rows;
  const width = Math.max(0, ...rows.map((row) => row.length));
  const keep = Array.from({ length: width }, (_, index) => index).filter((index) =>
    rows.some((row) => Boolean(row[index]?.text)),
  );
  return rows.map((row) => keep.map((index) => row[index] ?? emptyTableCell()));
}

function isHeaderRow(firstRow: TableCell[], otherRows: TableCell[][]): boolean {
  if (firstRow.length === 0 || otherRows.length === 0) return false;
  if (firstRow.every((cell) => cell.isHeader)) return true;
  return firstRow.every((cell) => cell.isStrong && cell.text);
}

function countLeadingHeaderRows(rows: TableCell[][]): number {
  let count = 0;
  for (const row of rows) {
    if (!row.every((cell) => cell.isHeader)) break;
    count++;
  }
  return count;
}

function isKeyValueTable(rows: TableCell[][]): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => {
    if (row.length < 2 || row.length % 2 !== 0) return false;
    if (row.some((cell) => cell.colspan !== 1 || cell.rowspan !== 1)) return false;
    let completePairs = 0;
    for (let index = 0; index < row.length; index += 2) {
      const label = row[index];
      const value = row[index + 1];
      if (!label?.text || !value?.text) continue;
      if (!(label.isHeader || label.isStrong || looksLikeLabel(label.text))) return false;
      completePairs++;
    }
    return completePairs > 0;
  });
}

function looksLikeLabel(text: string): boolean {
  const value = text.trim();
  return value.length > 0 && value.length <= 64 && /\p{L}/u.test(value) && !/[\r\n]/.test(value);
}

function measureLogicalTableColumns(rows: TableCell[][]): number {
  return positionTableRows(rows).logicalColumns;
}

function positionTableRows(rows: TableCell[][]): {
  rows: PositionedTableCell[][];
  logicalColumns: number;
} {
  const occupiedUntilRow: number[] = [];
  const positionedRows: PositionedTableCell[][] = [];
  let maxColumns = 0;
  rows.forEach((row, rowIndex) => {
    const positioned: PositionedTableCell[] = [];
    let column = 0;
    for (const cell of row) {
      while ((occupiedUntilRow[column] ?? 0) > rowIndex) column++;
      while (
        Array.from({ length: cell.colspan }, (_, offset) => column + offset).some(
          (index) => (occupiedUntilRow[index] ?? 0) > rowIndex,
        )
      ) {
        column++;
      }
      for (let offset = 0; offset < cell.colspan; offset++) {
        occupiedUntilRow[column + offset] = Math.max(
          occupiedUntilRow[column + offset] ?? 0,
          rowIndex + cell.rowspan,
        );
      }
      positioned.push({ cell, column });
      column += cell.colspan;
      maxColumns = Math.max(maxColumns, column);
    }
    positionedRows.push(positioned);
  });
  return { rows: positionedRows, logicalColumns: maxColumns };
}

function expandHeaderCells(row: PositionedTableCell[]): Map<number, TableCell> {
  const headers = new Map<number, TableCell>();
  for (const { cell, column } of row) {
    for (let offset = 0; offset < cell.colspan; offset++) {
      headers.set(column + offset, cell);
    }
  }
  return headers;
}

function listItemPrefix(item: Element): string {
  const parent = item.parent;
  if (!parent || !isTag(parent) || parent.name.toLowerCase() !== "ol") return "• ";
  const explicitValue = safeListNumber(item.attribs["value"]);
  if (explicitValue !== null) return `${explicitValue}. `;
  const index = directChildrenNamed(parent, "li").indexOf(item);
  return `${boundedListStart(parent.attribs["start"]) + Math.max(index, 0)}. `;
}

function boundedListStart(raw: string | undefined): number {
  return safeListNumber(raw) ?? 1;
}

function safeListNumber(raw: string | undefined): number | null {
  if (!raw || !/^-?\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000 ? value : null;
}

function boundedSpan(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return 1;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 500 ? value : 1;
}

function safeAlign(raw: string | undefined): TableCell["align"] {
  const value = raw?.trim().toLowerCase();
  return value === "left" || value === "center" || value === "right" ? value : undefined;
}

function safeVAlign(raw: string | undefined): TableCell["valign"] {
  const value = raw?.trim().toLowerCase();
  return value === "top" || value === "middle" || value === "bottom" ? value : undefined;
}

function safeHref(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "mailto:"
    ) {
      return null;
    }
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname)
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeInlineText(value: string, trimBoundary: boolean): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return trimBoundary ? normalized.trim() : normalized;
}

function normalizeInlineClassicHtml(value: string, trimBoundary: boolean): string {
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return trimBoundary ? normalized.trim() : normalized;
}

function normalizeInlineRichHtml(value: string, trimBoundary: boolean): string {
  const normalized = value.replace(/(?:\s*<br>\s*){3,}/g, "<br><br>").replace(/ {2,}/g, " ");
  return trimBoundary ? normalized.trim() : normalized;
}

function enterNode(context: ParseContext, depth: number): boolean {
  if (depth > MAX_INPUT_DEPTH) {
    context.depthLimitExceeded = true;
    return false;
  }
  if (context.nodeLimitExceeded) return false;
  context.visitedNodes++;
  if (context.visitedNodes > MAX_VISITED_NODES) {
    context.nodeLimitExceeded = true;
    return false;
  }
  return true;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function inlineText(text: string): InlineContent {
  const escaped = escapeHtml(text);
  return {
    text,
    classicHtml: escaped,
    richHtml: escaped,
    hasLinks: false,
    maxDepth: 0,
    containsCode: false,
    containsAnchor: false,
  };
}

function emptyInline(): InlineContent {
  return inlineText("");
}

function emptyTableCell(): TableCell {
  return {
    ...emptyInline(),
    isHeader: false,
    isStrong: false,
    colspan: 1,
    rowspan: 1,
  };
}

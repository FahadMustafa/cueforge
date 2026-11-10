/**
 * Minimal, dependency-free XML parser for TTML/IMSC1 (spec §3 TTML).
 *
 * `src/core` is framework-free and bundle-budget-conscious, so rather than pull
 * in an XML library we parse the well-formed subset TTML uses: elements (with
 * namespaced tags/attributes), self-closing tags, text with the five predefined
 * entities plus numeric character references, comments, the XML declaration and
 * a DOCTYPE. Namespace prefixes are kept verbatim on tags and attribute names
 * (e.g. `ttp:frameRate`, `xml:lang`) — callers match on the local or prefixed
 * name as needed. Not a general XML engine: no namespace resolution, no CDATA,
 * no processing instructions beyond the declaration.
 */

/** A parsed XML element. Children are interleaved text nodes and elements. */
export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: Array<XmlElement | string>;
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.-]/;
const WS = /\s/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      // Reject out-of-range code points and lone surrogates (String.fromCodePoint
      // would throw a RangeError); keep the literal reference text instead.
      const valid =
        Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}

/** Recursive-descent cursor over the source string. */
class Cursor {
  constructor(
    private readonly src: string,
    public pos = 0,
  ) {}

  get done(): boolean {
    return this.pos >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  slice(start: number, end: number): string {
    return this.src.slice(start, end);
  }

  /** Advance past any whitespace. */
  skipWs(): void {
    while (!this.done && WS.test(this.peek())) this.pos++;
  }

  /** Advance past `<?xml ?>`, comments and `<!DOCTYPE>`; returns true if it consumed one. */
  skipProlog(): boolean {
    if (this.startsWith('<?')) {
      this.consumeUntil('?>');
      return true;
    }
    if (this.startsWith('<!--')) {
      this.consumeUntil('-->');
      return true;
    }
    if (this.startsWith('<!')) {
      this.consumeUntil('>');
      return true;
    }
    return false;
  }

  private consumeUntil(end: string): void {
    const idx = this.src.indexOf(end, this.pos);
    this.pos = idx < 0 ? this.src.length : idx + end.length;
  }

  readName(): string {
    const start = this.pos;
    if (!NAME_START.test(this.peek())) {
      throw new XmlError(`Expected element name at offset ${this.pos}.`);
    }
    this.pos++;
    while (!this.done && NAME_CHAR.test(this.peek())) this.pos++;
    return this.src.slice(start, this.pos);
  }

  readAttrValue(): string {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") {
      throw new XmlError(`Expected quoted attribute value at offset ${this.pos}.`);
    }
    this.pos++;
    const start = this.pos;
    const end = this.src.indexOf(quote, this.pos);
    if (end < 0) throw new XmlError('Unterminated attribute value.');
    this.pos = end + 1;
    return decodeEntities(this.src.slice(start, end));
  }
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

/** Nesting cap: deeper documents fail with a controlled XmlError, not a stack overflow. */
const MAX_DEPTH = 256;

function parseElement(cur: Cursor, depth: number): XmlElement {
  if (depth > MAX_DEPTH) {
    throw new XmlError(`Maximum element depth of ${MAX_DEPTH} exceeded.`);
  }
  // At '<'.
  cur.pos++; // consume '<'
  const tag = cur.readName();
  const attrs: Record<string, string> = {};

  for (;;) {
    cur.skipWs();
    const c = cur.peek();
    if (c === '/' && cur.peek(1) === '>') {
      cur.pos += 2;
      return { tag, attrs, children: [] };
    }
    if (c === '>') {
      cur.pos++;
      break;
    }
    if (cur.done) throw new XmlError(`Unclosed start tag <${tag}>.`);
    const name = cur.readName();
    cur.skipWs();
    if (cur.peek() !== '=') throw new XmlError(`Expected '=' after attribute "${name}".`);
    cur.pos++;
    cur.skipWs();
    attrs[name] = cur.readAttrValue();
  }

  const children = parseChildren(cur, tag, depth);
  return { tag, attrs, children };
}

function parseChildren(cur: Cursor, parentTag: string, depth: number): Array<XmlElement | string> {
  const children: Array<XmlElement | string> = [];
  for (;;) {
    if (cur.done) throw new XmlError(`Unexpected end of input inside <${parentTag}>.`);
    if (cur.startsWith('</')) {
      cur.pos += 2;
      const closeName = cur.readName();
      cur.skipWs();
      if (cur.peek() !== '>') throw new XmlError(`Malformed closing tag </${closeName}>.`);
      cur.pos++;
      if (closeName !== parentTag) {
        throw new XmlError(
          `Mismatched closing tag: expected </${parentTag}>, got </${closeName}>.`,
        );
      }
      return children;
    }
    if (cur.startsWith('<!--')) {
      cur.skipProlog();
      continue;
    }
    if (cur.peek() === '<') {
      children.push(parseElement(cur, depth + 1));
      continue;
    }
    // Text run up to the next '<'.
    const start = cur.pos;
    while (!cur.done && cur.peek() !== '<') cur.pos++;
    children.push(decodeEntities(cur.slice(start, cur.pos)));
  }
}

/** Escape text content for XML: `&`, `<`, `>`. Shared by the TTML serializers. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape an attribute value for a double-quoted XML attribute: `&`, `<`, `"`. */
export function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * Serialize an {@link XmlElement} tree back to XML. The inverse of {@link parseXml}
 * for the subset it produces: attribute insertion order and text nodes (including
 * significant whitespace) are preserved, so `parse → serialize → parse` round-trips.
 */
export function serializeXml(el: XmlElement): string {
  const attrs = Object.keys(el.attrs)
    .map((k) => ` ${k}="${escapeAttr(el.attrs[k]!)}"`)
    .join('');
  if (el.children.length === 0) return `<${el.tag}${attrs}/>`;
  const inner = el.children
    .map((c) => (typeof c === 'string' ? escapeText(c) : serializeXml(c)))
    .join('');
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}

/**
 * Parse an XML document and return its single root element.
 *
 * @throws {XmlError} on malformed input (missing/mismatched tags, bad attributes).
 */
export function parseXml(src: string): XmlElement {
  let text = src;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const cur = new Cursor(text);

  // Skip prolog: declaration, comments, doctype and inter-prolog whitespace.
  for (;;) {
    cur.skipWs();
    if (!cur.skipProlog()) break;
  }
  cur.skipWs();
  if (cur.peek() !== '<') throw new XmlError('No root element found.');
  return parseElement(cur, 1);
}

import {
  dropFrameTimecodeToMs
} from "./chunk-K32MESKF.mjs";
import {
  canonicalFps
} from "./chunk-GP4UVXBM.mjs";

// src/core/formats/ttml/xml.ts
var NAME_START = /[A-Za-z_:]/;
var NAME_CHAR = /[A-Za-z0-9_:.-]/;
var WS = /\s/;
var NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};
function decodeEntities(text) {
  return text.replace(/&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      const valid = Number.isInteger(code) && code > 0 && code <= 1114111 && (code < 55296 || code > 57343);
      return valid ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body];
    return named ?? whole;
  });
}
var Cursor = class {
  constructor(src, pos = 0) {
    this.src = src;
    this.pos = pos;
  }
  src;
  pos;
  get done() {
    return this.pos >= this.src.length;
  }
  peek(offset = 0) {
    return this.src[this.pos + offset] ?? "";
  }
  startsWith(s) {
    return this.src.startsWith(s, this.pos);
  }
  slice(start, end) {
    return this.src.slice(start, end);
  }
  /** Advance past any whitespace. */
  skipWs() {
    while (!this.done && WS.test(this.peek())) this.pos++;
  }
  /** Advance past `<?xml ?>`, comments and `<!DOCTYPE>`; returns true if it consumed one. */
  skipProlog() {
    if (this.startsWith("<?")) {
      this.consumeUntil("?>");
      return true;
    }
    if (this.startsWith("<!--")) {
      this.consumeUntil("-->");
      return true;
    }
    if (this.startsWith("<!")) {
      this.consumeUntil(">");
      return true;
    }
    return false;
  }
  consumeUntil(end) {
    const idx = this.src.indexOf(end, this.pos);
    this.pos = idx < 0 ? this.src.length : idx + end.length;
  }
  readName() {
    const start = this.pos;
    if (!NAME_START.test(this.peek())) {
      throw new XmlError(`Expected element name at offset ${this.pos}.`);
    }
    this.pos++;
    while (!this.done && NAME_CHAR.test(this.peek())) this.pos++;
    return this.src.slice(start, this.pos);
  }
  readAttrValue() {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'") {
      throw new XmlError(`Expected quoted attribute value at offset ${this.pos}.`);
    }
    this.pos++;
    const start = this.pos;
    const end = this.src.indexOf(quote, this.pos);
    if (end < 0) throw new XmlError("Unterminated attribute value.");
    this.pos = end + 1;
    return decodeEntities(this.src.slice(start, end));
  }
};
var XmlError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "XmlError";
  }
};
var MAX_DEPTH = 256;
function parseElement(cur, depth) {
  if (depth > MAX_DEPTH) {
    throw new XmlError(`Maximum element depth of ${MAX_DEPTH} exceeded.`);
  }
  cur.pos++;
  const tag = cur.readName();
  const attrs = {};
  for (; ; ) {
    cur.skipWs();
    const c = cur.peek();
    if (c === "/" && cur.peek(1) === ">") {
      cur.pos += 2;
      return { tag, attrs, children: [] };
    }
    if (c === ">") {
      cur.pos++;
      break;
    }
    if (cur.done) throw new XmlError(`Unclosed start tag <${tag}>.`);
    const name = cur.readName();
    cur.skipWs();
    if (cur.peek() !== "=") throw new XmlError(`Expected '=' after attribute "${name}".`);
    cur.pos++;
    cur.skipWs();
    attrs[name] = cur.readAttrValue();
  }
  const children = parseChildren(cur, tag, depth);
  return { tag, attrs, children };
}
function parseChildren(cur, parentTag, depth) {
  const children = [];
  for (; ; ) {
    if (cur.done) throw new XmlError(`Unexpected end of input inside <${parentTag}>.`);
    if (cur.startsWith("</")) {
      cur.pos += 2;
      const closeName = cur.readName();
      cur.skipWs();
      if (cur.peek() !== ">") throw new XmlError(`Malformed closing tag </${closeName}>.`);
      cur.pos++;
      if (closeName !== parentTag) {
        throw new XmlError(
          `Mismatched closing tag: expected </${parentTag}>, got </${closeName}>.`
        );
      }
      return children;
    }
    if (cur.startsWith("<!--")) {
      cur.skipProlog();
      continue;
    }
    if (cur.peek() === "<") {
      children.push(parseElement(cur, depth + 1));
      continue;
    }
    const start = cur.pos;
    while (!cur.done && cur.peek() !== "<") cur.pos++;
    children.push(decodeEntities(cur.slice(start, cur.pos)));
  }
}
function escapeText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
function serializeXml(el) {
  const attrs = Object.keys(el.attrs).map((k) => ` ${k}="${escapeAttr(el.attrs[k])}"`).join("");
  if (el.children.length === 0) return `<${el.tag}${attrs}/>`;
  const inner = el.children.map((c) => typeof c === "string" ? escapeText(c) : serializeXml(c)).join("");
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}
function parseXml(src) {
  let text = src;
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  const cur = new Cursor(text);
  for (; ; ) {
    cur.skipWs();
    if (!cur.skipProlog()) break;
  }
  cur.skipWs();
  if (cur.peek() !== "<") throw new XmlError("No root element found.");
  return parseElement(cur, 1);
}

// src/core/formats/ttml/ttml.ts
var TTML_DEFAULT_TICK_RATE = 1;
function local(name) {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}
function attrByLocal(el, localName) {
  for (const key of Object.keys(el.attrs)) {
    if (local(key) === localName) return el.attrs[key];
  }
  return void 0;
}
function child(el, localName) {
  for (const c of el.children) {
    if (typeof c !== "string" && local(c.tag) === localName) return c;
  }
  return void 0;
}
function xmlSpacePreserve(el, inherited) {
  const space = attrByLocal(el, "space");
  if (space === "preserve") return true;
  if (space === "default") return false;
  return inherited;
}
function paragraphs(el, inherited, out = []) {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    const preserve = xmlSpacePreserve(c, inherited);
    if (local(c.tag) === "p") out.push({ p: c, preserve });
    else paragraphs(c, preserve, out);
  }
  return out;
}
var CLOCK_RE = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+))?$/;
var OFFSET_RE = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/;
function parseTime(value, ctx) {
  const v = value.trim();
  const clock = CLOCK_RE.exec(v);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    const s = Number(clock[3]);
    if (clock[5] !== void 0) {
      const frames = Number(clock[5]);
      if (ctx.dropFrame) return dropFrameTimecodeToMs(h, m, s, frames);
      if (ctx.timeBase === "smpte") {
        const totalFrames = (h * 3600 + m * 60 + s) * ctx.nominalFrameRate + frames;
        return Math.round(totalFrames * 1e3 / ctx.frameRate);
      }
      return h * 36e5 + m * 6e4 + s * 1e3 + Math.round(frames / ctx.frameRate * 1e3);
    }
    let ms = h * 36e5 + m * 6e4 + s * 1e3;
    if (clock[4] !== void 0) {
      ms += Math.round(Number(`0.${clock[4]}`) * 1e3);
    }
    return ms;
  }
  const offset = OFFSET_RE.exec(v);
  if (offset) {
    const n = Number(offset[1]);
    switch (offset[2]) {
      case "h":
        return Math.round(n * 36e5);
      case "m":
        return Math.round(n * 6e4);
      case "s":
        return Math.round(n * 1e3);
      case "ms":
        return Math.round(n);
      case "f":
        return Math.round(n / ctx.frameRate * 1e3);
      case "t":
        return Math.round(n / ctx.tickRate * 1e3);
    }
  }
  return null;
}
var WRITING_MODE = {
  lrtb: void 0,
  rltb: void 0,
  lr: void 0,
  rl: void 0,
  tbrl: "vertical-rl",
  tb: "vertical-rl",
  tblr: "vertical-lr"
};
function applyStyle(span, el) {
  const fontStyle = attrByLocal(el, "fontStyle");
  const fontWeight = attrByLocal(el, "fontWeight");
  const decoration = attrByLocal(el, "textDecoration");
  const color = attrByLocal(el, "color");
  if (fontStyle === "italic" || fontStyle === "oblique") span.italic = true;
  if (fontWeight === "bold") span.bold = true;
  if (decoration !== void 0 && /underline/.test(decoration)) span.underline = true;
  if (color !== void 0) span.color = color;
}
function trimLine(runs) {
  while (runs.length > 0) {
    const first = runs[0];
    if (first.preserved) break;
    first.span.text = first.span.text.replace(/^ +/, "");
    if (first.span.text !== "") break;
    runs.shift();
  }
  while (runs.length > 0) {
    const last = runs[runs.length - 1];
    if (last.preserved) break;
    last.span.text = last.span.text.replace(/ +$/, "");
    if (last.span.text !== "") break;
    runs.pop();
  }
  return runs.map((r) => r.span);
}
function parseLines(p, inheritedPreserve) {
  const lines = [[]];
  function pushText(text, style, preserved) {
    if (text === "") return;
    const span = { text };
    if (style.italic) span.italic = true;
    if (style.bold) span.bold = true;
    if (style.underline) span.underline = true;
    if (style.color !== void 0) span.color = style.color;
    lines[lines.length - 1].push({ span, preserved });
  }
  function walk(node, inherited, preserve) {
    for (const c of node.children) {
      if (typeof c === "string") {
        pushText(preserve ? c : c.replace(/[ \t\r\n]+/g, " "), inherited, preserve);
        continue;
      }
      const tag = local(c.tag);
      if (tag === "br") {
        lines.push([]);
        continue;
      }
      const merged = { ...inherited, text: "" };
      applyStyle(merged, c);
      walk(c, merged, xmlSpacePreserve(c, preserve));
    }
  }
  walk(p, { text: "" }, inheritedPreserve);
  return lines.map((runs) => ({ spans: trimLine(runs) }));
}
var TEXT_ALIGN = {
  left: "left",
  start: "start",
  center: "center",
  centre: "center",
  right: "right",
  end: "end"
};
function parsePosition(p) {
  const pos = {};
  const wm = attrByLocal(p, "writingMode");
  if (wm !== void 0) {
    const vertical = WRITING_MODE[wm];
    if (vertical !== void 0) pos.vertical = vertical;
  }
  const ta = attrByLocal(p, "textAlign");
  if (ta !== void 0) {
    const align = TEXT_ALIGN[ta.trim().toLowerCase()];
    if (align !== void 0) pos.align = align;
  }
  return Object.keys(pos).length > 0 ? pos : void 0;
}
function parseTtml(text) {
  const warnings = [];
  let tt;
  try {
    tt = parseXml(text);
  } catch (e) {
    const message = e instanceof XmlError ? e.message : String(e);
    warnings.push({ code: "unexpected-content", message: `Malformed TTML XML: ${message}` });
    return { cues: [], metadata: { sourceFormat: "ttml" }, warnings };
  }
  if (local(tt.tag) !== "tt") {
    warnings.push({
      code: "unexpected-content",
      message: `Root element is <${tt.tag}>, not <tt>.`
    });
    return { cues: [], metadata: { sourceFormat: "ttml" }, warnings };
  }
  const declaredRate = attrByLocal(tt, "frameRate");
  const multiplier = attrByLocal(tt, "frameRateMultiplier");
  const tickRateAttr = attrByLocal(tt, "tickRate");
  let frameRate = declaredRate !== void 0 ? Number(declaredRate) : 30;
  if (multiplier !== void 0) {
    const parts = multiplier.trim().split(/\s+/).map(Number);
    if (parts.length === 2 && parts[1] !== 0) frameRate = frameRate * parts[0] / parts[1];
  }
  const tickRate = tickRateAttr !== void 0 ? Number(tickRateAttr) : declaredRate !== void 0 ? frameRate : TTML_DEFAULT_TICK_RATE;
  const dropModeAttr = attrByLocal(tt, "dropMode");
  const dropFrame = dropModeAttr === "dropNTSC";
  const timeBase = attrByLocal(tt, "timeBase") ?? "media";
  const nominalFrameRate = Math.round(frameRate);
  const ctx = { frameRate, nominalFrameRate, tickRate, dropFrame, timeBase };
  const language = attrByLocal(tt, "lang");
  const head = child(tt, "head");
  const body = child(tt, "body");
  const cues = [];
  if (body) {
    const bodyPreserve = xmlSpacePreserve(body, xmlSpacePreserve(tt, false));
    for (const { p, preserve } of paragraphs(body, bodyPreserve)) {
      const begin = attrByLocal(p, "begin");
      const end = attrByLocal(p, "end");
      const dur = attrByLocal(p, "dur");
      const startMs = begin !== void 0 ? parseTime(begin, ctx) : null;
      let endMs = end !== void 0 ? parseTime(end, ctx) : null;
      if (endMs === null && startMs !== null && dur !== void 0) {
        const d = parseTime(dur, ctx);
        if (d !== null) endMs = startMs + d;
      }
      if (startMs === null || endMs === null) {
        warnings.push({
          code: "malformed-timing",
          message: `<p> missing or invalid begin/end timing.`,
          cueIndex: cues.length + 1
        });
        continue;
      }
      const index = cues.length + 1;
      const lines = parseLines(p, preserve);
      const style = attrByLocal(p, "style");
      const region = attrByLocal(p, "region");
      const id = attrByLocal(p, "id");
      const position = parsePosition(p);
      const cue = { index, startMs, endMs, lines };
      if (style !== void 0) cue.styleRefs = style.trim().split(/\s+/);
      if (id !== void 0) cue.id = id;
      if (position) cue.position = position;
      if (region !== void 0) cue.raw = { region };
      if (lines.every((l) => l.spans.every((s) => s.text === ""))) {
        warnings.push({ code: "empty-cue", message: "Cue has no text.", cueIndex: index });
      }
      if (endMs < startMs) {
        warnings.push({
          code: "reversed-timing",
          message: "Cue end precedes start.",
          cueIndex: index
        });
      }
      cues.push(cue);
    }
  }
  for (let k = 1; k < cues.length; k++) {
    if (cues[k].startMs < cues[k - 1].endMs) {
      warnings.push({
        code: "overlap",
        message: `Cue ${cues[k].index} overlaps the previous cue.`,
        cueIndex: cues[k].index
      });
    }
  }
  const raw = { ttAttrs: { ...tt.attrs } };
  if (head) raw.head = head;
  if (dropModeAttr !== void 0) raw.dropFrame = dropFrame;
  const metadata = { sourceFormat: "ttml", raw };
  if (declaredRate !== void 0 || multiplier !== void 0)
    metadata.frameRate = canonicalFps(frameRate);
  if (language !== void 0) metadata.language = language;
  return { cues, metadata, warnings };
}
var NL = "\n";
var DEFAULT_TT_ATTRS = {
  xmlns: "http://www.w3.org/ns/ttml",
  "xmlns:ttp": "http://www.w3.org/ns/ttml#parameter",
  "xmlns:tts": "http://www.w3.org/ns/ttml#styling"
};
var VERTICAL_TO_WRITING_MODE = {
  horizontal: void 0,
  "vertical-rl": "tbrl",
  "vertical-lr": "tblr"
};
function pad(n, w) {
  return String(n).padStart(w, "0");
}
function formatClock(ms) {
  const h = Math.floor(ms / 36e5);
  const m = Math.floor(ms / 6e4) % 60;
  const s = Math.floor(ms / 1e3) % 60;
  const millis = ms % 1e3;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(millis, 3)}`;
}
function serializeSpan(span) {
  if (span.opaque !== void 0) {
    return escapeText(span.text);
  }
  const attrs = [];
  if (span.italic) attrs.push('tts:fontStyle="italic"');
  if (span.bold) attrs.push('tts:fontWeight="bold"');
  if (span.underline) attrs.push('tts:textDecoration="underline"');
  if (span.color !== void 0) attrs.push(`tts:color="${escapeAttr(span.color)}"`);
  const text = escapeText(span.text);
  if (attrs.length === 0) return text;
  return `<span ${attrs.join(" ")}>${text}</span>`;
}
function serializeContent(lines) {
  return lines.map((line) => line.spans.map(serializeSpan).join("")).join("<br/>");
}
function serializeTtml(doc) {
  return serializeTtmlProfile(doc, { defaultTtAttrs: DEFAULT_TT_ATTRS });
}
var PROFILE_TIMING_KEYS = [
  "ttp:timeBase",
  "ttp:frameRate",
  "ttp:frameRateMultiplier",
  "ttp:dropMode",
  "ttp:profile",
  "ttp:contentProfiles"
];
function serializeTtmlProfile(doc, options) {
  const raw = doc.metadata.raw ?? {};
  const base = { ...options.defaultTtAttrs, ...raw.ttAttrs };
  if (options.overrideTtAttrs) {
    for (const key of PROFILE_TIMING_KEYS) delete base[key];
  }
  const ttAttrs = { ...base, ...options.overrideTtAttrs };
  const formatTime = options.formatTime ?? formatClock;
  const ttAttrStr = Object.keys(ttAttrs).map((k) => `${k}="${escapeAttr(ttAttrs[k])}"`).join(" ");
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(`<tt ${ttAttrStr}>`);
  if (options.head !== void 0) out.push(options.head);
  else if (raw.head) out.push("  " + serializeXml(raw.head));
  out.push("  <body>");
  out.push("    <div>");
  for (const cue of doc.cues) {
    const attrs = [
      `begin="${formatTime(cue.startMs)}"`,
      `end="${formatTime(cue.endMs)}"`
    ];
    const styleRefs = options.forceStyle !== void 0 ? [options.forceStyle] : cue.styleRefs;
    if (styleRefs && styleRefs.length > 0) {
      attrs.push(`style="${escapeAttr(styleRefs.join(" "))}"`);
    }
    const region = options.forceRegion ?? cue.raw?.region;
    if (region !== void 0) attrs.push(`region="${escapeAttr(region)}"`);
    if (cue.id !== void 0) attrs.push(`xml:id="${escapeAttr(cue.id)}"`);
    const vertical = cue.position?.vertical;
    const wm = vertical ? VERTICAL_TO_WRITING_MODE[vertical] : void 0;
    if (wm !== void 0) attrs.push(`tts:writingMode="${wm}"`);
    if (cue.position?.align !== void 0) {
      attrs.push(`tts:textAlign="${cue.position.align}"`);
    }
    const renderContent = options.serializeContent ?? serializeContent;
    out.push(`      <p ${attrs.join(" ")}>${renderContent(cue.lines)}</p>`);
  }
  out.push("    </div>");
  out.push("  </body>");
  out.push("</tt>");
  return out.join(NL) + NL;
}

export {
  XmlError,
  escapeText,
  escapeAttr,
  serializeXml,
  parseXml,
  parseTtml,
  serializeTtml,
  serializeTtmlProfile
};

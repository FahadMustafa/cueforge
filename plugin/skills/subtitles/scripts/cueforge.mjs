import {
  DROP_FRAME_FPS,
  durationFrames,
  isDropFrameFamily,
  msToTimecode,
  supportsDropFrame
} from "./chunks/chunk-K32MESKF.mjs";
import {
  shiftCues
} from "./chunks/chunk-GP4UVXBM.mjs";
import "./chunks/chunk-RCR4PM7R.mjs";

// src/cli/cli.ts
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";

// src/core/encoding/decode.ts
var HEURISTIC_SAMPLE = 1024;
function detectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    return { encoding: "utf-8", hadBom: true, bomLength: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) {
    return { encoding: "utf-16le", hadBom: true, bomLength: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) {
    return { encoding: "utf-16be", hadBom: true, bomLength: 2 };
  }
  const n = Math.min(bytes.length, HEURISTIC_SAMPLE);
  const pairs = Math.floor(n / 2);
  if (pairs >= 1) {
    let evenLow = 0;
    let oddLow = 0;
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i + 1 < n; i += 2) {
      if (bytes[i] < 48) evenLow++;
      if (bytes[i] === 0) evenZero++;
      if (bytes[i + 1] < 48) oddLow++;
      if (bytes[i + 1] === 0) oddZero++;
    }
    const evenLowRatio = evenLow / pairs;
    const oddLowRatio = oddLow / pairs;
    const evenZeroRatio = evenZero / pairs;
    const oddZeroRatio = oddZero / pairs;
    const HIGH = 0.6;
    const MARGIN = 0.25;
    if ((oddZeroRatio > 0.3 || oddLowRatio >= HIGH) && oddLowRatio > evenLowRatio + MARGIN) {
      return { encoding: "utf-16le", hadBom: false, bomLength: 0 };
    }
    if ((evenZeroRatio > 0.3 || evenLowRatio >= HIGH) && evenLowRatio > oddLowRatio + MARGIN) {
      return { encoding: "utf-16be", hadBom: false, bomLength: 0 };
    }
  }
  return { encoding: "utf-8", hadBom: false, bomLength: 0 };
}
function detectNewline(text) {
  const crlf = /\r\n/.test(text);
  const loneLf = /(^|[^\r])\n/.test(text);
  if (crlf && loneLf) return "mixed";
  if (crlf) return "crlf";
  if (loneLf) return "lf";
  return "none";
}
function looksMojibake(text) {
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 65533) bad++;
  }
  return bad > 4 || bad > 0 && bad / text.length > 0.02;
}
var ARABIC_SHARE_MIN = 0.5;
function decodeLegacy(body) {
  let high = 0;
  let upper = 0;
  for (const b of body) {
    if (b >= 128) high++;
    if (b >= 192) upper++;
  }
  const cp1256 = new TextDecoder("windows-1256").decode(body);
  let arabic = 0;
  for (let i = 0; i < cp1256.length; i++) {
    const c = cp1256.charCodeAt(i);
    if (c >= 1536 && c <= 1791) arabic++;
  }
  const isArabic = upper / high >= 0.5 && arabic / high > ARABIC_SHARE_MIN;
  const encoding = isArabic ? "windows-1256" : "windows-1252";
  const text = isArabic ? cp1256 : new TextDecoder("windows-1252").decode(body);
  return {
    text,
    encoding,
    warning: `Input is not valid UTF-8; assumed legacy code page ${encoding}.`
  };
}
function decode(bytes) {
  const { encoding, hadBom, bomLength } = detectEncoding(bytes);
  const body = bomLength > 0 ? bytes.subarray(bomLength) : bytes;
  const decoder = new TextDecoder(encoding, { ignoreBOM: true, fatal: false });
  let text = decoder.decode(body);
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  if (encoding === "utf-8" && !hadBom && looksMojibake(text)) {
    const legacy = decodeLegacy(body);
    return { ...legacy, hadBom: false, newline: detectNewline(legacy.text) };
  }
  return { text, encoding, hadBom, newline: detectNewline(text) };
}

// src/core/formats/charset.ts
var MAX_SAMPLES = 3;
function checkCharset(doc, canEncode) {
  let total = 0;
  let unrepresentable = 0;
  const samples = [];
  for (const cue of doc.cues) {
    for (const line of cue.lines) {
      for (const span of line.spans) {
        for (const ch of span.text) {
          if (/\s/.test(ch)) continue;
          total++;
          if (canEncode(ch)) continue;
          unrepresentable++;
          if (samples.length < MAX_SAMPLES && !samples.includes(ch)) samples.push(ch);
        }
      }
    }
  }
  return { total, unrepresentable, samples, share: total === 0 ? 0 : unrepresentable / total };
}

// src/core/model/timecode.ts
function splitMs(totalMs) {
  if (totalMs < 0) throw new RangeError(`splitMs: negative input ${totalMs}`);
  const t = Math.floor(totalMs);
  return {
    hours: Math.floor(t / 36e5),
    minutes: Math.floor(t / 6e4) % 60,
    seconds: Math.floor(t / 1e3) % 60,
    millis: t % 1e3
  };
}
function joinMs(components) {
  const { hours, minutes, seconds, millis } = components;
  return hours * 36e5 + minutes * 6e4 + seconds * 1e3 + millis;
}

// src/core/formats/inline.ts
var BLANK_LINE = "\u200B";
function serializeCueLines(lines, opts = {}) {
  return lines.map((l) => {
    const text = serializeInline(l.spans, opts);
    return text === "" ? BLANK_LINE : text;
  });
}
var TAG_RE = /<(\/?)(i|b|u|font|v)\b([^>]*)>/gi;
var VTT_TOKEN_RE = /<(\/?)(i|b|u|font|v)\b([^>]*)>|<\/?(?:ruby|rt|c|lang)(?:[.\t ][^>]*)?>|<(?:\d+:)?\d{2}:\d{2}\.\d{3}>|&(amp|lt|gt|lrm|rlm|nbsp);/gi;
var COLOR_RE = /color\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i;
var VTT_ENTITY = {
  amp: "&",
  lt: "<",
  gt: ">",
  lrm: "\u200E",
  rlm: "\u200F",
  nbsp: "\xA0"
};
function escapeVttText(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\u200E/g, "&lrm;").replace(/\u200F/g, "&rlm;");
}
function vttColorClass(color) {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hex) return `color-${hex[1]}`;
  const cls = color.replace(/[^\w-]/g, "");
  return cls === "" ? "color" : cls;
}
function styleOf(s) {
  const style = {};
  if (s.italic > 0) style.italic = true;
  if (s.bold > 0) style.bold = true;
  if (s.underline > 0) style.underline = true;
  for (let i = s.colorStack.length - 1; i >= 0; i--) {
    const c = s.colorStack[i];
    if (c !== void 0) {
      style.color = c;
      break;
    }
  }
  if (s.voiceStack.length > 0) style.voice = s.voiceStack[s.voiceStack.length - 1];
  return style;
}
function voiceName(attrs) {
  return attrs.startsWith(" ") ? attrs.slice(1) : attrs;
}
function parseInline(text, opts = {}) {
  const spans = [];
  const warnings = [];
  const s = { italic: 0, bold: 0, underline: 0, colorStack: [], voiceStack: [] };
  const re = opts.vtt === true ? VTT_TOKEN_RE : TAG_RE;
  let buf = "";
  let pendingOpaque = "";
  const flush = () => {
    if (buf === "") return;
    const span = { text: buf, ...styleOf(s) };
    if (pendingOpaque !== "") span.opaque = pendingOpaque;
    spans.push(span);
    buf = "";
    pendingOpaque = "";
  };
  const close = (tag, ok) => {
    if (!ok) warnings.push({ code: "stray-close-tag", tag });
  };
  re.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    buf += text.slice(last, m.index);
    last = re.lastIndex;
    if (m[2] === void 0) {
      if (m[4] !== void 0) buf += VTT_ENTITY[m[4].toLowerCase()];
      else {
        flush();
        pendingOpaque += m[0];
      }
      continue;
    }
    flush();
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    switch (tag) {
      case "i":
        if (closing) close(tag, s.italic-- > 0);
        else s.italic++;
        break;
      case "b":
        if (closing) close(tag, s.bold-- > 0);
        else s.bold++;
        break;
      case "u":
        if (closing) close(tag, s.underline-- > 0);
        else s.underline++;
        break;
      case "font":
        if (closing) {
          if (s.colorStack.length > 0) s.colorStack.pop();
          else close(tag, false);
        } else {
          const cm = COLOR_RE.exec(attrs);
          s.colorStack.push(cm ? cm[2] ?? cm[3] ?? cm[4] : void 0);
        }
        break;
      default:
        if (closing) {
          if (s.voiceStack.length > 0) s.voiceStack.pop();
          else close(tag, false);
        } else {
          s.voiceStack.push(voiceName(attrs));
        }
    }
    if (s.italic < 0) s.italic = 0;
    if (s.bold < 0) s.bold = 0;
    if (s.underline < 0) s.underline = 0;
  }
  buf += text.slice(last);
  if (buf === "" && pendingOpaque !== "") {
    spans.push({ text: "", ...styleOf(s), opaque: pendingOpaque });
  } else {
    flush();
  }
  for (let i = 0; i < s.italic; i++) warnings.push({ code: "unclosed-tag", tag: "i" });
  for (let i = 0; i < s.bold; i++) warnings.push({ code: "unclosed-tag", tag: "b" });
  for (let i = 0; i < s.underline; i++) warnings.push({ code: "unclosed-tag", tag: "u" });
  for (let i = 0; i < s.colorStack.length; i++)
    warnings.push({ code: "unclosed-tag", tag: "font" });
  return { spans, warnings };
}
function serializeInline(spans, opts = {}) {
  const vtt = opts.vtt === true;
  let out = "";
  for (const span of spans) {
    if (vtt && span.opaque !== void 0) out += span.opaque;
    const openers = [];
    const closers = [];
    if (span.voice !== void 0) {
      const name = span.voice;
      const sep = name === "" || name.startsWith(".") ? "" : " ";
      openers.push(`<v${sep}${name}>`);
      closers.unshift("</v>");
    }
    if (span.color !== void 0) {
      openers.push(vtt ? `<c.${vttColorClass(span.color)}>` : `<font color="${span.color}">`);
      closers.unshift(vtt ? "</c>" : "</font>");
    }
    if (span.bold) {
      openers.push("<b>");
      closers.unshift("</b>");
    }
    if (span.italic) {
      openers.push("<i>");
      closers.unshift("</i>");
    }
    if (span.underline) {
      openers.push("<u>");
      closers.unshift("</u>");
    }
    out += openers.join("") + (vtt ? escapeVttText(span.text) : span.text) + closers.join("");
  }
  return out;
}
function splitSpansIntoLines(spans) {
  const lines = [{ spans: [] }];
  for (const span of spans) {
    const parts = span.text.split("\n");
    parts.forEach((part, k) => {
      if (k > 0) lines.push({ spans: [] });
      const opaque = k === 0 ? span.opaque : void 0;
      if (part === "" && opaque === void 0) return;
      const out = { ...span, text: part };
      if (opaque === void 0) delete out.opaque;
      lines[lines.length - 1].spans.push(out);
    });
  }
  return lines;
}
function isBlankLineSentinel(line) {
  return line.spans.length === 1 && line.spans[0].text === BLANK_LINE;
}
function parseStyledLines(block, opts = {}) {
  const { spans, warnings } = parseInline(block, opts);
  const lines = splitSpansIntoLines(spans).map((l) => isBlankLineSentinel(l) ? { spans: [] } : l);
  return { lines, warnings };
}
function serializeStyledLines(lines, opts = {}) {
  return lines.map((l) => serializeInline(l.spans, opts)).join("\n");
}

// src/core/formats/srt/srt.ts
var NL = "\r\n";
var TIMING = /^\s*(?:(\d{1,9}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,9}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})(.*)$/;
var AN_TAG = /^\{\\an([1-9])\}/;
function srtAlignment(cue) {
  const an = cue.raw?.an;
  return typeof an === "number" ? an : void 0;
}
function positionFromAlignment(an) {
  const col = (an - 1) % 3;
  const row = Math.floor((an - 1) / 3);
  const pos = { align: col === 0 ? "left" : col === 1 ? "center" : "right" };
  if (row === 1) {
    pos.line = 50;
    pos.linePercent = true;
  } else if (row === 2) pos.line = 0;
  return pos;
}
function tcToMs(h, m, s, ms) {
  const hours = Number(h ?? 0);
  return {
    // A 1–2 digit fraction is a fraction of a second, not literal ms: ",5" = 500.
    ms: joinMs({
      hours,
      minutes: Number(m),
      seconds: Number(s),
      millis: Number(ms.padEnd(3, "0"))
    }),
    hourOverflow: hours > 99
  };
}
function pad(n, width) {
  return String(n).padStart(width, "0");
}
function formatTc(ms) {
  const { hours, minutes, seconds, millis } = splitMs(ms);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}
function parseSrt(text) {
  let src = text;
  if (src.charCodeAt(0) === 65279) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const cues = [];
  const warnings = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;
    const startLine = i + 1;
    let index;
    const cur = lines[i];
    const hasTimingNext = i + 1 < lines.length && lines[i + 1].includes("-->");
    if (/^\d+$/.test(cur.trim()) && hasTimingNext) {
      index = Number(cur.trim());
      i++;
    }
    const timingLine = lines[i];
    if (timingLine === void 0 || !timingLine.includes("-->")) {
      warnings.push({
        code: "unexpected-content",
        message: `Expected a timing line near source line ${startLine}.`,
        sourceLine: startLine
      });
      i++;
      continue;
    }
    const m = TIMING.exec(timingLine);
    if (!m) {
      warnings.push({
        code: "malformed-timing",
        message: `Could not parse timing: "${timingLine.trim()}".`,
        sourceLine: i + 1
      });
      i++;
      continue;
    }
    i++;
    if (index === void 0) {
      index = cues.length + 1;
      warnings.push({
        code: "missing-index",
        message: `Missing cue index; assigned ${index}.`,
        cueIndex: index,
        sourceLine: startLine
      });
    }
    const start = tcToMs(m[1], m[2], m[3], m[4]);
    const end = tcToMs(m[5], m[6], m[7], m[8]);
    if (start.hourOverflow || end.hourOverflow) {
      warnings.push({
        code: "hour-overflow",
        message: "Hour field exceeds 99.",
        cueIndex: index,
        sourceLine: startLine
      });
    }
    const trailer = (m[9] ?? "").replace(/\s+$/, "");
    const textLines = [];
    let firstAbsorbedBlank;
    while (i < lines.length) {
      if (lines[i].trim() === "") {
        let j = i;
        while (j < lines.length && lines[j].trim() === "") j++;
        const next = lines[j];
        if (next === void 0 || next.includes("-->") || /^\d+$/.test(next.trim()) && lines[j + 1]?.includes("-->"))
          break;
        if (textLines.length > 0) {
          firstAbsorbedBlank ??= i + 1;
          while (i < j) {
            textLines.push("");
            i++;
          }
        }
        i = j;
        continue;
      }
      textLines.push(lines[i]);
      i++;
    }
    if (firstAbsorbedBlank !== void 0) {
      warnings.push({
        code: "blank-line-in-cue",
        message: `Cue ${index} contains a blank line; the text after it was kept as part of the cue.`,
        cueIndex: index,
        sourceLine: firstAbsorbedBlank
      });
    }
    let block = textLines.join("\n");
    const anTag = AN_TAG.exec(block);
    if (anTag) block = block.slice(anTag[0].length);
    const cue = { index, startMs: start.ms, endMs: end.ms, lines: [] };
    if (block === "") {
      warnings.push({
        code: "empty-cue",
        message: "Cue has no text.",
        cueIndex: index,
        sourceLine: startLine
      });
    } else {
      const parsed = parseStyledLines(block);
      cue.lines = parsed.lines;
      for (const w of parsed.warnings) {
        warnings.push({
          code: w.code,
          message: `${w.code}: <${w.tag}>`,
          cueIndex: index,
          sourceLine: startLine
        });
      }
    }
    const raw = {};
    if (trailer.trim() !== "") raw.trailer = trailer;
    if (anTag) raw.an = Number(anTag[1]);
    if (raw.trailer !== void 0 || raw.an !== void 0) cue.raw = raw;
    if (end.ms < start.ms) {
      warnings.push({
        code: "reversed-timing",
        message: "Cue end precedes start.",
        cueIndex: index,
        sourceLine: startLine
      });
    }
    cues.push(cue);
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
  return { cues, metadata: { sourceFormat: "srt" }, warnings };
}
function serializeSrt(doc) {
  let out = "";
  for (const cue of doc.cues) {
    const trailer = cue.raw && typeof cue.raw === "object" && "trailer" in cue.raw ? String(cue.raw.trailer) : "";
    out += `${cue.index}${NL}`;
    out += `${formatTc(cue.startMs)} --> ${formatTc(cue.endMs)}${trailer}${NL}`;
    const textLines = serializeCueLines(cue.lines);
    const an = srtAlignment(cue);
    if (an !== void 0) textLines[0] = `{\\an${an}}${textLines[0] ?? ""}`;
    if (textLines.length > 0) out += textLines.join(NL) + NL;
    out += NL;
  }
  return out;
}

// src/core/formats/vtt/vtt.ts
var NL2 = "\n";
var ALIGNS = ["start", "center", "end", "left", "right"];
function parseVttTc(token) {
  let m = /^(\d+):([0-5]?\d):([0-5]?\d)\.(\d{1,3})$/.exec(token);
  if (m) {
    return joinMs({
      hours: +m[1],
      minutes: +m[2],
      seconds: +m[3],
      millis: +m[4].padEnd(3, "0")
    });
  }
  m = /^([0-5]?\d):([0-5]?\d)\.(\d{1,3})$/.exec(token);
  if (m) {
    return joinMs({ hours: 0, minutes: +m[1], seconds: +m[2], millis: +m[3].padEnd(3, "0") });
  }
  return null;
}
function pad2(n, w) {
  return String(n).padStart(w, "0");
}
function formatVttTc(ms) {
  const { hours, minutes, seconds, millis } = splitMs(ms);
  return `${pad2(hours, 2)}:${pad2(minutes, 2)}:${pad2(seconds, 2)}.${pad2(millis, 3)}`;
}
function parseSettings(raw) {
  const settings = raw.trim();
  if (settings === "") return void 0;
  const pos = { raw: settings };
  for (const tok of settings.split(/\s+/)) {
    const ci = tok.indexOf(":");
    if (ci < 0) continue;
    const key = tok.slice(0, ci);
    const value = tok.slice(ci + 1);
    switch (key) {
      case "vertical":
        if (value === "rl") pos.vertical = "vertical-rl";
        else if (value === "lr") pos.vertical = "vertical-lr";
        break;
      case "line": {
        const mm = /^(-?\d+(?:\.\d+)?)(%?)/.exec(value);
        if (mm) {
          pos.line = Number(mm[1]);
          if (mm[2] === "%") pos.linePercent = true;
        }
        break;
      }
      case "position": {
        const mm = /^(\d+(?:\.\d+)?)%?/.exec(value);
        if (mm) pos.position = Number(mm[1]);
        break;
      }
      case "size": {
        const mm = /^(\d+(?:\.\d+)?)%?/.exec(value);
        if (mm) pos.size = Number(mm[1]);
        break;
      }
      case "align":
        if (ALIGNS.includes(value)) pos.align = value;
        break;
      default:
        break;
    }
  }
  return pos;
}
function parseVtt(text) {
  let src = text;
  if (src.charCodeAt(0) === 65279) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const warnings = [];
  const raw = { header: "", notes: [], styles: [], regions: [] };
  let firstBlank = lines.findIndex((l) => l.trim() === "");
  if (firstBlank === -1) firstBlank = lines.length;
  raw.header = lines.slice(0, firstBlank).join(NL2);
  const rest = lines.slice(firstBlank + 1);
  if (!/^WEBVTT([ \t]|$)/.test(lines[0] ?? "")) {
    warnings.push({
      code: "missing-signature",
      message: 'File does not begin with the "WEBVTT" signature.',
      sourceLine: 1
    });
  }
  const blocks = [];
  let cur = [];
  for (const line of rest) {
    if (line.trim() === "") {
      if (cur.length > 0) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) blocks.push(cur);
  const cues = [];
  for (const block of blocks) {
    const head = block[0];
    const joined = block.join(NL2);
    if (/^NOTE(\s|$)/.test(head)) {
      raw.notes.push(joined);
      continue;
    }
    if (/^STYLE(\s|$)/.test(head)) {
      raw.styles.push(joined);
      continue;
    }
    if (/^REGION(\s|$)/.test(head)) {
      raw.regions.push(joined);
      continue;
    }
    const timingIdx = block.findIndex((l) => l.includes("-->"));
    if (timingIdx === -1) {
      warnings.push({ code: "unexpected-content", message: `Block is not a cue: "${head}".` });
      continue;
    }
    const timingLine = block[timingIdx];
    const tm = /^(\S+)\s*-->\s*(\S+)(?:\s+(.*))?$/.exec(timingLine);
    const startMs = tm ? parseVttTc(tm[1]) : null;
    const endMs = tm ? parseVttTc(tm[2]) : null;
    if (tm === null || startMs === null || endMs === null) {
      warnings.push({ code: "malformed-timing", message: `Bad timing: "${timingLine}".` });
      continue;
    }
    const index = cues.length + 1;
    const cue = { index, startMs, endMs, lines: [] };
    if (timingIdx > 0) cue.id = block.slice(0, timingIdx).join(NL2);
    const position = parseSettings(tm[3] ?? "");
    if (position) cue.position = position;
    const textBlock = block.slice(timingIdx + 1).join(NL2);
    if (textBlock === "") {
      warnings.push({ code: "empty-cue", message: "Cue has no text.", cueIndex: index });
    } else {
      const parsed = parseStyledLines(textBlock, { vtt: true });
      cue.lines = parsed.lines;
      for (const w of parsed.warnings) {
        warnings.push({ code: w.code, message: `${w.code}: <${w.tag}>`, cueIndex: index });
      }
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
  for (let k = 1; k < cues.length; k++) {
    if (cues[k].startMs < cues[k - 1].endMs) {
      warnings.push({
        code: "overlap",
        message: `Cue ${cues[k].index} overlaps the previous cue.`,
        cueIndex: cues[k].index
      });
    }
  }
  return { cues, metadata: { sourceFormat: "vtt", raw: { ...raw } }, warnings };
}
function settingsFromPosition(pos) {
  const toks = [];
  if (pos.vertical === "vertical-rl") toks.push("vertical:rl");
  else if (pos.vertical === "vertical-lr") toks.push("vertical:lr");
  if (pos.line !== void 0) toks.push(`line:${pos.line}${pos.linePercent ? "%" : ""}`);
  if (pos.position !== void 0) toks.push(`position:${pos.position}%`);
  if (pos.size !== void 0) toks.push(`size:${pos.size}%`);
  if (pos.align !== void 0) toks.push(`align:${pos.align}`);
  return toks.join(" ");
}
function serializeVtt(doc) {
  const raw = doc.metadata.raw ?? {};
  const header = raw.header && raw.header.length > 0 ? raw.header : "WEBVTT";
  let out = header + NL2 + NL2;
  for (const st of raw.styles ?? []) out += st + NL2 + NL2;
  for (const rg of raw.regions ?? []) out += rg + NL2 + NL2;
  for (const nt of raw.notes ?? []) out += nt + NL2 + NL2;
  for (const cue of doc.cues) {
    if (cue.id !== void 0) out += cue.id + NL2;
    const settings = cue.position ? cue.position.raw ?? settingsFromPosition(cue.position) : "";
    out += `${formatVttTc(cue.startMs)} --> ${formatVttTc(cue.endMs)}`;
    if (settings) out += " " + settings;
    out += NL2;
    const textLines = serializeCueLines(cue.lines, { vtt: true });
    if (textLines.length > 0) out += textLines.join(NL2) + NL2;
    out += NL2;
  }
  return out;
}

// src/core/model/cue.ts
function textLine(text) {
  return { spans: [{ text }] };
}
function lineToText(line) {
  return line.spans.map((s) => s.text).join("");
}
function cueToText(cue) {
  return cue.lines.map(lineToText).join("\n");
}

// src/core/formats/sbv/sbv.ts
var NL3 = "\n";
var TC = /^(\d+):([0-5]?\d):([0-5]?\d)\.(\d{1,3})$/;
function parseTc(token) {
  const m = TC.exec(token);
  if (!m) return null;
  return joinMs({ hours: +m[1], minutes: +m[2], seconds: +m[3], millis: +m[4].padEnd(3, "0") });
}
function pad3(n, w) {
  return String(n).padStart(w, "0");
}
function formatTc2(ms) {
  const { hours, minutes, seconds, millis } = splitMs(ms);
  return `${hours}:${pad3(minutes, 2)}:${pad3(seconds, 2)}.${pad3(millis, 3)}`;
}
function parseSbv(text) {
  let src = text;
  if (src.charCodeAt(0) === 65279) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const warnings = [];
  const blocks = [];
  let cur = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (cur.length > 0) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) blocks.push(cur);
  const cues = [];
  for (const block of blocks) {
    const timingLine = block[0];
    const parts = timingLine.split(",");
    const startMs = parts.length === 2 ? parseTc(parts[0].trim()) : null;
    const endMs = parts.length === 2 ? parseTc(parts[1].trim()) : null;
    if (startMs === null || endMs === null) {
      warnings.push({ code: "malformed-timing", message: `Bad timing: "${timingLine}".` });
      continue;
    }
    const index = cues.length + 1;
    const textLines = block.slice(1);
    const cueLines = textLines.map(
      (l) => l === "" || l === BLANK_LINE ? { spans: [] } : textLine(l)
    );
    const cue = { index, startMs, endMs, lines: cueLines };
    if (textLines.length === 0) {
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
  for (let k = 1; k < cues.length; k++) {
    if (cues[k].startMs < cues[k - 1].endMs) {
      warnings.push({
        code: "overlap",
        message: `Cue ${cues[k].index} overlaps the previous cue.`,
        cueIndex: cues[k].index
      });
    }
  }
  return { cues, metadata: { sourceFormat: "sbv" }, warnings };
}
function serializeSbv(doc) {
  let out = "";
  for (const cue of doc.cues) {
    out += `${formatTc2(cue.startMs)},${formatTc2(cue.endMs)}${NL3}`;
    if (cue.lines.length > 0) {
      out += cue.lines.map((l) => lineToText(l) || BLANK_LINE).join(NL3) + NL3;
    }
    out += NL3;
  }
  return out;
}

// src/core/formats/ass/ass.ts
var NL4 = "\r\n";
var TC_RE = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/;
var OVERRIDE_RE = /\{[^}]*\}/g;
var CANONICAL_FIELDS = /* @__PURE__ */ new Set(["Start", "End", "Style", "Text"]);
function pad4(n, w) {
  return String(n).padStart(w, "0");
}
function tcToMs2(token) {
  const m = TC_RE.exec(token.trim());
  if (!m) return null;
  return Number(m[1]) * 36e5 + Number(m[2]) * 6e4 + Number(m[3]) * 1e3 + Number(m[4]) * 10;
}
function formatAssTc(ms) {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 36e4);
  const m = Math.floor(cs / 6e3) % 60;
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return `${h}:${pad4(m, 2)}:${pad4(s, 2)}.${pad4(c, 2)}`;
}
function splitFields(rest, count) {
  const out = [];
  let start = 0;
  for (let k = 0; k < count - 1; k++) {
    const idx = rest.indexOf(",", start);
    if (idx < 0) {
      out.push(rest.slice(start));
      start = rest.length;
      while (out.length < count - 1) out.push("");
      break;
    }
    out.push(rest.slice(start, idx));
    start = idx + 1;
  }
  out.push(rest.slice(start));
  return out;
}
function parseAssText(text) {
  return text.split("\\N").map((line) => ({ spans: parseAssSpans(line) }));
}
function parseAssSpans(line) {
  const spans = [];
  let pending = "";
  let last = 0;
  let m;
  OVERRIDE_RE.lastIndex = 0;
  while ((m = OVERRIDE_RE.exec(line)) !== null) {
    const before = line.slice(last, m.index);
    if (before !== "") {
      spans.push(makeSpan(before, pending));
      pending = "";
    }
    pending += m[0];
    last = OVERRIDE_RE.lastIndex;
  }
  const tail = line.slice(last);
  if (tail !== "" || pending !== "") spans.push(makeSpan(tail, pending));
  return spans;
}
function makeSpan(text, opaque) {
  const span = { text };
  if (opaque !== "") span.opaque = opaque;
  return span;
}
function isSsa(header) {
  if (/^\s*\[V4\+ Styles\]/im.test(header)) return false;
  if (/^\s*\[V4 Styles\]/im.test(header)) return true;
  return /ScriptType:\s*v4\.00(?!\+)/i.test(header);
}
function parseAss(text) {
  let src = text;
  if (src.charCodeAt(0) === 65279) src = src.slice(1);
  const lines = src.split(/\r?\n/);
  const warnings = [];
  let eventsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[Events\]/i.test(lines[i])) {
      eventsIdx = i;
      break;
    }
  }
  let formatIdx = -1;
  if (eventsIdx >= 0) {
    for (let i = eventsIdx + 1; i < lines.length; i++) {
      if (/^\s*Format\s*:/i.test(lines[i])) {
        formatIdx = i;
        break;
      }
    }
  }
  if (formatIdx < 0) {
    warnings.push({ code: "unexpected-content", message: "No [Events] Format line found." });
    return {
      cues: [],
      metadata: { sourceFormat: "ass", raw: { header: src, eventFields: [] } },
      warnings
    };
  }
  const header = lines.slice(0, formatIdx + 1).join("\n");
  const eventFields = lines[formatIdx].slice(lines[formatIdx].indexOf(":") + 1).split(",").map((f) => f.trim());
  const textIdx = eventFields.indexOf("Text");
  const startIdx = eventFields.indexOf("Start");
  const endIdx = eventFields.indexOf("End");
  const styleIdx = eventFields.indexOf("Style");
  const cues = [];
  let trailer = "";
  for (let i = formatIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^\s*\[/.test(line)) {
      const tail = lines.slice(i);
      while (tail.length > 0 && tail[tail.length - 1].trim() === "") tail.pop();
      trailer = tail.join("\n");
      break;
    }
    const ci = line.indexOf(":");
    if (ci < 0) {
      warnings.push({ code: "unexpected-content", message: `Unparsable event: "${line}".` });
      continue;
    }
    const kind = line.slice(0, ci).trim();
    const values = splitFields(line.slice(ci + 1), eventFields.length);
    const startMs = tcToMs2(values[startIdx] ?? "");
    const endMs = tcToMs2(values[endIdx] ?? "");
    if (startMs === null || endMs === null) {
      warnings.push({ code: "malformed-timing", message: `Bad event timing: "${line}".` });
      continue;
    }
    const index = cues.length + 1;
    const fields = {};
    for (let f = 0; f < eventFields.length; f++) {
      const name = eventFields[f];
      if (!CANONICAL_FIELDS.has(name)) fields[name] = (values[f] ?? "").trim();
    }
    const textValue = values[textIdx] ?? "";
    const cue = {
      index,
      startMs,
      endMs,
      lines: textValue === "" ? [] : parseAssText(textValue),
      styleRefs: [(values[styleIdx] ?? "").trim()],
      raw: { kind, fields }
    };
    if (textValue === "") {
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
  for (let k = 1; k < cues.length; k++) {
    if (cues[k].startMs < cues[k - 1].endMs) {
      warnings.push({
        code: "overlap",
        message: `Cue ${cues[k].index} overlaps the previous cue.`,
        cueIndex: cues[k].index
      });
    }
  }
  const sourceFormat = isSsa(header) ? "ssa" : "ass";
  const raw = { header, eventFields };
  if (trailer !== "") raw.trailer = trailer;
  return { cues, metadata: { sourceFormat, raw: { ...raw } }, warnings };
}
var NAMED_RGB = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  lime: "00FF00",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  cyan: "00FFFF",
  aqua: "00FFFF",
  magenta: "FF00FF",
  fuchsia: "FF00FF",
  silver: "C0C0C0",
  gray: "808080",
  grey: "808080",
  maroon: "800000",
  olive: "808000",
  navy: "000080",
  teal: "008080",
  purple: "800080",
  orange: "FFA500"
};
function colorToAssBgr(color) {
  const c = color.trim();
  let rgb;
  if (c.startsWith("&")) {
    const h = c.replace(/[&hH]/g, "");
    if (/^[0-9a-fA-F]{6,8}$/.test(h)) return h.slice(-6).toUpperCase();
    return void 0;
  }
  if (c.startsWith("#")) {
    const h = c.slice(1);
    if (/^[0-9a-fA-F]{6}$/.test(h)) rgb = h.toUpperCase();
    else if (/^[0-9a-fA-F]{3}$/.test(h))
      rgb = h.split("").map((x) => x + x).join("").toUpperCase();
  } else {
    rgb = NAMED_RGB[c.toLowerCase()];
  }
  if (rgb === void 0) return void 0;
  return rgb.slice(4, 6) + rgb.slice(2, 4) + rgb.slice(0, 2);
}
function serializeAssLine(spans) {
  let out = "";
  let cur = { i: false, b: false, u: false, color: void 0 };
  for (const span of spans) {
    if (span.opaque !== void 0) {
      out += span.opaque + span.text;
      continue;
    }
    const tags = [];
    const wantI = span.italic === true;
    const wantB = span.bold === true;
    const wantU = span.underline === true;
    const wantColor = span.color !== void 0 ? colorToAssBgr(span.color) : void 0;
    if (wantI !== cur.i) tags.push(wantI ? "\\i1" : "\\i0");
    if (wantB !== cur.b) tags.push(wantB ? "\\b1" : "\\b0");
    if (wantU !== cur.u) tags.push(wantU ? "\\u1" : "\\u0");
    if (wantColor !== cur.color) tags.push(wantColor !== void 0 ? `\\c&H${wantColor}&` : "\\c");
    cur = { i: wantI, b: wantB, u: wantU, color: wantColor };
    if (tags.length > 0) out += `{${tags.join("")}}`;
    out += span.text;
  }
  const closers = [];
  if (cur.i) closers.push("\\i0");
  if (cur.b) closers.push("\\b0");
  if (cur.u) closers.push("\\u0");
  if (cur.color !== void 0) closers.push("\\c");
  if (closers.length > 0) out += `{${closers.join("")}}`;
  return out;
}
function playRes(header) {
  const mx = /^\s*PlayResX:\s*(\d+)/im.exec(header);
  const my = /^\s*PlayResY:\s*(\d+)/im.exec(header);
  return { x: mx ? Number(mx[1]) : 1920, y: my ? Number(my[1]) : 1080 };
}
function alignNum(pos) {
  const col = pos.align === "left" || pos.align === "start" ? 1 : pos.align === "center" ? 2 : pos.align === "right" || pos.align === "end" ? 3 : void 0;
  const row = typeof pos.line === "number" ? pos.line < 100 / 3 ? 2 : pos.line < 200 / 3 ? 1 : 0 : void 0;
  if (col === void 0 && row === void 0) return void 0;
  return (row ?? 0) * 3 + (col ?? 2);
}
function positionPrefix(pos, res) {
  if (pos === void 0) return "";
  const tags = [];
  const an = alignNum(pos);
  if (an !== void 0) tags.push(`\\an${an}`);
  if (typeof pos.position === "number" && typeof pos.line === "number") {
    const x = Math.round(pos.position / 100 * res.x);
    const y = Math.round(pos.line / 100 * res.y);
    tags.push(`\\pos(${x},${y})`);
  }
  return tags.length > 0 ? `{${tags.join("")}}` : "";
}
function serializeAssText(lines) {
  return lines.map((l) => serializeAssLine(l.spans)).join("\\N");
}
function serializeAss(doc) {
  const raw = doc.metadata.raw ?? {};
  const header = raw.header && raw.header.length > 0 ? raw.header : defaultHeader();
  const fields = raw.eventFields && raw.eventFields.length > 0 ? raw.eventFields : DEFAULT_EVENT_FIELDS;
  const res = playRes(header);
  let out = header.replace(/\r?\n/g, NL4) + NL4;
  for (const cue of doc.cues) {
    const cr = cue.raw ?? { kind: "Dialogue", fields: {} };
    const kind = cr.kind ?? "Dialogue";
    const cueFields = cr.fields ?? {};
    const values = fields.map((name) => {
      switch (name) {
        case "Start":
          return formatAssTc(cue.startMs);
        case "End":
          return formatAssTc(cue.endMs);
        case "Style":
          return cue.styleRefs?.[0] ?? "Default";
        case "Text":
          return positionPrefix(cue.position, res) + serializeAssText(cue.lines);
        default:
          return cueFields[name] ?? "";
      }
    });
    out += `${kind}: ${values.join(",")}${NL4}`;
  }
  if (raw.trailer !== void 0 && raw.trailer !== "") {
    out += NL4 + raw.trailer.replace(/\r?\n/g, NL4) + NL4;
  }
  return out;
}
var DEFAULT_EVENT_FIELDS = [
  "Layer",
  "Start",
  "End",
  "Style",
  "Name",
  "MarginL",
  "MarginR",
  "MarginV",
  "Effect",
  "Text"
];
function defaultHeader() {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
    "",
    "[Events]",
    "Format: " + DEFAULT_EVENT_FIELDS.join(", ")
  ].join("\n");
}

// src/core/formats/registry.ts
var TEXT_FORMATS = {
  srt: {
    id: "srt",
    name: "SubRip",
    extensions: [".srt"],
    parse: parseSrt,
    serialize: serializeSrt
  },
  vtt: {
    id: "vtt",
    name: "WebVTT",
    extensions: [".vtt"],
    parse: parseVtt,
    serialize: serializeVtt
  },
  sbv: {
    id: "sbv",
    name: "YouTube SBV",
    extensions: [".sbv"],
    parse: parseSbv,
    serialize: serializeSbv
  },
  ass: {
    id: "ass",
    name: "Advanced SubStation Alpha",
    extensions: [".ass", ".ssa"],
    parse: parseAss,
    serialize: serializeAss
  }
};
var TEXT_FORMAT_IDS = Object.keys(TEXT_FORMATS);
function getTextFormat(id) {
  return TEXT_FORMATS[id];
}

// src/core/formats/convert.ts
var CAN = {
  // SRT speaks <i>/<b>/<u>/<font color>; <v> is WebVTT-only, so voice spans are
  // dropped (text kept) with a warning when converting to SRT.
  srt: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color"]),
  // VTT color is expressed as a <c.classname> span (no STYLE block synthesized).
  vtt: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color", "voice", "position"]),
  // SBV is plain text only.
  sbv: /* @__PURE__ */ new Set([]),
  // ASS expresses i/b/u via override tags, keeps native overrides, and (H1)
  // synthesizes \c colour from span.color and \pos/\an from cue.position.
  ass: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color", "position", "override"])
};
var PRO_CAN = {
  // tts:fontStyle/fontWeight/textDecoration/color + text alignment (tts:textAlign)
  // and writing direction. Absolute x/y placement is not emitted — cues carrying
  // line/position/size get an explicit drop warning (cue-forge-z6t).
  ttml: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color", "position"]),
  // CEA-608 mid-row codes: italics, underline, and the 7 caption colours.
  scc: /* @__PURE__ */ new Set(["italic", "underline", "color"]),
  // EBU-STL text-field control codes: italics and underline only.
  stl: /* @__PURE__ */ new Set(["italic", "underline"]),
  // Apple iTT (constrained TTML): the TTML styling subset + text alignment;
  // x/y placement warns like TTML (cue-forge-z6t).
  itt: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color", "position"]),
  // IMSC 1.0.1 / 1.1 (validated TTML profiles): same styling subset as plain
  // TTML (cue-forge-sdv.7); x/y placement warns like TTML/iTT (cue-forge-z6t).
  imsc101: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color", "position"]),
  imsc11: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color", "position"]),
  // MCC (CEA-708 container over CEA-608 mid-row codes): italics, underline, and
  // the 7 caption colours — the same expressible subset as SCC.
  mcc: /* @__PURE__ */ new Set(["italic", "underline", "color"]),
  // EBU-TT-D (a TTML distribution profile): the same TTML styling subset;
  // x/y placement warns like TTML/IMSC (cue-forge-z6t).
  ebuttd: /* @__PURE__ */ new Set(["italic", "bold", "underline", "color", "position"])
};
function targetCapabilities(to) {
  return to in CAN ? CAN[to] : PRO_CAN[to];
}
var ALL_TARGETS = [
  ...Object.keys(CAN),
  ...Object.keys(PRO_CAN)
];
function applyOverrideBlock(block, state, dropped) {
  const inner = block.replace(/^\{|\}$/g, "");
  for (const tag of inner.split("\\")) {
    if (tag === "") continue;
    if (/^i[01]$/.test(tag)) state.italic = tag === "i1";
    else if (/^b\d+$/.test(tag)) state.bold = Number(tag.slice(1)) !== 0;
    else if (/^u[01]$/.test(tag)) state.underline = tag === "u1";
    else dropped.push("\\" + tag);
  }
}
function overrideBlocks(opaque) {
  return opaque.match(/\{[^}]*\}/g) ?? [];
}
function interpretAssOverrides(lines) {
  const dropped = [];
  const outLines = [];
  for (const line of lines) {
    const state = { italic: false, bold: false, underline: false };
    let spans = [];
    for (const span of line.spans) {
      if (span.opaque !== void 0) {
        for (const block of overrideBlocks(span.opaque)) applyOverrideBlock(block, state, dropped);
      }
      if (span.text === "") continue;
      const parts = span.text.replace(/\\h/g, "\xA0").split("\\n");
      parts.forEach((part, k) => {
        if (k > 0) {
          outLines.push({ spans });
          spans = [];
        }
        if (part === "") return;
        const out = { text: part };
        if (state.italic) out.italic = true;
        if (state.bold) out.bold = true;
        if (state.underline) out.underline = true;
        if (span.color !== void 0) out.color = span.color;
        if (span.voice !== void 0) out.voice = span.voice;
        spans.push(out);
      });
    }
    outLines.push({ spans });
  }
  return { lines: outLines, dropped };
}
function interpretedCapabilities(doc) {
  const caps = /* @__PURE__ */ new Set();
  for (const cue of doc.cues) {
    if (cue.position) caps.add("position");
    for (const line of cue.lines) {
      for (const span of line.spans) {
        if (span.italic) caps.add("italic");
        if (span.bold) caps.add("bold");
        if (span.underline) caps.add("underline");
        if (span.color !== void 0) caps.add("color");
        if (span.voice !== void 0) caps.add("voice");
        if (span.opaque !== void 0) {
          const state = { italic: false, bold: false, underline: false };
          const dropped = [];
          for (const block of overrideBlocks(span.opaque))
            applyOverrideBlock(block, state, dropped);
          if (state.italic) caps.add("italic");
          if (state.bold) caps.add("bold");
          if (state.underline) caps.add("underline");
          if (dropped.length > 0) caps.add("override");
        }
      }
    }
  }
  return caps;
}
function eventKind(cue) {
  if (cue.raw !== null && typeof cue.raw === "object" && "kind" in cue.raw) {
    const kind = cue.raw.kind;
    if (typeof kind === "string") return kind;
  }
  return void 0;
}
function isVttOpaque(opaque) {
  return opaque.startsWith("<");
}
function stripVttMarkup(cues) {
  const dropped = [];
  const out = cues.map((cue) => {
    let changed = false;
    const lines = cue.lines.map((line) => {
      const spans = [];
      for (const span of line.spans) {
        if (span.opaque === void 0 || !isVttOpaque(span.opaque)) {
          spans.push(span);
          continue;
        }
        changed = true;
        dropped.push(span.opaque);
        const { opaque: _opaque, ...rest } = span;
        void _opaque;
        if (rest.text !== "") spans.push(rest);
      }
      return { spans };
    });
    return changed ? { ...cue, lines } : cue;
  });
  return { cues: out, dropped };
}
function normalizeForTarget(doc, to) {
  const warnings = [];
  const targetIsAss = to === "ass";
  const docCaps = interpretedCapabilities(doc);
  let cues = doc.cues;
  if (!targetIsAss) {
    const kept = cues.filter((cue) => {
      const kind = eventKind(cue);
      return kind === void 0 || kind === "Dialogue";
    });
    if (kept.length !== cues.length) {
      warnings.push({
        code: "capability-dropped",
        message: `${cues.length - kept.length} comment event(s) dropped (target "${to}" only has dialogue cues).`
      });
      cues = kept;
    }
  }
  if (to !== "vtt") {
    const r = stripVttMarkup(cues);
    if (r.dropped.length > 0) {
      cues = r.cues;
      warnings.push({
        code: "capability-dropped",
        message: `Target "${to}" cannot express WebVTT markup (${[...new Set(r.dropped)].join(" ")}); it was dropped.`
      });
    }
  }
  const can = targetCapabilities(to);
  if (doc.metadata.sourceFormat === "srt" && to !== "srt") {
    let tagged = 0;
    cues = cues.map((cue) => {
      const an = srtAlignment(cue);
      if (an === void 0) return cue;
      tagged++;
      const { an: _an, ...rest } = cue.raw;
      void _an;
      const out = { ...cue, raw: Object.keys(rest).length > 0 ? rest : void 0 };
      if (out.raw === void 0) delete out.raw;
      if (can.has("position") && !cue.position) out.position = positionFromAlignment(an);
      return out;
    });
    if (tagged > 0 && !can.has("position")) {
      warnings.push({
        code: "capability-dropped",
        message: `Target "${to}" cannot express position ({\\an} placement on ${tagged} cue(s)); it was dropped.`
      });
    }
  }
  const droppedTags = [];
  const fromAss = doc.metadata.sourceFormat === "ass" || doc.metadata.sourceFormat === "ssa";
  if (!targetIsAss && (fromAss || cuesHaveAssOpaque(cues))) {
    cues = cues.map((cue) => {
      const r = interpretAssOverrides(cue.lines);
      droppedTags.push(...r.dropped);
      return { ...cue, lines: r.lines };
    });
  }
  const stripVoice = !can.has("voice");
  const stripColor = !can.has("color");
  if (stripVoice || stripColor) {
    cues = cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map((line) => ({
        spans: line.spans.map((span) => {
          if ((!stripVoice || span.voice === void 0) && (!stripColor || span.color === void 0)) {
            return span;
          }
          const out = { ...span };
          if (stripVoice) delete out.voice;
          if (stripColor) delete out.color;
          return out;
        })
      }))
    }));
  }
  for (const cap of docCaps) {
    if (can.has(cap)) continue;
    const detail = cap === "override" && droppedTags.length > 0 ? ` (${[...new Set(droppedTags)].join(" ")})` : "";
    warnings.push({
      code: "capability-dropped",
      message: `Target "${to}" cannot express ${cap}${detail}; it was dropped.`
    });
  }
  if (to === "ttml" || to === "itt" || to === "imsc101" || to === "imsc11" || to === "ebuttd") {
    const n = cues.filter(
      (c) => c.position && (c.position.line !== void 0 || c.position.position !== void 0 || c.position.size !== void 0)
    ).length;
    if (n > 0) {
      warnings.push({
        code: "capability-dropped",
        message: `Target "${to}" keeps text alignment but not exact x/y placement; ${n} cue(s) lose absolute positioning.`
      });
    }
  }
  const source = doc.metadata.sourceFormat;
  const rebuildsHead = to === "imsc101" || to === "imsc11" || to === "ebuttd";
  const preserveNative = (source === to || source === "ssa" && targetIsAss) && !rebuildsHead;
  const metadata = { ...doc.metadata, sourceFormat: to };
  if (!preserveNative) {
    const raw = metadata.raw;
    const hasNativeDefinitions = raw?.head !== void 0 || fromAss && raw?.header !== void 0 || ["styles", "regions", "notes"].some(
      (field) => Array.isArray(raw?.[field]) && raw[field].length > 0
    ) || source === "vtt" && typeof raw?.header === "string" && raw.header.trim() !== "WEBVTT";
    const hasNativeReferences = cues.some(
      (cue) => (cue.styleRefs?.length ?? 0) > 0 || cue.raw !== void 0 || /(?:^|\s)region:/.test(cue.position?.raw ?? "")
    );
    if (hasNativeDefinitions || hasNativeReferences) {
      warnings.push({
        code: "capability-dropped",
        message: `Target "${to}" does not preserve native "${source}" headers, styling/layout or cue references; native definitions and references were dropped.`
      });
    }
    delete metadata.raw;
    cues = cues.map((cue) => {
      const normalized = { ...cue };
      delete normalized.raw;
      delete normalized.styleRefs;
      if (cue.position?.raw !== void 0) {
        normalized.position = { ...cue.position };
        delete normalized.position.raw;
      }
      return normalized;
    });
  }
  return { doc: { cues, metadata, warnings: [] }, warnings };
}
function cuesHaveAssOpaque(cues) {
  return cues.some(
    (c) => c.lines.some((l) => l.spans.some((s) => s.opaque !== void 0 && s.opaque.startsWith("{")))
  );
}

// src/core/repair.ts
function repairDocument(doc, options = {}) {
  const { renumber = true, normalizeTiming = true, fixReversed = true } = options;
  const repairs = [];
  let renumbered = false;
  const cues = doc.cues.map((c, i) => {
    let startMs = c.startMs;
    let endMs = c.endMs;
    if (normalizeTiming) {
      const ns = Math.max(0, Math.floor(startMs));
      const ne = Math.max(0, Math.floor(endMs));
      if (ns !== startMs || ne !== endMs) {
        repairs.push({
          code: "normalize-timing",
          message: `Normalized timing of cue ${c.index}.`,
          cueIndex: c.index
        });
        startMs = ns;
        endMs = ne;
      }
    }
    if (fixReversed && endMs < startMs) {
      [startMs, endMs] = [endMs, startMs];
      repairs.push({
        code: "fix-reversed",
        message: `Swapped reversed start/end of cue ${c.index}.`,
        cueIndex: c.index
      });
    }
    const index = renumber ? i + 1 : c.index;
    const changed = renumber && index !== c.index;
    if (changed) renumbered = true;
    const out = { ...c, index, startMs, endMs };
    if (changed && out.sourceIndex === void 0) out.sourceIndex = c.index;
    return out;
  });
  if (renumbered) {
    repairs.push({ code: "renumber", message: "Renumbered cue indices sequentially." });
  }
  return { doc: { ...doc, cues }, repairs };
}

// src/core/formats/pro.ts
var PRO_FORMATS = [
  { id: "ttml", name: "TTML / IMSC1", extensions: [".ttml", ".xml", ".dfxp"], kind: "text" },
  { id: "scc", name: "Scenarist Closed Caption", extensions: [".scc"], kind: "text" },
  { id: "stl", name: "EBU-STL", extensions: [".stl"], kind: "binary" },
  { id: "itt", name: "Apple iTT", extensions: [".itt"], kind: "text" },
  { id: "imsc101", name: "IMSC 1.0.1 (TTML)", extensions: [".ttml", ".xml"], kind: "text" },
  { id: "imsc11", name: "IMSC 1.1 (TTML)", extensions: [".ttml", ".xml"], kind: "text" },
  { id: "mcc", name: "MCC (CEA-708)", extensions: [".mcc"], kind: "text" },
  { id: "ebuttd", name: "EBU-TT-D", extensions: [".xml"], kind: "text" }
];
var PRO_FORMAT_IDS = PRO_FORMATS.map((f) => f.id);
function getProFormat(id) {
  const fmt = PRO_FORMATS.find((f) => f.id === id);
  if (!fmt) throw new Error(`Unknown Pro format: ${id}`);
  return fmt;
}
async function loadProCodec(id) {
  switch (id) {
    case "ttml": {
      const m = await import("./chunks/ttml-2Q4GVP7E.mjs");
      return { kind: "text", parse: m.parseTtml, serialize: m.serializeTtml };
    }
    case "scc": {
      const m = await import("./chunks/scc-MJPUXAPF.mjs");
      return {
        kind: "text",
        parse: m.parseScc,
        serialize: m.serializeScc,
        canEncodeChar: m.canEncodeCea608
      };
    }
    case "stl": {
      const m = await import("./chunks/stl-W7C2GRSU.mjs");
      return {
        kind: "binary",
        parse: m.parseStl,
        serialize: m.serializeStl,
        canEncodeChar: m.canEncodeIso6937
      };
    }
    case "itt": {
      const m = await import("./chunks/itt-LZIA7SNQ.mjs");
      return { kind: "text", parse: m.parseItt, serialize: m.serializeItt };
    }
    case "imsc101": {
      const m = await import("./chunks/imsc-OBACOUAH.mjs");
      return { kind: "text", parse: m.parseImsc101, serialize: m.serializeImsc101 };
    }
    case "imsc11": {
      const m = await import("./chunks/imsc-OBACOUAH.mjs");
      return { kind: "text", parse: m.parseImsc11, serialize: m.serializeImsc11 };
    }
    case "mcc": {
      const m = await import("./chunks/mcc-3VBZFBRZ.mjs");
      return {
        kind: "text",
        parse: m.parseMcc,
        serialize: m.serializeMcc,
        canEncodeChar: m.canEncodeMcc
      };
    }
    case "ebuttd": {
      const m = await import("./chunks/ebuttd-WJ3XJ252.mjs");
      return { kind: "text", parse: m.parseEbuttd, serialize: m.serializeEbuttd };
    }
  }
}

// src/app/editor/uid.ts
function newUid() {
  return crypto.randomUUID();
}
function assignUids(doc) {
  let changed = false;
  const cues = doc.cues.map((c) => {
    if (c.uid !== void 0) return c;
    changed = true;
    return { ...c, uid: newUid() };
  });
  return changed ? { ...doc, cues } : doc;
}

// src/app/session/session.ts
function extensionOf(filename) {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}
function detectFormatFromName(filename) {
  const ext = extensionOf(filename);
  if (ext === "") return null;
  for (const id of TEXT_FORMAT_IDS) {
    if (getTextFormat(id).extensions.includes(ext)) return id;
  }
  return null;
}
function sniffHead(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 512));
}
function looksLikeStl(bytes) {
  return bytes.length > 11 && bytes[3] === 83 && bytes[4] === 84 && bytes[5] === 76;
}
var TTML_ROOT_RE = /<(?:\w+:)?tt[\s/>]/;
var EBUTTD_RE = /urn:ebu:tt:distribution|ebuttm:/;
var MCC_RE = /File Format=MacCaption_MCC/i;
function detectImportFormat(filename, bytes) {
  const free = detectFormatFromName(filename);
  if (free) return { id: free, pro: false };
  const ext = extensionOf(filename);
  if (ext === ".scc") return { id: "scc", pro: true };
  if (ext === ".stl") return { id: "stl", pro: true };
  if (ext === ".itt") return { id: "itt", pro: true };
  if (ext === ".mcc") return { id: "mcc", pro: true };
  if (ext === ".ttml" || ext === ".dfxp") return { id: "ttml", pro: true };
  if (ext === ".xml") {
    const head2 = sniffHead(bytes);
    if (!TTML_ROOT_RE.test(head2)) return null;
    return EBUTTD_RE.test(head2) ? { id: "ebuttd", pro: true } : { id: "ttml", pro: true };
  }
  if (looksLikeStl(bytes)) return { id: "stl", pro: true };
  const head = sniffHead(bytes);
  if (/Scenarist_SCC/i.test(head)) return { id: "scc", pro: true };
  if (MCC_RE.test(head)) return { id: "mcc", pro: true };
  if (TTML_ROOT_RE.test(head)) {
    return EBUTTD_RE.test(head) ? { id: "ebuttd", pro: true } : { id: "ttml", pro: true };
  }
  return null;
}
var UnknownFormatError = class extends Error {
  constructor(filename) {
    super(
      `Unrecognized subtitle format for "${filename}". Supported: .srt, .vtt, .sbv, .ass/.ssa, and (Pro) .scc, .stl, .ttml, .itt, .mcc, .xml (EBU-TT-D).`
    );
    this.name = "UnknownFormatError";
  }
};
var ProImportLockedError = class extends Error {
  constructor(formatName) {
    super(`Opening ${formatName} files is a Pro feature. Unlock Pro to import ${formatName}.`);
    this.formatName = formatName;
    this.name = "ProImportLockedError";
  }
  formatName;
};
var MAX_IMPORT_BYTES = 25 * 1024 * 1024;
var FileTooLargeError = class extends Error {
  constructor(filename, bytes) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const limit = Math.round(MAX_IMPORT_BYTES / (1024 * 1024));
    super(
      `"${filename}" is ${mb} MB \u2014 too large to open (limit ${limit} MB). Subtitle files are usually under 1 MB; please check it's a subtitle file.`
    );
    this.name = "FileTooLargeError";
  }
};
function guardSize(filename, bytes) {
  if (bytes.length > MAX_IMPORT_BYTES) throw new FileTooLargeError(filename, bytes.length);
}
function withEmptyResultWarning(warnings, cueCount, hadContent, formatName, filename) {
  if (cueCount > 0 || !hadContent) return warnings;
  return [
    ...warnings,
    {
      code: "empty-result",
      message: `No subtitles were found in "${filename}" \u2014 it may be empty or not a valid ${formatName} file.`
    }
  ];
}
function friendlyLoadError(err, filename) {
  if (err instanceof UnknownFormatError || err instanceof FileTooLargeError) {
    return err.message;
  }
  return `Couldn't open "${filename}". The file may be corrupted or in an unsupported format.`;
}
function importBytes(filename, bytes, sourceFormat) {
  guardSize(filename, bytes);
  const format = sourceFormat ?? detectFormatFromName(filename);
  if (!format) throw new UnknownFormatError(filename);
  const codec = getTextFormat(format);
  const { text, encoding, hadBom, warning } = decode(bytes);
  const parsed = codec.parse(text);
  const { doc: repairedDoc, repairs } = repairDocument(parsed);
  const doc = assignUids(repairedDoc);
  return {
    filename,
    sourceFormat: format,
    doc,
    encoding,
    hadBom,
    repairs,
    parseWarnings: withEmptyResultWarning(
      warning ? [{ code: "encoding-assumed", message: warning }, ...parsed.warnings] : parsed.warnings,
      doc.cues.length,
      text.trim().length > 0,
      codec.name,
      filename
    )
  };
}
async function importFile(filename, bytes, opts = { allowPro: false }) {
  guardSize(filename, bytes);
  const detected = detectImportFormat(filename, bytes);
  if (!detected) throw new UnknownFormatError(filename);
  if (!detected.pro) return importBytes(filename, bytes, detected.id);
  if (!opts.allowPro) throw new ProImportLockedError(getProFormat(detected.id).name);
  const proName = getProFormat(detected.id).name;
  const codec = await loadProCodec(detected.id);
  let parsed;
  let encoding = "binary";
  let hadBom = false;
  let hadContent = bytes.length > 0;
  let decodeWarning;
  if (codec.kind === "binary") {
    parsed = codec.parse(bytes);
  } else {
    const decoded = decode(bytes);
    parsed = codec.parse(decoded.text);
    encoding = decoded.encoding;
    hadBom = decoded.hadBom;
    hadContent = decoded.text.trim().length > 0;
    decodeWarning = decoded.warning;
  }
  const { doc: repairedDoc, repairs } = repairDocument(parsed);
  const doc = assignUids(repairedDoc);
  return {
    filename,
    sourceFormat: detected.id,
    doc,
    encoding,
    hadBom,
    repairs,
    parseWarnings: withEmptyResultWarning(
      decodeWarning ? [{ code: "encoding-assumed", message: decodeWarning }, ...parsed.warnings] : parsed.warnings,
      doc.cues.length,
      hadContent,
      proName,
      filename
    )
  };
}
function retargetFilename(filename, target) {
  const ext = getTextFormat(target).extensions[0] ?? `.${target}`;
  const dot = filename.lastIndexOf(".");
  const base = dot < 0 ? filename : filename.slice(0, dot);
  return base + ext;
}
function exportDocument(loaded, target) {
  const { doc, warnings } = normalizeForTarget(loaded.doc, target);
  const text = getTextFormat(target).serialize(doc);
  return {
    text,
    filename: retargetFilename(loaded.filename, target),
    format: target,
    warnings
  };
}
var CHARSET_FAIL_SHARE = 0.3;
var CharsetUnsupportedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CharsetUnsupportedError";
  }
};
function retargetExtension(filename, ext) {
  const dot = filename.lastIndexOf(".");
  const base = dot < 0 ? filename : filename.slice(0, dot);
  return base + ext;
}
async function exportProDocument(loaded, target) {
  const codec = await loadProCodec(target);
  const { name, extensions } = getProFormat(target);
  const filename = retargetExtension(loaded.filename, extensions[0] ?? `.${target}`);
  const { doc, warnings } = normalizeForTarget(loaded.doc, target);
  if (codec.canEncodeChar) {
    const report = checkCharset(doc, codec.canEncodeChar);
    if (report.unrepresentable > 0) {
      const examples = report.samples.map((s) => `"${s}"`).join(", ");
      if (report.share > CHARSET_FAIL_SHARE) {
        throw new CharsetUnsupportedError(
          `${name} cannot represent ${report.unrepresentable} of ${report.total} character(s) (e.g. ${examples}); export aborted.`
        );
      }
      warnings.push({
        code: "charset-unrepresentable",
        message: `${name} cannot represent ${report.unrepresentable} character(s) (e.g. ${examples}); they will be replaced.`
      });
    }
  }
  if (codec.kind === "binary") {
    return { filename, format: target, kind: "binary", bytes: codec.serialize(doc), warnings };
  }
  return { filename, format: target, kind: "text", text: codec.serialize(doc, warnings), warnings };
}

// src/core/qc/ruleset.schema.ts
var DIGIT_STYLES = [
  "western",
  "arabic-indic",
  "extended-arabic-indic"
];
var RULE_IDS = [
  "max-chars-per-line",
  "max-lines-per-cue",
  "max-cps",
  "min-duration",
  "max-duration",
  "min-gap",
  "overlap",
  "reversed-timing",
  "empty-cue",
  "duplicate-cue",
  "forbidden-characters",
  "punctuation-spacing",
  "unclosed-tag",
  "cue-count-monotonic-timing",
  "bidi-punctuation",
  "mixed-digit-style",
  "latin-run-isolation",
  "arabic-line-length",
  "kashida-strip",
  "ellipsis-style"
];
var RULE_ID_SET = new Set(RULE_IDS);
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function validateRuleParams(id, cfg, errors) {
  const num = (key) => {
    if (typeof cfg[key] !== "number" || !Number.isFinite(cfg[key])) {
      errors.push(`${id}: ${key} must be a finite number`);
    }
  };
  const stringArray = (key) => {
    const v = cfg[key];
    if (v === void 0) return;
    if (!Array.isArray(v) || v.some((e) => typeof e !== "string")) {
      errors.push(`${id}: ${key} must be an array of strings`);
    }
  };
  switch (id) {
    case "max-chars-per-line":
    case "max-lines-per-cue":
    case "arabic-line-length":
      num("max");
      break;
    case "max-cps": {
      num("max");
      const ranges = cfg.excludeRanges;
      if (ranges !== void 0 && (!Array.isArray(ranges) || ranges.some(
        (r) => !Array.isArray(r) || r.length !== 2 || typeof r[0] !== "number" || typeof r[1] !== "number"
      ))) {
        errors.push(`${id}: excludeRanges must be an array of [number, number] pairs`);
      }
      break;
    }
    case "forbidden-characters":
      stringArray("chars");
      stringArray("patterns");
      break;
    case "mixed-digit-style":
      if (cfg.style !== void 0 && !DIGIT_STYLES.includes(cfg.style)) {
        errors.push(`${id}: style must be one of ${DIGIT_STYLES.join(", ")}`);
      }
      break;
    case "min-duration":
    case "max-duration":
      num("ms");
      break;
    case "min-gap":
      if (cfg.ms === void 0 && cfg.frames === void 0) {
        errors.push(`${id}: must specify ms or frames`);
      }
      if (cfg.ms !== void 0 && typeof cfg.ms !== "number") {
        errors.push(`${id}: ms must be a number`);
      }
      if (cfg.frames !== void 0 && typeof cfg.frames !== "number") {
        errors.push(`${id}: frames must be a number`);
      }
      break;
    default:
      break;
  }
}
function validateRuleset(data) {
  const errors = [];
  if (!isObject(data)) return ["ruleset must be an object"];
  if (typeof data.name !== "string") errors.push("name must be a string");
  if (typeof data.verified !== "boolean") errors.push("verified must be a boolean");
  if (data.reference !== void 0 && typeof data.reference !== "string") {
    errors.push("reference must be a string");
  }
  if (!isObject(data.rules)) {
    errors.push("rules must be an object");
    return errors;
  }
  for (const [id, cfg] of Object.entries(data.rules)) {
    if (!RULE_ID_SET.has(id)) {
      errors.push(`unknown rule id: ${id}`);
      continue;
    }
    if (!isObject(cfg)) {
      errors.push(`${id}: config must be an object`);
      continue;
    }
    if (typeof cfg.enabled !== "boolean") errors.push(`${id}: enabled must be a boolean`);
    if (cfg.severity !== "error" && cfg.severity !== "warning") {
      errors.push(`${id}: severity must be "error" or "warning"`);
    }
    validateRuleParams(id, cfg, errors);
  }
  return errors;
}
var RulesetError = class extends Error {
  constructor(errors) {
    super(`Invalid ruleset:
  ${errors.join("\n  ")}`);
    this.errors = errors;
    this.name = "RulesetError";
  }
  errors;
};
function parseRuleset(data) {
  const errors = validateRuleset(data);
  if (errors.length > 0) throw new RulesetError(errors);
  return data;
}

// src/core/qc/rules/util.ts
function countCodePoints(text) {
  return [...text].length;
}

// src/core/qc/rules/length.ts
function sameStyle(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function lineToWords(line) {
  const words = [];
  for (const span of line.spans) {
    const { text, ...style } = span;
    for (const part of text.split(" ")) {
      if (part !== "") words.push({ text: part, style });
    }
  }
  return words;
}
function styleOf2(span) {
  const style = { ...span };
  delete style.text;
  return style;
}
function wordsToSpans(words) {
  const spans = [];
  words.forEach((w, i) => {
    const last = spans[spans.length - 1];
    if (i > 0 && last) {
      if (sameStyle(styleOf2(last), w.style)) {
        last.text += " " + w.text;
        return;
      }
      last.text += " ";
    }
    spans.push({ text: w.text, ...w.style });
  });
  return spans;
}
function wrapLine(line, max) {
  const words = lineToWords(line);
  if (words.length === 0) return [line];
  const rows = [[]];
  let len = 0;
  for (const w of words) {
    const wl = countCodePoints(w.text);
    const row = rows[rows.length - 1];
    if (row.length === 0) {
      row.push(w);
      len = wl;
    } else if (len + 1 + wl <= max) {
      row.push(w);
      len += 1 + wl;
    } else {
      rows.push([w]);
      len = wl;
    }
  }
  return rows.map((row) => ({ spans: wordsToSpans(row) }));
}
function rewrapCue(cue, max) {
  const lines = cue.lines.flatMap(
    (line) => countCodePoints(lineToText(line)) > max ? wrapLine(line, max) : [line]
  );
  return { ...cue, lines };
}
var maxCharsPerLine = {
  id: "max-chars-per-line",
  fixable: true,
  evaluate(doc, config) {
    const out = [];
    for (const cue of doc.cues) {
      cue.lines.forEach((line, i) => {
        const len = countCodePoints(lineToText(line));
        if (len > config.max) {
          out.push({
            cueIndex: cue.index,
            message: `Line ${i + 1} is ${len} characters (max ${config.max}).`
          });
        }
      });
    }
    return out;
  },
  // Re-wrap each over-long line at word boundaries (never breaking a word).
  fix(doc, config) {
    return { ...doc, cues: doc.cues.map((cue) => rewrapCue(cue, config.max)) };
  },
  // Cue-scoped variant (cue-forge-zxw.12): re-wrap just one cue so fix-one can
  // land the clicked cue even when the whole-doc fix would be reverted elsewhere.
  fixCue(cue, config) {
    return rewrapCue(cue, config.max);
  },
  // The re-wrap helps only when it does not trade a line-length violation for a
  // line-count one (cue-forge-8b4). fix-one now re-wraps ONLY the clicked cue
  // (cue-forge-zxw.12), so the verdict is PER-CUE: wrapping a cue is reverted by
  // the zero-new-issues guard exactly when that cue transitions from within
  // max-lines to over it. A cue already over max-lines is a pre-existing issue —
  // wrapping it does not raise the count, so it stays fixable. With no enforced
  // line cap, the fix always helps. (Was a whole-document verdict under zxw.2,
  // when the fixer could only run doc-wide and one bad cue reverted them all.)
  fixableInContext(doc, ruleset) {
    const max = ruleset.rules["max-chars-per-line"]?.max;
    const lineCfg = ruleset.rules["max-lines-per-cue"];
    const maxLines = lineCfg !== void 0 && lineCfg.enabled !== false ? lineCfg.max : void 0;
    if (max === void 0 || maxLines === void 0) return () => true;
    const wrappedLineCount = (cue) => {
      let lines = 0;
      for (const line of cue.lines) {
        lines += countCodePoints(lineToText(line)) > max ? wrapLine(line, max).length : 1;
      }
      return lines;
    };
    const byIndex = new Map(doc.cues.map((c) => [c.index, c]));
    return (violation) => {
      const cue = byIndex.get(violation.cueIndex);
      if (cue === void 0) return true;
      return !(cue.lines.length <= maxLines && wrappedLineCount(cue) > maxLines);
    };
  }
};
var maxLinesPerCue = {
  id: "max-lines-per-cue",
  fixable: false,
  evaluate(doc, config) {
    const out = [];
    for (const cue of doc.cues) {
      if (cue.lines.length > config.max) {
        out.push({
          cueIndex: cue.index,
          message: `Cue has ${cue.lines.length} lines (max ${config.max}).`
        });
      }
    }
    return out;
  }
};

// src/core/rtl/index.ts
var RLM = "\u200F";
var LRM = "\u200E";
var TATWEEL = "\u0640";
var BIDI_CONTROL_RANGES = [
  [8206, 8207],
  [1564, 1564],
  [8234, 8238],
  [8294, 8297]
];
var TATWEEL_CP = TATWEEL.codePointAt(0);
var RTL_RE = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
var LATIN_LETTER_RE = new RegExp("\\p{Script=Latin}", "u");
var ZERO_WIDTH_RE = /[\p{Mn}\p{Cf}]/u;
function test(re, cp) {
  return re.test(String.fromCodePoint(cp));
}
function hasRtl(text) {
  return RTL_RE.test(text);
}
function isCombiningMark(cp) {
  return test(ZERO_WIDTH_RE, cp);
}
function isTatweel(cp) {
  return cp === TATWEEL_CP;
}
function visibleLength(text) {
  let n = 0;
  for (const ch of text) {
    if (!isCombiningMark(ch.codePointAt(0))) n++;
  }
  return n;
}
function stripTatweel(text) {
  return [...text].filter((ch) => !isTatweel(ch.codePointAt(0))).join("");
}
var DIGIT_BASE = {
  western: 48,
  // 0-9
  "arabic-indic": 1632,
  // ٠-٩
  "extended-arabic-indic": 1776
  // ۰-۹ (Persian/Urdu)
};
function digitStyle(cp) {
  for (const style of Object.keys(DIGIT_BASE)) {
    const base = DIGIT_BASE[style];
    if (cp >= base && cp <= base + 9) return style;
  }
  return null;
}
function convertDigits(text, target) {
  const base = DIGIT_BASE[target];
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const style = digitStyle(cp);
    out += style === null ? ch : String.fromCodePoint(base + (cp - DIGIT_BASE[style]));
  }
  return out;
}

// src/core/qc/format.ts
function docDropFrame(doc) {
  const df = doc.metadata.raw?.["dropFrame"];
  return typeof df === "boolean" ? df : void 0;
}
function positionLabelFor(doc) {
  const fps = doc.metadata.frameRate;
  const dropFrame = docDropFrame(doc);
  return (ms) => positionLabel(ms, fps, dropFrame);
}
function positionLabel(ms, fps, dropFrame) {
  if (fps === void 0) return `${ms} ms`;
  const family = isDropFrameFamily(fps);
  const df = family && (dropFrame ?? supportsDropFrame(fps));
  return `${msToTimecode(ms, family ? DROP_FRAME_FPS : fps, df)} (${ms} ms)`;
}
function durationLabel(ms, fps) {
  if (fps === void 0) return `${ms} ms`;
  const frames = durationFrames(ms, fps);
  return `${frames} ${frames === 1 ? "frame" : "frames"} (${ms} ms)`;
}

// src/core/qc/rules/durations.ts
var FIX_DURATION_FLOOR_MS = 833;
var FIX_GAP_FLOOR_MS = 100;
var minDuration = {
  id: "min-duration",
  fixable: true,
  evaluate(doc, config) {
    const fps = doc.metadata.frameRate;
    const out = [];
    for (const cue of doc.cues) {
      const dur = cue.endMs - cue.startMs;
      if (dur < 0) continue;
      if (dur < config.ms) {
        out.push({
          cueIndex: cue.index,
          message: `Duration ${durationLabel(dur, fps)} is below ${durationLabel(config.ms, fps)}.`
        });
      }
    }
    return out;
  },
  // Extend the end toward the next cue, stopping {@link FIX_GAP_FLOOR_MS} short
  // of its start so the extension cannot create an overlap or a new min-gap
  // violation. `Math.max` keeps the fix from ever shrinking the cue.
  fix(doc, config) {
    const cues = doc.cues.map((cue, i) => {
      const dur = cue.endMs - cue.startMs;
      if (dur < 0 || dur >= config.ms) return cue;
      const next = doc.cues[i + 1];
      const limit = next ? next.startMs - FIX_GAP_FLOOR_MS : Infinity;
      const endMs = Math.max(cue.endMs, Math.min(cue.startMs + config.ms, limit));
      return { ...cue, endMs };
    });
    return { ...doc, cues };
  }
};
var maxDuration = {
  id: "max-duration",
  fixable: true,
  evaluate(doc, config) {
    const fps = doc.metadata.frameRate;
    const out = [];
    for (const cue of doc.cues) {
      const dur = cue.endMs - cue.startMs;
      if (dur > config.ms) {
        out.push({
          cueIndex: cue.index,
          message: `Duration ${durationLabel(dur, fps)} exceeds ${durationLabel(config.ms, fps)}.`
        });
      }
    }
    return out;
  },
  // Trim the end so the cue is exactly the maximum length.
  fix(doc, config) {
    const cues = doc.cues.map(
      (cue) => cue.endMs - cue.startMs > config.ms ? { ...cue, endMs: cue.startMs + config.ms } : cue
    );
    return { ...doc, cues };
  }
};
function requiredGapMs(config, frameRate) {
  if (config.frames !== void 0 && frameRate) {
    return Math.round(config.frames / frameRate * 1e3);
  }
  return config.ms ?? 0;
}
var minGap = {
  id: "min-gap",
  fixable: true,
  evaluate(doc, config) {
    const fps = doc.metadata.frameRate;
    const required = requiredGapMs(config, fps);
    const out = [];
    for (let i = 0; i + 1 < doc.cues.length; i++) {
      const cur = doc.cues[i];
      const next = doc.cues[i + 1];
      const gap = next.startMs - cur.endMs;
      if (gap >= 0 && gap < required) {
        out.push({
          cueIndex: next.index,
          message: `Gap before this cue is ${durationLabel(gap, fps)}; minimum ${durationLabel(required, fps)}.`
        });
      }
    }
    return out;
  },
  // Create the gap without pushing either cue below {@link FIX_DURATION_FLOOR_MS}
  // (cue-forge-mz1: the old fix shortened the earlier cue below min-duration):
  // prefer moving the next cue's start forward, fall back to trimming the
  // earlier cue's end, otherwise decline and leave the pair flagged.
  // Overlapping pairs are left to the overlap fix.
  fix(doc, config) {
    const required = requiredGapMs(config, doc.metadata.frameRate);
    const cues = doc.cues.map((c) => ({ ...c }));
    for (let i = 0; i + 1 < cues.length; i++) {
      const cur = cues[i];
      const next = cues[i + 1];
      const gap = next.startMs - cur.endMs;
      if (gap < 0 || gap >= required) continue;
      const deficit = required - gap;
      if (next.endMs - (next.startMs + deficit) >= FIX_DURATION_FLOOR_MS) {
        next.startMs += deficit;
      } else if (next.startMs - required - cur.startMs >= FIX_DURATION_FLOOR_MS) {
        cur.endMs = next.startMs - required;
      }
    }
    return { ...doc, cues };
  }
};

// src/core/qc/rules/cps.ts
var FIX_MAX_DURATION_CEILING_MS = 7e3;
function inRanges(code, ranges) {
  for (const [lo, hi] of ranges) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}
function countedChars(text, ranges) {
  let n = 0;
  for (const ch of text) {
    if (ranges.length > 0 && inRanges(ch.codePointAt(0), ranges)) continue;
    n++;
  }
  return n;
}
function cueChars(cue, excludeLineBreaks, configRanges) {
  const ranges = [...BIDI_CONTROL_RANGES, ...configRanges];
  let chars = cue.lines.reduce((sum, line) => sum + countedChars(lineToText(line), ranges), 0);
  if (!excludeLineBreaks) chars += Math.max(0, cue.lines.length - 1);
  return chars;
}
var maxCps = {
  id: "max-cps",
  fixable: true,
  evaluate(doc, config) {
    const excludeLineBreaks = config.excludeLineBreaks ?? true;
    const ranges = config.excludeRanges ?? [];
    const out = [];
    for (const cue of doc.cues) {
      const durationSec = (cue.endMs - cue.startMs) / 1e3;
      if (durationSec <= 0) continue;
      const chars = cueChars(cue, excludeLineBreaks, ranges);
      const cps = chars / durationSec;
      if (cps > config.max) {
        out.push({
          cueIndex: cue.index,
          message: `Reading speed is ${cps.toFixed(1)} cps (max ${config.max}).`
        });
      }
    }
    return out;
  },
  // Extend the end to the duration needed for cps <= max, but only as far as the
  // gap and the max-duration ceiling allow; otherwise leave the cue flagged.
  fix(doc, config) {
    const excludeLineBreaks = config.excludeLineBreaks ?? true;
    const ranges = config.excludeRanges ?? [];
    const cues = doc.cues.map((cue, i) => {
      const durationSec = (cue.endMs - cue.startMs) / 1e3;
      if (durationSec <= 0) return cue;
      const chars = cueChars(cue, excludeLineBreaks, ranges);
      if (chars / durationSec <= config.max) return cue;
      const neededEnd = cue.startMs + Math.ceil(chars / config.max * 1e3);
      const next = doc.cues[i + 1];
      const limit = Math.min(
        next ? next.startMs - FIX_GAP_FLOOR_MS : Infinity,
        cue.startMs + FIX_MAX_DURATION_CEILING_MS
      );
      if (neededEnd <= cue.endMs || neededEnd > limit) return cue;
      return { ...cue, endMs: neededEnd };
    });
    return { ...doc, cues };
  }
};

// src/core/qc/rules/structural.ts
var overlap = {
  id: "overlap",
  fixable: true,
  evaluate(doc) {
    const position = positionLabelFor(doc);
    const out = [];
    for (let i = 0; i + 1 < doc.cues.length; i++) {
      const cur = doc.cues[i];
      const next = doc.cues[i + 1];
      if (next.startMs < cur.endMs) {
        out.push({
          cueIndex: next.index,
          message: `Overlaps the previous cue: starts ${position(next.startMs)}, previous ends ${position(cur.endMs)}.`
        });
      }
    }
    return out;
  },
  // Trim each earlier cue's end clear of the later cue's start, restoring the
  // conservative gap in the same move. When the trim would leave the cue below
  // the duration floor (the old clamp produced 0 ms cues, cue-forge-mz1), the
  // fix declines and the overlap stays flagged rather than trade it for a new
  // min-duration violation.
  fix(doc) {
    const cues = doc.cues.map((c) => ({ ...c }));
    for (let i = 0; i + 1 < cues.length; i++) {
      const cur = cues[i];
      const next = cues[i + 1];
      if (next.startMs >= cur.endMs) continue;
      const endMs = next.startMs - FIX_GAP_FLOOR_MS;
      if (endMs - cur.startMs >= FIX_DURATION_FLOOR_MS) cur.endMs = endMs;
    }
    return { ...doc, cues };
  }
};
var reversedTiming = {
  id: "reversed-timing",
  fixable: true,
  evaluate(doc) {
    const position = positionLabelFor(doc);
    const out = [];
    for (const cue of doc.cues) {
      if (cue.endMs < cue.startMs) {
        out.push({
          cueIndex: cue.index,
          message: `End ${position(cue.endMs)} is before start ${position(cue.startMs)}.`
        });
      }
    }
    return out;
  },
  // Swap the reversed start and end.
  fix(doc) {
    const cues = doc.cues.map(
      (cue) => cue.endMs < cue.startMs ? { ...cue, startMs: cue.endMs, endMs: cue.startMs } : cue
    );
    return { ...doc, cues };
  }
};
var emptyCue = {
  id: "empty-cue",
  fixable: true,
  evaluate(doc) {
    const out = [];
    for (const cue of doc.cues) {
      if (cueToText(cue).trim() === "") {
        out.push({ cueIndex: cue.index, message: "Cue has no text." });
      }
    }
    return out;
  },
  // Drop empty cues and renumber the survivors so indices stay contiguous.
  fix(doc) {
    const cues = doc.cues.filter((cue) => cueToText(cue).trim() !== "").map((cue, i) => ({ ...cue, index: i + 1 }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/duplicate.ts
var duplicateCue = {
  id: "duplicate-cue",
  fixable: false,
  evaluate(doc) {
    const out = [];
    for (let i = 1; i < doc.cues.length; i++) {
      const prev = cueToText(doc.cues[i - 1]).trim();
      const cur = cueToText(doc.cues[i]).trim();
      if (cur !== "" && cur === prev) {
        out.push({ cueIndex: doc.cues[i].index, message: "Repeats the previous cue\u2019s text." });
      }
    }
    return out;
  }
};

// src/core/qc/rules/forbidden.ts
function describeToken(token) {
  if (token === "	") return "a tab";
  if (token === "  ") return "a double space";
  if (/^\s+$/.test(token)) return "whitespace";
  return `"${token}"`;
}
var forbiddenCharacters = {
  id: "forbidden-characters",
  fixable: true,
  evaluate(doc, config) {
    const chars = config.chars ?? [];
    const patterns = config.patterns ?? [];
    if (chars.length === 0 && patterns.length === 0) return [];
    const out = [];
    for (const cue of doc.cues) {
      const text = cueToText(cue);
      for (const token of [...chars, ...patterns]) {
        if (token !== "" && text.includes(token)) {
          out.push({ cueIndex: cue.index, message: `Contains ${describeToken(token)}.` });
        }
      }
    }
    return out;
  },
  // Remove forbidden chars; collapse whitespace patterns to a single space,
  // remove other patterns outright. Applied per span to keep styling.
  fix(doc, config) {
    const chars = config.chars ?? [];
    const patterns = config.patterns ?? [];
    if (chars.length === 0 && patterns.length === 0) return doc;
    const scrub = (text) => {
      let t = text;
      for (const ch of chars) if (ch !== "") t = t.split(ch).join("");
      for (const p of patterns) {
        if (p === "") continue;
        t = /^\s+$/.test(p) ? t.split(p).join(" ").replace(/ {2,}/g, " ") : t.split(p).join("");
      }
      return t;
    };
    const cues = doc.cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map((line) => ({
        spans: line.spans.map((s) => ({ ...s, text: scrub(s.text) }))
      }))
    }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/punctuation.ts
var CLAUSE_PUNCT = ".,!?;:";
var isLetter = (c) => c !== void 0 && new RegExp("\\p{L}", "u").test(c);
function isExemptDot(text, i) {
  if (text[i] !== ".") return false;
  if (text[i - 1] === "." || text[i + 1] === ".") return true;
  const prev = text[i - 1];
  const next = text[i + 1];
  if (isLetter(prev) && next !== void 0 && new RegExp("\\p{Ll}", "u").test(next)) return true;
  if (isLetter(prev) && !isLetter(text[i - 2])) return true;
  return false;
}
function hasPunctuationSpacingIssue(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      const nn = text[i + 1];
      if (nn !== void 0 && CLAUSE_PUNCT.includes(nn) && !isExemptDot(text, i + 1)) return true;
      continue;
    }
    if (!CLAUSE_PUNCT.includes(c) || isExemptDot(text, i)) continue;
    if (isLetter(text[i + 1])) return true;
  }
  return false;
}
function fixPunctuationSpacingText(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " " || c === "	") {
      let j = i;
      while (text[j] === " " || text[j] === "	") j++;
      const nn = text[j];
      if (nn !== void 0 && CLAUSE_PUNCT.includes(nn) && !isExemptDot(text, j)) {
        i = j - 1;
        continue;
      }
      out += c;
      continue;
    }
    out += c;
    if (CLAUSE_PUNCT.includes(c) && !isExemptDot(text, i) && isLetter(text[i + 1])) out += " ";
  }
  return out;
}
function fixLine(line) {
  if (!hasPunctuationSpacingIssue(lineToText(line))) return line;
  const out = [];
  for (const span of line.spans) {
    let text = fixPunctuationSpacingText(span.text);
    while (out.length > 0 && /^[.,!?;:]/.test(text) && /[ \t]$/.test(out[out.length - 1].text)) {
      const prev2 = out[out.length - 1];
      prev2.text = prev2.text.replace(/[ \t]+$/, "");
      if (prev2.text === "") out.pop();
    }
    const prev = out[out.length - 1];
    if (prev !== void 0 && /[.,!?;:]$/.test(prev.text) && new RegExp("^\\p{L}", "u").test(text) && !isExemptDot(prev.text + text, prev.text.length - 1)) {
      text = " " + text;
    }
    if (text !== "") out.push({ ...span, text });
  }
  return { spans: out };
}
var punctuationSpacing = {
  id: "punctuation-spacing",
  fixable: true,
  evaluate(doc) {
    const out = [];
    for (const cue of doc.cues) {
      if (cue.lines.some((line) => hasPunctuationSpacingIssue(lineToText(line)))) {
        out.push({ cueIndex: cue.index, message: "Incorrect spacing around punctuation." });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({ ...cue, lines: cue.lines.map(fixLine) }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/tags.ts
var unclosedTag = {
  id: "unclosed-tag",
  fixable: true,
  evaluate(doc) {
    const out = [];
    for (const cue of doc.cues) {
      const { warnings } = parseInline(cueToText(cue));
      if (warnings.some((w) => w.code === "unclosed-tag")) {
        out.push({ cueIndex: cue.index, message: "Contains an unclosed formatting tag." });
      }
    }
    return out;
  },
  // Serialize the structured spans back to markup (cueToText would silently drop
  // their style flags, cue-forge-lnj), then re-parse: existing styling survives
  // and the balance pass turns an unclosed opener into styling that runs to the
  // end of the cue. Cues carrying opaque markup (preserved VTT constructs) use
  // VTT mode for the round-trip — default mode would silently drop the opaque
  // spans. VTT mode only when needed: it escapes `&`/`<`, which would corrupt
  // plain SRT text (and turn the literal unclosed tag into escaped text, so for
  // opaque cues the fix declines and the issue stays flagged).
  fix(doc) {
    const cues = doc.cues.map((cue) => {
      const vtt = cue.lines.some((l) => l.spans.some((s) => s.opaque !== void 0));
      const opts = { vtt };
      const { warnings, lines } = parseStyledLines(serializeStyledLines(cue.lines, opts), opts);
      return warnings.some((w) => w.code === "unclosed-tag") ? { ...cue, lines } : cue;
    });
    return { ...doc, cues };
  }
};

// src/core/qc/rules/monotonic.ts
var cueCountMonotonicTiming = {
  id: "cue-count-monotonic-timing",
  fixable: false,
  evaluate(doc) {
    const position = positionLabelFor(doc);
    const out = [];
    for (let i = 1; i < doc.cues.length; i++) {
      const prev = doc.cues[i - 1];
      const cur = doc.cues[i];
      if (cur.startMs < prev.startMs) {
        out.push({
          cueIndex: cur.index,
          message: `Starts at ${position(cur.startMs)}, before the previous cue's start ${position(prev.startMs)}.`
        });
      }
    }
    return out;
  }
};

// src/core/qc/rules/bidi-punctuation.ts
var SENTENCE_PUNCT = /* @__PURE__ */ new Set([...".!?:;\u060C\u061B\u061F\u2026"]);
function lastContentIndex(chars) {
  let i = chars.length - 1;
  while (i >= 0 && /\s/.test(chars[i])) i--;
  return i;
}
function hasBidiPunctuationIssue(text) {
  if (!hasRtl(text)) return false;
  const chars = [...text];
  const i = lastContentIndex(chars);
  if (i < 0) return false;
  if (chars[i] === RLM) return false;
  return SENTENCE_PUNCT.has(chars[i]);
}
function fixLine2(line) {
  if (!hasBidiPunctuationIssue(lineToText(line))) return line;
  const spans = line.spans.map((s) => ({ ...s }));
  const last = spans[spans.length - 1];
  if (last) last.text += RLM;
  return { spans };
}
var bidiPunctuation = {
  id: "bidi-punctuation",
  fixable: true,
  evaluate(doc) {
    const out = [];
    for (const cue of doc.cues) {
      if (cue.lines.some((line) => hasBidiPunctuationIssue(lineToText(line)))) {
        out.push({
          cueIndex: cue.index,
          message: "Sentence-final punctuation may render on the wrong side without a right-to-left mark (RLM)."
        });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({ ...cue, lines: cue.lines.map(fixLine2) }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/digits.ts
function countByStyle(text) {
  const counts = /* @__PURE__ */ new Map();
  for (const ch of text) {
    const style = digitStyle(ch.codePointAt(0));
    if (style) counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  return counts;
}
function dominantStyle(counts) {
  let best = null;
  let bestN = 0;
  for (const [style, n] of counts) {
    if (n > bestN) {
      best = style;
      bestN = n;
    }
  }
  return best;
}
function convertLine(line, target) {
  return { spans: line.spans.map((s) => ({ ...s, text: convertDigits(s.text, target) })) };
}
var mixedDigitStyle = {
  id: "mixed-digit-style",
  fixable: true,
  evaluate(doc) {
    const docCounts = countByStyle(doc.cues.map(cueToText).join("\n"));
    if (docCounts.size < 2) return [];
    const dominant = dominantStyle(docCounts);
    const out = [];
    for (const cue of doc.cues) {
      const cueText = cue.lines.map(lineToText).join("\n");
      const hasOffStyle = [...cueText].some((ch) => {
        const style = digitStyle(ch.codePointAt(0));
        return style !== null && style !== dominant;
      });
      if (hasOffStyle) {
        out.push({ cueIndex: cue.index, message: "Cue mixes Western and Arabic-Indic digits." });
      }
    }
    return out;
  },
  fix(doc, config) {
    const target = config.style ?? "western";
    const cues = doc.cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map((line) => convertLine(line, target))
    }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/latin-isolation.ts
var RUN = String.raw`(?:\p{Script=Latin}|[0-9])`;
var LATIN_RUN_RE = new RegExp(`${RUN}(?:[.'\u2019&:/-]?${RUN})*`, "gu");
function isolateLatinRuns(text) {
  return text.replace(LATIN_RUN_RE, (m, offset) => {
    const left = text[offset - 1] === LRM ? "" : LRM;
    const right = text[offset + m.length] === LRM ? "" : LRM;
    return left + m + right;
  });
}
function lineNeedsIsolation(line) {
  if (!hasRtl(lineToText(line))) return false;
  return line.spans.some((s) => isolateLatinRuns(s.text) !== s.text);
}
var latinRunIsolation = {
  id: "latin-run-isolation",
  fixable: true,
  evaluate(doc) {
    const out = [];
    for (const cue of doc.cues) {
      if (cue.lines.some(lineNeedsIsolation)) {
        out.push({
          cueIndex: cue.index,
          message: "Latin text inside an RTL line is not isolated with a left-to-right mark (LRM)."
        });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({
      ...cue,
      lines: cue.lines.map(
        (line) => hasRtl(lineToText(line)) ? { spans: line.spans.map((s) => ({ ...s, text: isolateLatinRuns(s.text) })) } : line
      )
    }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/arabic-length.ts
var arabicLineLength = {
  id: "arabic-line-length",
  fixable: false,
  evaluate(doc, config) {
    const out = [];
    for (const cue of doc.cues) {
      cue.lines.forEach((line, i) => {
        const len = visibleLength(lineToText(line));
        if (len > config.max) {
          out.push({
            cueIndex: cue.index,
            message: `Line ${i + 1} is ${len} characters (max ${config.max}).`
          });
        }
      });
    }
    return out;
  }
};

// src/core/qc/rules/kashida.ts
function lineHasTatweel(line) {
  return [...lineToText(line)].some((ch) => isTatweel(ch.codePointAt(0)));
}
function stripLine(line) {
  return { spans: line.spans.map((s) => ({ ...s, text: stripTatweel(s.text) })) };
}
var kashidaStrip = {
  id: "kashida-strip",
  fixable: true,
  evaluate(doc) {
    const out = [];
    for (const cue of doc.cues) {
      if (cue.lines.some(lineHasTatweel)) {
        out.push({ cueIndex: cue.index, message: "Text contains tatweel (kashida) padding." });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({ ...cue, lines: cue.lines.map(stripLine) }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/ellipsis.ts
var ASCII_ELLIPSIS = /\.{3,}/;
function hasAsciiEllipsis(text) {
  return ASCII_ELLIPSIS.test(text);
}
function fixLine3(line) {
  if (!hasAsciiEllipsis(lineToText(line))) return line;
  const chars = [];
  line.spans.forEach((span, i) => {
    for (const ch of span.text) chars.push({ ch, span: i });
  });
  const kept = [];
  for (let i = 0; i < chars.length; ) {
    if (chars[i].ch !== ".") {
      kept.push(chars[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && chars[j].ch === ".") j++;
    if (j - i >= 3) kept.push({ ch: "\u2026", span: chars[i].span });
    else for (let k = i; k < j; k++) kept.push(chars[k]);
    i = j;
  }
  const spans = [];
  let cur = -1;
  for (const { ch, span } of kept) {
    if (span === cur) spans[spans.length - 1].text += ch;
    else {
      spans.push({ ...line.spans[span], text: ch });
      cur = span;
    }
  }
  return { spans };
}
var ellipsisStyle = {
  id: "ellipsis-style",
  fixable: true,
  evaluate(doc) {
    const out = [];
    for (const cue of doc.cues) {
      if (cue.lines.some((line) => hasAsciiEllipsis(lineToText(line)))) {
        out.push({
          cueIndex: cue.index,
          message: "Use the ellipsis character (\u2026) instead of three dots."
        });
      }
    }
    return out;
  },
  fix(doc) {
    const cues = doc.cues.map((cue) => ({ ...cue, lines: cue.lines.map(fixLine3) }));
    return { ...doc, cues };
  }
};

// src/core/qc/rules/index.ts
var defs = [
  maxCharsPerLine,
  maxLinesPerCue,
  maxCps,
  minDuration,
  maxDuration,
  minGap,
  overlap,
  reversedTiming,
  emptyCue,
  duplicateCue,
  forbiddenCharacters,
  punctuationSpacing,
  unclosedTag,
  cueCountMonotonicTiming,
  bidiPunctuation,
  mixedDigitStyle,
  latinRunIsolation,
  arabicLineLength,
  kashidaStrip,
  ellipsisStyle
];
var catalog = Object.fromEntries(defs.map((d) => [d.id, d]));
var missing = RULE_IDS.filter((id) => !(id in catalog));
if (missing.length > 0) {
  throw new Error(`QC rule catalog is missing: ${missing.join(", ")}`);
}
var RULES = catalog;

// src/core/qc/evaluate.ts
function isVisibleCue(cue) {
  if (cue.raw === null || typeof cue.raw !== "object" || !("kind" in cue.raw)) return true;
  const kind = cue.raw.kind;
  return typeof kind !== "string" || kind === "Dialogue";
}
function evaluate(doc, ruleset, registry = RULES) {
  const issues = [];
  const visible = doc.cues.filter(isVisibleCue);
  if (visible.length !== doc.cues.length) doc = { ...doc, cues: visible };
  for (const [id, config] of Object.entries(ruleset.rules)) {
    if (config === void 0 || config.enabled === false) continue;
    const def = registry[id];
    if (def === void 0) continue;
    const violations = def.evaluate(
      doc,
      config
    );
    const inContext = def.fixable && def.fixableInContext !== void 0 ? def.fixableInContext(doc, ruleset) : null;
    for (const v of violations) {
      const issue = {
        ruleId: id,
        cueIndex: v.cueIndex,
        severity: config.severity,
        message: v.message,
        fixable: def.fixable
      };
      if (inContext) issue.effectivelyFixable = inContext(v);
      issues.push(issue);
    }
  }
  return issues.sort((a, b) => a.cueIndex - b.cueIndex);
}

// src/core/qc/reconcile.ts
function resolvedIssues(before, after, beforeKey, afterKey = beforeKey) {
  const counts = /* @__PURE__ */ new Map();
  const exactCounts = /* @__PURE__ */ new Map();
  for (const issue of after) {
    const key = afterKey(issue);
    const exact = JSON.stringify([key, issue.message]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    exactCounts.set(exact, (exactCounts.get(exact) ?? 0) + 1);
  }
  const unmatched = before.filter((issue) => {
    const key = beforeKey(issue);
    const exact = JSON.stringify([key, issue.message]);
    const count = exactCounts.get(exact) ?? 0;
    if (count === 0) return true;
    exactCounts.set(exact, count - 1);
    counts.set(key, counts.get(key) - 1);
    return false;
  });
  return unmatched.filter((issue) => {
    const key = beforeKey(issue);
    const count = counts.get(key) ?? 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
}

// src/core/qc/autofix.ts
function issueCounts(doc, issues) {
  const identities = new Map(doc.cues.map((cue) => [cue.index, cue[cueIdentity]]));
  const counts = /* @__PURE__ */ new Map();
  for (const issue of issues) {
    const identity = identities.get(issue.cueIndex) ?? "document";
    for (const key of [issue.ruleId, `${issue.ruleId}:${identity}`]) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
function introducesNewIssue(before, after) {
  for (const [key, count] of after) {
    if (count > (before.get(key) ?? 0)) return true;
  }
  return false;
}
var cueIdentity = /* @__PURE__ */ Symbol("autoFixCue");
function mergeCandidate(current, candidate, protectedIdentities) {
  const visibleIdentities = new Set(
    current.cues.filter(isVisibleCue).map((cue) => cue[cueIdentity])
  );
  const replacements = /* @__PURE__ */ new Map();
  for (const cue of candidate.cues) {
    const identity = cue[cueIdentity];
    if (identity === void 0 || !visibleIdentities.has(identity) || replacements.has(identity)) {
      return null;
    }
    replacements.set(identity, cue);
  }
  const cues = [];
  for (const cue of current.cues) {
    const identity = cue[cueIdentity];
    const restored = !isVisibleCue(cue) || protectedIdentities.has(identity) ? cue : replacements.get(identity);
    if (restored !== void 0) {
      const index = cues.length + 1;
      cues.push(restored.index === index ? restored : { ...restored, index });
    }
  }
  return { ...candidate, cues };
}
function autoFix(doc, issues, options, registry = RULES) {
  const allow = options.enabled ? new Set(options.enabled) : null;
  const fixed = [];
  const unfixable = [];
  const protectedIdentities = /* @__PURE__ */ new Set();
  const originalIdentities = /* @__PURE__ */ new Map();
  const tracked = doc.cues.map((cue, identity) => {
    if (options.protect?.has(cue)) protectedIdentities.add(identity);
    originalIdentities.set(cue.index, identity);
    return { ...cue, [cueIdentity]: identity };
  });
  let current = { ...doc, cues: tracked };
  const baseline = evaluate(current, options.ruleset, registry);
  let remaining = baseline;
  let known = issueCounts(current, baseline);
  for (const id of RULE_IDS) {
    const ruleIssues = issues.filter((i) => i.ruleId === id);
    if (ruleIssues.length === 0) continue;
    const def = registry[id];
    const config = options.ruleset.rules[id];
    const toggledOn = allow === null || allow.has(id);
    const canFix = def?.fix !== void 0 && config !== void 0 && def.fixable && toggledOn;
    if (!canFix) {
      continue;
    }
    const visible = { ...current, cues: current.cues.filter(isVisibleCue) };
    let proposed;
    if (def.fixCue !== void 0) {
      const targets = new Set(ruleIssues.map((issue) => originalIdentities.get(issue.cueIndex)));
      const fixOneCue = (cue) => def.fixCue(cue, config);
      proposed = {
        ...visible,
        cues: visible.cues.map((cue) => {
          const identity = cue[cueIdentity];
          return targets.has(identity) && !protectedIdentities.has(identity) ? fixOneCue(cue) : cue;
        })
      };
    } else {
      proposed = def.fix(visible, config);
    }
    const candidate = mergeCandidate(current, proposed, protectedIdentities);
    if (candidate === null) {
      continue;
    }
    const after = evaluate(candidate, options.ruleset, registry);
    const afterCounts = issueCounts(candidate, after);
    if (introducesNewIssue(known, afterCounts)) {
      continue;
    }
    current = candidate;
    known = afterCounts;
    remaining = after;
  }
  const currentIdentities = new Map(
    current.cues.map((cue) => [cue.index, cue[cueIdentity]])
  );
  const beforeKey = (issue) => `${issue.ruleId}:${originalIdentities.get(issue.cueIndex) ?? "document"}`;
  const afterKey = (issue) => `${issue.ruleId}:${currentIdentities.get(issue.cueIndex) ?? "document"}`;
  const resolved = resolvedIssues(baseline, remaining, beforeKey, afterKey);
  const resolvedCounts = /* @__PURE__ */ new Map();
  const exactKey = (issue) => JSON.stringify([beforeKey(issue), issue.message]);
  const baselineKeys = new Set(baseline.map(exactKey));
  const resolvedExactCounts = /* @__PURE__ */ new Map();
  for (const issue of resolved) {
    const key = beforeKey(issue);
    resolvedCounts.set(key, (resolvedCounts.get(key) ?? 0) + 1);
    const exact = exactKey(issue);
    resolvedExactCounts.set(exact, (resolvedExactCounts.get(exact) ?? 0) + 1);
  }
  for (const issue of issues) {
    const key = beforeKey(issue);
    const count = resolvedCounts.get(key) ?? 0;
    const exact = exactKey(issue);
    const exactCount = resolvedExactCounts.get(exact) ?? 0;
    if (count > 0 && (exactCount > 0 || !baselineKeys.has(exact))) {
      fixed.push(issue);
      resolvedCounts.set(key, count - 1);
      if (exactCount > 0) resolvedExactCounts.set(exact, exactCount - 1);
    } else {
      unfixable.push(issue);
    }
  }
  const cues = current.cues.map((cue) => {
    const identity = cue[cueIdentity];
    if (cue === tracked[identity]) return doc.cues[identity];
    const clean = { ...cue };
    delete clean[cueIdentity];
    return clean;
  });
  const output = { ...current, cues };
  const changed = JSON.stringify(output) !== JSON.stringify(doc);
  return { doc: changed ? output : doc, fixed, unfixable, resolvedCount: resolved.length, changed };
}

// src/core/qc/presets/generic.json
var generic_default = {
  name: "generic",
  verified: false,
  rules: {
    "max-chars-per-line": { enabled: true, severity: "warning", max: 45 },
    "max-lines-per-cue": { enabled: true, severity: "warning", max: 2 },
    "max-cps": { enabled: true, severity: "warning", max: 21, excludeLineBreaks: true },
    "min-duration": { enabled: true, severity: "warning", ms: 700 },
    "max-duration": { enabled: true, severity: "warning", ms: 8e3 },
    "min-gap": { enabled: true, severity: "warning", ms: 0 },
    overlap: { enabled: true, severity: "error" },
    "reversed-timing": { enabled: true, severity: "error" },
    "empty-cue": { enabled: true, severity: "error" },
    "duplicate-cue": { enabled: true, severity: "warning" },
    "forbidden-characters": {
      enabled: true,
      severity: "warning",
      chars: ["	"],
      patterns: ["  "]
    },
    "punctuation-spacing": { enabled: true, severity: "warning" },
    "unclosed-tag": { enabled: true, severity: "error" },
    "cue-count-monotonic-timing": { enabled: true, severity: "error" }
  }
};

// src/core/qc/presets/netflix-latin.json
var netflix_latin_default = {
  name: "netflix-latin",
  verified: true,
  reference: "https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide",
  rules: {
    "max-chars-per-line": { enabled: true, severity: "warning", max: 42 },
    "max-lines-per-cue": { enabled: true, severity: "warning", max: 2 },
    "max-cps": { enabled: true, severity: "warning", max: 20, excludeLineBreaks: true },
    "min-duration": { enabled: true, severity: "warning", ms: 833 },
    "max-duration": { enabled: true, severity: "warning", ms: 7e3 },
    "min-gap": { enabled: true, severity: "warning", frames: 2, ms: 83 },
    overlap: { enabled: true, severity: "error" },
    "reversed-timing": { enabled: true, severity: "error" },
    "empty-cue": { enabled: true, severity: "error" },
    "duplicate-cue": { enabled: true, severity: "warning" },
    "forbidden-characters": {
      enabled: true,
      severity: "warning",
      chars: ["	"],
      patterns: ["  "]
    },
    "punctuation-spacing": { enabled: true, severity: "warning" },
    "unclosed-tag": { enabled: true, severity: "error" },
    "cue-count-monotonic-timing": { enabled: true, severity: "error" },
    "ellipsis-style": { enabled: true, severity: "warning" }
  }
};

// src/core/qc/presets/youtube.json
var youtube_default = {
  name: "youtube",
  verified: false,
  reference: "https://support.google.com/youtube/answer/2734698",
  rules: {
    "max-chars-per-line": { enabled: true, severity: "warning", max: 60 },
    "max-lines-per-cue": { enabled: true, severity: "warning", max: 2 },
    "max-cps": { enabled: true, severity: "warning", max: 25, excludeLineBreaks: true },
    "min-duration": { enabled: true, severity: "warning", ms: 500 },
    "max-duration": { enabled: true, severity: "warning", ms: 1e4 },
    "min-gap": { enabled: true, severity: "warning", ms: 0 },
    overlap: { enabled: true, severity: "error" },
    "reversed-timing": { enabled: true, severity: "error" },
    "empty-cue": { enabled: true, severity: "error" },
    "duplicate-cue": { enabled: true, severity: "warning" },
    "forbidden-characters": {
      enabled: true,
      severity: "warning",
      chars: ["	"],
      patterns: ["  "]
    },
    "punctuation-spacing": { enabled: true, severity: "warning" },
    "unclosed-tag": { enabled: true, severity: "error" },
    "cue-count-monotonic-timing": { enabled: true, severity: "error" }
  }
};

// src/core/qc/presets/netflix-arabic.json
var netflix_arabic_default = {
  name: "netflix-arabic",
  verified: true,
  reference: "https://partnerhelp.netflixstudios.com/hc/en-us/articles/215517947-Arabic-Timed-Text-Style-Guide",
  rules: {
    "max-chars-per-line": { enabled: false, severity: "warning", max: 42 },
    "arabic-line-length": { enabled: true, severity: "warning", max: 42 },
    "max-lines-per-cue": { enabled: true, severity: "warning", max: 2 },
    "max-cps": {
      enabled: true,
      severity: "warning",
      max: 20,
      excludeLineBreaks: true,
      excludeRanges: [[1611, 1631]]
    },
    "min-duration": { enabled: true, severity: "warning", ms: 833 },
    "max-duration": { enabled: true, severity: "warning", ms: 7e3 },
    "min-gap": { enabled: true, severity: "warning", frames: 2, ms: 83 },
    overlap: { enabled: true, severity: "error" },
    "reversed-timing": { enabled: true, severity: "error" },
    "empty-cue": { enabled: true, severity: "error" },
    "duplicate-cue": { enabled: true, severity: "warning" },
    "forbidden-characters": {
      enabled: true,
      severity: "warning",
      chars: ["	"],
      patterns: ["  "]
    },
    "punctuation-spacing": { enabled: false, severity: "warning" },
    "unclosed-tag": { enabled: true, severity: "error" },
    "cue-count-monotonic-timing": { enabled: true, severity: "error" },
    "bidi-punctuation": { enabled: true, severity: "warning" },
    "mixed-digit-style": { enabled: true, severity: "warning", style: "arabic-indic" },
    "latin-run-isolation": { enabled: true, severity: "warning" },
    "kashida-strip": { enabled: true, severity: "warning" },
    "ellipsis-style": { enabled: true, severity: "warning" }
  }
};

// src/core/qc/presets/index.ts
var PRESETS = {
  generic: parseRuleset(generic_default),
  "netflix-latin": parseRuleset(netflix_latin_default),
  youtube: parseRuleset(youtube_default),
  "netflix-arabic": parseRuleset(netflix_arabic_default)
};
var DEFAULT_PRESET = "generic";

// src/cli/cli.ts
var VERSION = "0.1.0";
function nodeIo(stdout, stderr) {
  return {
    readFile: (path) => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
    exists: (path) => access(path).then(
      () => true,
      () => false
    ),
    cwd: () => process.cwd(),
    stdout,
    stderr
  };
}
var FORMATS = [
  ...TEXT_FORMAT_IDS.map((id) => ({ ...TEXT_FORMATS[id], id, kind: "text", read: "yes" })),
  // IMSC files are TTML documents: detectImportFormat reads them as `ttml`.
  ...PRO_FORMATS.map((f) => ({
    ...f,
    read: f.id === "imsc101" || f.id === "imsc11" ? "as ttml" : "yes"
  }))
];
var HELP = `Usage: cueforge <command> [options]

Convert, check and fix subtitle files locally. Nothing is uploaded.

Commands:
  convert <input> --to <format> [-o <output>]
      Convert to another format. Default output: <name>.<target ext> next to the input.
  qc <input> [--preset <name|ruleset.json>] [--json]
      Check against a QC preset (default: ${DEFAULT_PRESET}). --json prints one object:
      { file, format, preset, presetBuiltin, presetVerified, cueCount,
        counts: { error, warning },
        issues: [{ ruleId, cueIndex, severity, message, fixable }] }
  fix <input> [--preset <name|ruleset.json>] [-o <output>]
      Auto-fix QC issues and write the source format. Default output: <name>.fixed.<ext>
  shift <input> --ms <integer> [-o <output>]
      Move every cue by a signed number of milliseconds. Default output: <name>.shifted.<ext>
  formats    List formats: id, name, extensions, text/binary, read, write
  presets    List built-in QC presets (Verified or Draft)

Options:
  -o, --output <path>  Output file path
  --force              Overwrite an existing output file
  -h, --help           Show this help
  -v, --version        Show the version

Results and written paths go to stdout; warnings go to stderr.
Exit codes: 0 ok, 1 qc found an error-severity issue, 2 usage or input error.`;
var OPTIONS = {
  to: { type: "string" },
  output: { type: "string", short: "o" },
  preset: { type: "string" },
  json: { type: "boolean" },
  ms: { type: "string" },
  force: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" }
};
var COMMANDS = {
  convert: { input: true, flags: ["to", "output", "force"] },
  qc: { input: true, flags: ["preset", "json"] },
  fix: { input: true, flags: ["preset", "output", "force"] },
  shift: { input: true, flags: ["ms", "output", "force"] },
  formats: { input: false, flags: [] },
  presets: { input: false, flags: [] }
};
var CliError = class extends Error {
};
function usage(message) {
  return new CliError(`${message}
Run "cueforge --help" for usage.`);
}
var errorText = (err) => err instanceof Error ? err.message : String(err);
async function run(argv, io) {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    io.stderr(`error: ${errorText(err)}`);
    return 2;
  }
}
function joinNegativeMs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--ms" && next !== void 0 && /^-\d/.test(next)) {
      out.push(`--ms=${next}`);
      i++;
    } else {
      out.push(argv[i]);
    }
  }
  return out;
}
async function dispatch(argv, io) {
  let parsed;
  try {
    parsed = parseArgs({
      args: joinNegativeMs(argv),
      options: OPTIONS,
      allowPositionals: true,
      strict: true
    });
  } catch (err) {
    throw usage(errorText(err));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout(VERSION);
    return 0;
  }
  const [command, ...args] = positionals;
  if (command === void 0) {
    io.stderr(HELP);
    return 2;
  }
  const spec = COMMANDS[command];
  if (spec === void 0) throw usage(`Unknown command "${command}".`);
  for (const key of Object.keys(values)) {
    if (!spec.flags.includes(key)) throw usage(`--${key} is not valid for "${command}".`);
  }
  const [input, ...extra] = args;
  if (spec.input && input === void 0) throw usage(`"${command}" needs an <input> file.`);
  const unexpected = spec.input ? extra : args;
  if (unexpected.length > 0) throw usage(`Unexpected argument "${unexpected[0]}".`);
  const output = { path: values.output, force: values.force === true };
  switch (command) {
    case "formats":
      io.stdout("id	name	extensions	kind	read	write");
      for (const f of FORMATS) {
        io.stdout([f.id, f.name, f.extensions.join(","), f.kind, f.read, "yes"].join("	"));
      }
      return 0;
    case "presets":
      for (const [name, ruleset] of Object.entries(PRESETS)) {
        io.stdout(`${name}	${ruleset.verified ? "Verified" : "Draft"}`);
      }
      return 0;
    case "convert": {
      if (values.to === void 0) throw usage('"convert" needs --to <format>.');
      const target = parseFormat(values.to);
      const loaded = await load(input, io);
      await save(io, loaded, target, output, defaultPath(input, "", primaryExt(target)));
      return 0;
    }
    case "shift": {
      if (values.ms === void 0) throw usage('"shift" needs --ms <integer>.');
      if (!/^[+-]?\d+$/.test(values.ms) || !Number.isSafeInteger(Number(values.ms))) {
        throw usage(`--ms must be a whole number of milliseconds, got "${values.ms}".`);
      }
      const ms = Number(values.ms);
      const loaded = await load(input, io);
      const clamped = loaded.doc.cues.filter((c) => c.startMs + ms < 0).length;
      if (clamped > 0) {
        io.stderr(`warning: ${clamped} cue(s) would start before 00:00:00 and were clamped to 0.`);
      }
      const shifted = { ...loaded, doc: shiftCues(loaded.doc, ms) };
      await save(
        io,
        shifted,
        loaded.sourceFormat,
        output,
        sameFormatPath(input, ".shifted", loaded)
      );
      return 0;
    }
    case "qc": {
      const { name, ruleset, builtin } = await loadRuleset(values.preset, io);
      const loaded = await load(input, io);
      const report = qcReport(
        input,
        loaded,
        name,
        builtin,
        ruleset,
        evaluate(loaded.doc, ruleset)
      );
      if (values.json) {
        io.stdout(JSON.stringify(report));
      } else {
        io.stdout(
          `${report.file}: ${report.format}, ${report.cueCount} cues, ${presetLabel(report, values.preset)}: ${counted(report.counts)}`
        );
        for (const i of report.issues) {
          const where = i.cueIndex < 0 ? "document" : `cue ${i.cueIndex}`;
          io.stdout(
            `  ${where}	${i.severity}	${i.ruleId}	${i.message}${i.fixable ? " [fixable]" : ""}`
          );
        }
      }
      return report.counts.error > 0 ? 1 : 0;
    }
    case "fix": {
      const { ruleset } = await loadRuleset(values.preset, io);
      const loaded = await load(input, io);
      const result = autoFix(loaded.doc, evaluate(loaded.doc, ruleset), { ruleset });
      const remaining = severityCounts(evaluate(result.doc, ruleset));
      const fixed = { ...loaded, doc: result.doc };
      await save(io, fixed, loaded.sourceFormat, output, sameFormatPath(input, ".fixed", loaded));
      const n = result.resolvedCount;
      io.stdout(
        `Resolved ${n} issue${n === 1 ? "" : "s"}, ${remaining.error + remaining.warning} remaining (${counted(remaining)}).`
      );
      return 0;
    }
  }
  throw new CliError(`Unhandled command "${command}".`);
}
function presetLabel(report, spec) {
  return report.presetBuiltin ? `preset ${report.preset} (${report.presetVerified ? "Verified" : "Draft"})` : `custom preset "${report.preset}" from ${spec} (Draft)`;
}
function parseFormat(value) {
  const id = value.toLowerCase();
  const found = FORMATS.find((f) => f.id === id);
  if (!found) {
    throw usage(`Unknown format "${value}". Formats: ${FORMATS.map((f) => f.id).join(", ")}.`);
  }
  return found.id;
}
function primaryExt(id) {
  return FORMATS.find((f) => f.id === id)?.extensions[0] ?? `.${id}`;
}
function defaultPath(input, suffix, ext) {
  return join(dirname(input), basename(input, extname(input)) + suffix + ext);
}
function sameFormatPath(input, suffix, loaded) {
  return defaultPath(input, suffix, extname(input) || primaryExt(loaded.sourceFormat));
}
function warn(io, warnings) {
  for (const w of warnings) io.stderr(`warning: ${w.message}`);
}
async function load(path, io) {
  let bytes;
  try {
    bytes = await io.readFile(path);
  } catch (err) {
    throw new CliError(`Cannot read "${path}": ${errorText(err)}`);
  }
  let loaded;
  try {
    loaded = await importFile(basename(path), bytes, { allowPro: true });
  } catch (err) {
    const message = friendlyLoadError(err, path);
    if (err instanceof UnknownFormatError) {
      const exts = [...new Set(FORMATS.flatMap((f) => f.extensions))].join(", ");
      throw new CliError(
        `Unrecognized subtitle format for "${basename(path)}". Supported: ${exts}.`
      );
    }
    throw new CliError(
      err instanceof FileTooLargeError ? message : `${message} (${errorText(err)})`
    );
  }
  const empty = loaded.parseWarnings.find((w) => w.code === "empty-result");
  warn(
    io,
    loaded.parseWarnings.filter((w) => w !== empty)
  );
  warn(io, loaded.repairs);
  if (empty) throw new CliError(empty.message);
  return loaded;
}
async function save(io, loaded, target, output, fallbackPath) {
  let data;
  let warnings;
  try {
    if (TEXT_FORMAT_IDS.includes(target)) {
      const r = exportDocument(loaded, target);
      ({ text: data, warnings } = r);
    } else {
      const r = await exportProDocument(loaded, target);
      data = r.kind === "binary" ? r.bytes : r.text;
      warnings = r.warnings;
    }
  } catch (err) {
    throw new CliError(`Export to ${target} failed: ${errorText(err)}`);
  }
  if (data === void 0) throw new CliError(`Export to ${target} produced no output.`);
  warn(io, warnings);
  const path = output.path ?? fallbackPath;
  if (!output.force && await io.exists(path)) {
    throw new CliError(`"${path}" already exists; pass --force to overwrite.`);
  }
  try {
    await io.writeFile(path, data);
    io.stdout(path);
    return;
  } catch (err) {
    const code = err.code;
    if (output.path !== void 0 || !["EROFS", "EACCES", "EPERM"].includes(String(code))) {
      throw new CliError(`Cannot write "${path}": ${errorText(err)}`);
    }
  }
  const alt = join(io.cwd(), basename(path));
  if (!output.force && await io.exists(alt)) {
    throw new CliError(`"${alt}" already exists; pass --force to overwrite.`);
  }
  try {
    await io.writeFile(alt, data);
  } catch (err) {
    throw new CliError(`Cannot write "${path}" or "${alt}": ${errorText(err)}`);
  }
  io.stderr(
    `warning: "${dirname(path)}" is read-only; wrote ${alt} in the current directory instead.`
  );
  io.stdout(alt);
}
async function loadRuleset(spec, io) {
  const name = spec ?? DEFAULT_PRESET;
  if (Object.hasOwn(PRESETS, name))
    return { name, ruleset: PRESETS[name], builtin: true };
  if (!await io.exists(name)) {
    throw usage(
      `Unknown preset "${name}". Built-in presets: ${Object.keys(PRESETS).join(", ")}; or pass a path to a ruleset JSON file.`
    );
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(await io.readFile(name)));
  } catch (err) {
    throw new CliError(`Invalid ruleset "${name}": ${errorText(err)}`);
  }
  const errors = validateRuleset(data);
  if (errors.length > 0) {
    throw new CliError(`Invalid ruleset "${name}":
  ${errors.join("\n  ")}`);
  }
  const ruleset = data;
  return { name: ruleset.name, ruleset, builtin: false };
}
function severityCounts(issues) {
  const counts = { error: 0, warning: 0 };
  for (const i of issues) counts[i.severity]++;
  return counts;
}
function counted(c) {
  const s = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${s(c.error, "error")}, ${s(c.warning, "warning")}`;
}
function qcReport(file, loaded, preset, builtin, ruleset, issues) {
  return {
    file,
    format: loaded.sourceFormat,
    preset,
    presetBuiltin: builtin,
    presetVerified: builtin && ruleset.verified,
    cueCount: loaded.doc.cues.length,
    counts: severityCounts(issues),
    issues: issues.map((i) => ({
      ruleId: i.ruleId,
      cueIndex: i.cueIndex,
      severity: i.severity,
      message: i.message,
      fixable: i.effectivelyFixable ?? i.fixable
    }))
  };
}

// src/cli/main.ts
process.exitCode = await run(
  process.argv.slice(2),
  nodeIo(
    (line) => process.stdout.write(`${line}
`),
    (line) => process.stderr.write(`${line}
`)
  )
);

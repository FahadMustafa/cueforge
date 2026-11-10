// src/core/formats/stl/iso6937.ts
var ISO6937_SINGLE = {
  160: "\xA0",
  161: "\xA1",
  162: "\xA2",
  163: "\xA3",
  164: "$",
  165: "\xA5",
  167: "\xA7",
  168: "\xA4",
  169: "\u2018",
  170: "\u201C",
  171: "\xAB",
  172: "\u2190",
  173: "\u2191",
  174: "\u2192",
  175: "\u2193",
  176: "\xB0",
  177: "\xB1",
  178: "\xB2",
  179: "\xB3",
  180: "\xD7",
  181: "\xB5",
  182: "\xB6",
  183: "\xB7",
  184: "\xF7",
  185: "\u2019",
  186: "\u201D",
  187: "\xBB",
  188: "\xBC",
  189: "\xBD",
  190: "\xBE",
  191: "\xBF",
  208: "\u2015",
  209: "\xB9",
  210: "\xAE",
  211: "\xA9",
  212: "\u2122",
  213: "\u266A",
  214: "\xAC",
  215: "\xA6",
  220: "\u215B",
  221: "\u215C",
  222: "\u215D",
  223: "\u215E",
  224: "\u03A9",
  225: "\xC6",
  226: "\u0110",
  227: "\xAA",
  228: "\u0126",
  230: "\u0132",
  231: "\u013F",
  232: "\u0141",
  233: "\xD8",
  234: "\u0152",
  235: "\xBA",
  236: "\xDE",
  237: "\u0166",
  238: "\u014A",
  239: "\u0149",
  240: "\u0138",
  241: "\xE6",
  242: "\u0111",
  243: "\xF0",
  244: "\u0127",
  245: "\u0131",
  246: "\u0133",
  247: "\u0140",
  248: "\u0142",
  249: "\xF8",
  250: "\u0153",
  251: "\xDF",
  252: "\xFE",
  253: "\u0167",
  254: "\u014B"
};
var ISO6937_COMBINING = {
  193: "\u0300",
  // grave
  194: "\u0301",
  // acute
  195: "\u0302",
  // circumflex
  196: "\u0303",
  // tilde
  197: "\u0304",
  // macron
  198: "\u0306",
  // breve
  199: "\u0307",
  // dot above
  200: "\u0308",
  // diaeresis
  202: "\u030A",
  // ring above
  203: "\u0327",
  // cedilla
  205: "\u030B",
  // double acute
  206: "\u0328",
  // ogonek
  207: "\u030C"
  // caron
};
var SINGLE_REVERSE = (() => {
  const m = {};
  for (const [byte, ch] of Object.entries(ISO6937_SINGLE)) if (!(ch in m)) m[ch] = Number(byte);
  return m;
})();
var COMBINING_REVERSE = (() => {
  const m = {};
  for (const [byte, mark] of Object.entries(ISO6937_COMBINING)) m[mark] = Number(byte);
  return m;
})();
function composeIso6937(base, combiningMark) {
  return (base + combiningMark).normalize("NFC");
}
function encodeIso6937Char(ch) {
  const code = ch.codePointAt(0);
  if (code >= 32 && code <= 126) return [code];
  const single = SINGLE_REVERSE[ch];
  if (single !== void 0) return [single];
  const nfd = ch.normalize("NFD");
  if (nfd.length === 2) {
    const base = nfd.codePointAt(0);
    const diacritic = COMBINING_REVERSE[nfd[1]];
    if (diacritic !== void 0 && base >= 32 && base <= 126) return [diacritic, base];
  }
  return [32];
}
function canEncodeIso6937(ch) {
  if (ch === " ") return true;
  const bytes = encodeIso6937Char(ch);
  return !(bytes.length === 1 && bytes[0] === 32);
}

// src/core/formats/stl/stl.ts
var GSI_SIZE = 1024;
var TTI_SIZE = 128;
var TEXT_FIELD_OFFSET = 16;
var TEXT_FIELD_LEN = 112;
var FILL = 143;
var NEWLINE = 138;
var ITALIC_ON = 128;
var ITALIC_OFF = 129;
var UNDERLINE_ON = 130;
var UNDERLINE_OFF = 131;
var JC_TO_ALIGN = {
  0: void 0,
  1: "left",
  2: "center",
  3: "right"
};
var ALIGN_TO_JC = { left: 1, center: 2, right: 3 };
function readAscii(buf, offset, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[offset + i]);
  return s;
}
function frameRateFromDfc(dfc) {
  if (dfc.startsWith("STL30")) return 30;
  return 25;
}
function tcToMs(buf, offset, fps) {
  const h = buf[offset];
  const m = buf[offset + 1];
  const s = buf[offset + 2];
  const f = buf[offset + 3];
  return (h * 3600 + m * 60 + s) * 1e3 + Math.round(f * 1e3 / fps);
}
function decodeTextField(buf, offset) {
  const lines = [{ spans: [] }];
  let italic = false;
  let underline = false;
  const append = (ch) => {
    const spans = lines[lines.length - 1].spans;
    const last = spans[spans.length - 1];
    if (last && !!last.italic === italic && !!last.underline === underline) {
      last.text += ch;
      return;
    }
    const span = { text: ch };
    if (italic) span.italic = true;
    if (underline) span.underline = true;
    spans.push(span);
  };
  let pendingDiacritic = "";
  for (let i = 0; offset + i < buf.length; i++) {
    const b = buf[offset + i];
    if (b === FILL) continue;
    switch (b) {
      case NEWLINE:
        lines.push({ spans: [] });
        pendingDiacritic = "";
        continue;
      case ITALIC_ON:
        italic = true;
        continue;
      case ITALIC_OFF:
        italic = false;
        continue;
      case UNDERLINE_ON:
        underline = true;
        continue;
      case UNDERLINE_OFF:
        underline = false;
        continue;
    }
    if (ISO6937_COMBINING[b] !== void 0) {
      pendingDiacritic = ISO6937_COMBINING[b];
      continue;
    }
    let ch;
    if (b >= 32 && b <= 126)
      ch = String.fromCharCode(b);
    else if (b >= 160) ch = ISO6937_SINGLE[b];
    if (ch !== void 0) {
      append(pendingDiacritic === "" ? ch : composeIso6937(ch, pendingDiacritic));
      pendingDiacritic = "";
    }
  }
  return lines;
}
function parseStl(bytes) {
  const warnings = [];
  if (bytes.length < GSI_SIZE) {
    warnings.push({ code: "unexpected-content", message: "Buffer too short for a GSI block." });
    return { cues: [], metadata: { sourceFormat: "stl" }, warnings };
  }
  const dfc = readAscii(bytes, 3, 8);
  const fps = frameRateFromDfc(dfc);
  const cct = readAscii(bytes, 12, 2);
  if (cct !== "00") {
    warnings.push({
      code: "unexpected-content",
      message: `Unsupported Character Code Table "${cct}"; decoding best-effort as Latin (CCT 00).`
    });
  }
  const gsi = Array.from(bytes.subarray(0, GSI_SIZE));
  const cues = [];
  let pendingText = null;
  let header = null;
  for (let off = GSI_SIZE; off + TTI_SIZE <= bytes.length; off += TTI_SIZE) {
    const ebn = bytes[off + 3];
    if (pendingText === null) {
      pendingText = [];
      header = {
        startMs: tcToMs(bytes, off + 5, fps),
        endMs: tcToMs(bytes, off + 9, fps),
        vp: bytes[off + 13],
        jc: bytes[off + 14],
        cf: bytes[off + 15]
      };
    }
    for (let i = 0; i < TEXT_FIELD_LEN; i++) pendingText.push(bytes[off + TEXT_FIELD_OFFSET + i]);
    if (ebn === 255) {
      const h = header;
      if (h.cf !== 1) {
        const field = new Uint8Array(pendingText);
        const lines = decodeTextField(field, 0);
        const align = JC_TO_ALIGN[h.jc];
        const cue = {
          index: cues.length + 1,
          startMs: h.startMs,
          endMs: h.endMs,
          lines,
          raw: { vp: h.vp, jc: h.jc }
        };
        if (align !== void 0) cue.position = { align };
        if (h.endMs < h.startMs) {
          warnings.push({
            code: "reversed-timing",
            message: "Cue end precedes start.",
            cueIndex: cue.index
          });
        }
        cues.push(cue);
      }
      pendingText = null;
      header = null;
    }
  }
  return {
    cues,
    metadata: { sourceFormat: "stl", frameRate: fps, raw: { gsi } },
    warnings
  };
}
function writeAscii(buf, offset, len, s) {
  for (let i = 0; i < len; i++) buf[offset + i] = i < s.length ? s.charCodeAt(i) & 255 : 32;
}
function msToTc(buf, offset, ms, fps) {
  const totalFrames = Math.round(ms * fps / 1e3);
  const totalSeconds = Math.floor(totalFrames / fps);
  buf[offset] = Math.floor(totalSeconds / 3600);
  buf[offset + 1] = Math.floor(totalSeconds / 60) % 60;
  buf[offset + 2] = totalSeconds % 60;
  buf[offset + 3] = totalFrames % fps;
}
function encodeTextField(lines) {
  const bytes = [];
  let italic = false;
  let underline = false;
  lines.forEach((line, li) => {
    if (li > 0) bytes.push(NEWLINE);
    for (const span of line.spans) {
      if (!!span.italic !== italic) {
        bytes.push(span.italic ? ITALIC_ON : ITALIC_OFF);
        italic = !!span.italic;
      }
      if (!!span.underline !== underline) {
        bytes.push(span.underline ? UNDERLINE_ON : UNDERLINE_OFF);
        underline = !!span.underline;
      }
      for (const ch of span.text) bytes.push(...encodeIso6937Char(ch));
    }
  });
  if (italic) bytes.push(ITALIC_OFF);
  if (underline) bytes.push(UNDERLINE_OFF);
  return bytes;
}
function defaultGsi(fps, count) {
  const gsi = new Uint8Array(GSI_SIZE).fill(32);
  writeAscii(gsi, 0, 3, "850");
  writeAscii(gsi, 3, 8, fps === 30 ? "STL30.01" : "STL25.01");
  gsi[11] = "1".charCodeAt(0);
  writeAscii(gsi, 12, 2, "00");
  writeAscii(gsi, 238, 5, String(count).padStart(5, "0"));
  writeAscii(gsi, 243, 5, String(count).padStart(5, "0"));
  return gsi;
}
function serializeStl(doc) {
  const fps = doc.metadata.frameRate === 30 ? 30 : 25;
  const raw = doc.metadata.raw;
  const gsi = raw?.gsi && raw.gsi.length === GSI_SIZE ? Uint8Array.from(raw.gsi) : defaultGsi(fps, doc.cues.length);
  const blocks = [gsi];
  doc.cues.forEach((cue, idx) => {
    const ttiRaw = cue.raw;
    const vp = ttiRaw?.vp ?? 20;
    const jc = ttiRaw?.jc ?? (cue.position?.align ? ALIGN_TO_JC[cue.position.align] ?? 2 : 2);
    const text = encodeTextField(cue.lines);
    const chunkCount = Math.max(1, Math.ceil(text.length / TEXT_FIELD_LEN));
    for (let c = 0; c < chunkCount; c++) {
      const tti = new Uint8Array(TTI_SIZE).fill(FILL);
      tti[0] = 0;
      tti[1] = idx & 255;
      tti[2] = idx >> 8 & 255;
      tti[3] = c === chunkCount - 1 ? 255 : c;
      tti[4] = 0;
      msToTc(tti, 5, cue.startMs, fps);
      msToTc(tti, 9, cue.endMs, fps);
      tti[13] = vp;
      tti[14] = jc;
      tti[15] = 0;
      const chunk = text.slice(c * TEXT_FIELD_LEN, (c + 1) * TEXT_FIELD_LEN);
      for (let i = 0; i < chunk.length; i++) tti[TEXT_FIELD_OFFSET + i] = chunk[i];
      blocks.push(tti);
    }
  });
  writeAscii(gsi, 238, 5, String(blocks.length - 1).padStart(5, "0"));
  writeAscii(gsi, 243, 5, String(doc.cues.length).padStart(5, "0"));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}
export {
  canEncodeIso6937,
  parseStl,
  serializeStl
};

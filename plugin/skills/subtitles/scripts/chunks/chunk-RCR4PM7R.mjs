// src/core/formats/scc/cea608.ts
function stripParity(byte) {
  return byte & 127;
}
function addOddParity(byte) {
  const data = byte & 127;
  let ones = 0;
  for (let b = data; b !== 0; b >>= 1) ones += b & 1;
  return ones % 2 === 0 ? data | 128 : data;
}
function hasOddParity(byte) {
  let ones = 0;
  for (let b = byte; b !== 0; b >>= 1) ones += b & 1;
  return ones % 2 === 1;
}
var FRAME_RE = /^(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2})$/;
function isDropFrameTimecode(tc) {
  const m = FRAME_RE.exec(tc.trim());
  return m ? m[4] === ";" || m[4] === "." : false;
}
function timecodeToFrame(tc) {
  const m = FRAME_RE.exec(tc.trim());
  if (!m) throw new Error(`Invalid SCC timecode: "${tc}".`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const f = Number(m[5]);
  const drop = m[4] === ";" || m[4] === ".";
  const totalMinutes = h * 60 + min;
  let frame = ((h * 60 + min) * 60 + s) * 30 + f;
  if (drop) frame -= 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  return frame;
}
function frameToMs(frame) {
  return Math.round(frame * 1001 / 30);
}
function msToFrame(ms) {
  return Math.round(ms * 30 / 1001);
}
function frameToTimecode(frame, dropFrame) {
  let f = frame;
  if (dropFrame) {
    const framesPer10Min = 17982;
    const framesPerMin = 1798;
    const d = Math.floor(f / framesPer10Min);
    let m = f % framesPer10Min;
    if (m < 2) m += 2;
    f = f + 18 * d + 2 * Math.floor((m - 2) / framesPerMin);
  }
  const ff = f % 30;
  const totalSeconds = Math.floor(f / 30);
  const s = totalSeconds % 60;
  const min = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const sep = dropFrame ? ";" : ":";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(min)}:${p(s)}${sep}${p(ff)}`;
}
var BASIC_OVERRIDES = {
  42: "\xE1",
  92: "\xE9",
  94: "\xED",
  95: "\xF3",
  96: "\xFA",
  123: "\xE7",
  124: "\xF7",
  125: "\xD1",
  126: "\xF1",
  127: "\u2588"
};
function decodeBasicChar(data) {
  if (data < 32 || data > 127) return "";
  return BASIC_OVERRIDES[data] ?? String.fromCharCode(data);
}
var SPECIAL_CHARS = {
  48: "\xAE",
  49: "\xB0",
  50: "\xBD",
  51: "\xBF",
  52: "\u2122",
  53: "\xA2",
  54: "\xA3",
  55: "\u266A",
  56: "\xE0",
  57: "\xA0",
  58: "\xE8",
  59: "\xE2",
  60: "\xEA",
  61: "\xEE",
  62: "\xF4",
  63: "\xFB"
};
var EXTENDED_12 = [
  "\xC1",
  "\xC9",
  "\xD3",
  "\xDA",
  "\xDC",
  "\xFC",
  "\u2018",
  "\xA1",
  "*",
  "\u2019",
  "\u2014",
  "\xA9",
  "\u2120",
  "\u2022",
  "\u201C",
  "\u201D",
  "\xC0",
  "\xC2",
  "\xC7",
  "\xC8",
  "\xCA",
  "\xCB",
  "\xEB",
  "\xCE",
  "\xCF",
  "\xEF",
  "\xD4",
  "\xD9",
  "\xF9",
  "\xDB",
  "\xAB",
  "\xBB"
];
var EXTENDED_13 = [
  "\xC3",
  "\xE3",
  "\xCD",
  "\xCC",
  "\xEC",
  "\xD2",
  "\xF2",
  "\xD5",
  "\xF5",
  "{",
  "}",
  "\\",
  "^",
  "_",
  "|",
  "~",
  "\xC4",
  "\xE4",
  "\xD6",
  "\xF6",
  "\xDF",
  "\xA5",
  "\xA4",
  "\u2502",
  "\xC5",
  "\xE5",
  "\xD8",
  "\xF8",
  "\u250C",
  "\u2510",
  "\u2514",
  "\u2518"
];
function decodeExtendedChar(b1, b2) {
  if (b2 < 32 || b2 > 63) return null;
  if (b1 === 18) return EXTENDED_12[b2 - 32];
  if (b1 === 19) return EXTENDED_13[b2 - 32];
  return null;
}
var MIDROW_COLORS = ["white", "green", "blue", "cyan", "red", "yellow", "magenta"];
function decodeMidRow(b2) {
  const underline = (b2 & 1) === 1;
  const idx = b2 - 32 >> 1;
  if (idx === 7) return { italic: true, underline };
  return { italic: false, underline, color: MIDROW_COLORS[idx] };
}
var PAC_ROW_BASE = {
  17: 1,
  18: 3,
  21: 5,
  22: 7,
  23: 9,
  16: 11,
  19: 12,
  20: 14
};
function isPac(b1, b2) {
  return b1 >= 16 && b1 <= 23 && b2 >= 64 && b2 <= 127 && PAC_ROW_BASE[b1] !== void 0;
}
function decodePac(b1, b2) {
  const base = PAC_ROW_BASE[b1];
  const row = base === 11 ? 11 : base + (b2 >= 96 ? 1 : 0);
  const x = b2 >= 96 ? b2 - 32 : b2;
  const underline = (x & 1) === 1;
  if (x & 16) {
    const indent = ((x & 14) >> 1) * 4;
    return { row, indent, italic: false, underline };
  }
  const styleIdx = (x & 14) >> 1;
  return { row, indent: 0, italic: styleIdx === 7, underline };
}
function encodeWord(b1, b2) {
  const w = addOddParity(b1) << 8 | addOddParity(b2);
  return w.toString(16).padStart(4, "0");
}
function encodePac(row, indent, italic, underline) {
  const b1 = Number(
    Object.keys(PAC_ROW_BASE).find((k) => {
      const base2 = PAC_ROW_BASE[Number(k)];
      return base2 === 11 ? row === 11 : row === base2 || row === base2 + 1;
    })
  );
  const base = PAC_ROW_BASE[b1];
  const lower = base !== 11 && row === base + 1;
  let x;
  if (indent > 0) {
    x = 80 | (Math.floor(indent / 4) & 7) << 1 | (underline ? 1 : 0);
  } else {
    const styleIdx = italic ? 7 : 0;
    x = 64 | styleIdx << 1 | (underline ? 1 : 0);
  }
  const b2 = lower ? x + 32 : x;
  return [b1, b2];
}
var BASIC_REVERSE = (() => {
  const m = {};
  for (let code = 32; code <= 127; code++) {
    const ch = decodeBasicChar(code);
    if (!(ch in m)) m[ch] = code;
  }
  return m;
})();
var SPECIAL_REVERSE = (() => {
  const m = {};
  for (const [k, v] of Object.entries(SPECIAL_CHARS)) if (!(v in m)) m[v] = Number(k);
  return m;
})();
var EXTENDED_REVERSE = (() => {
  const m = {};
  EXTENDED_12.forEach((ch, i) => {
    if (!(ch in m)) m[ch] = [18, 32 + i];
  });
  EXTENDED_13.forEach((ch, i) => {
    if (!(ch in m)) m[ch] = [19, 32 + i];
  });
  return m;
})();
var EXTENDED_FALLBACK = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\xAB": '"',
  "\xBB": '"',
  "\u2014": "-",
  "\u2022": ".",
  "\xA9": "c",
  "\u2120": "s",
  "\xA1": "!",
  "*": "?",
  "{": "(",
  "}": ")",
  "\\": "/",
  "^": "?",
  _: "-",
  "|": "!",
  "~": "?",
  "\xA5": "Y",
  "\xA4": "$",
  "\u2502": "!",
  "\u250C": "!",
  "\u2510": "!",
  "\u2514": "!",
  "\u2518": "!",
  \u00DF: "s",
  \u00F8: "o",
  \u00D8: "O"
};
function extendedFallbackByte(ch) {
  const candidate = EXTENDED_FALLBACK[ch] ?? ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return BASIC_REVERSE[candidate] ?? BASIC_REVERSE["?"];
}
var TRANSLIT = {
  "\u2013": "-",
  "\u2026": "...",
  "\xA0": " "
};
function encodeChar(ch) {
  if (ch in BASIC_REVERSE) return [{ kind: "basic", byte: BASIC_REVERSE[ch] }];
  if (ch in SPECIAL_REVERSE) return [{ kind: "special", b2: SPECIAL_REVERSE[ch] }];
  const ext = EXTENDED_REVERSE[ch];
  if (ext) {
    return [{ kind: "extended", fallback: extendedFallbackByte(ch), b1: ext[0], b2: ext[1] }];
  }
  if (ch in TRANSLIT) return [...TRANSLIT[ch]].flatMap(encodeChar);
  const stripped = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (stripped !== ch && stripped !== "") return [...stripped].flatMap(encodeChar);
  return [{ kind: "basic", byte: BASIC_REVERSE["?"] }];
}
function canEncodeCea608(ch) {
  if (ch in BASIC_REVERSE || ch in SPECIAL_REVERSE || ch in EXTENDED_REVERSE || ch in TRANSLIT) {
    return true;
  }
  const stripped = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (stripped !== ch && stripped !== "") return [...stripped].every(canEncodeCea608);
  return false;
}
function decodeControl(b1, b2) {
  if (b1 === 20) {
    switch (b2) {
      case 32:
        return "RCL";
      case 36:
        return null;
      // DER (delete to end of row) — unsupported, ignore
      case 37:
        return "RU2";
      case 38:
        return "RU3";
      case 39:
        return "RU4";
      case 41:
        return "RDC";
      case 44:
        return "EDM";
      case 45:
        return "CR";
      case 46:
        return "ENM";
      case 47:
        return "EOC";
    }
  }
  if (b1 === 23 && b2 >= 33 && b2 <= 35) {
    return b2 === 33 ? "TO1" : b2 === 34 ? "TO2" : "TO3";
  }
  return null;
}

export {
  stripParity,
  addOddParity,
  hasOddParity,
  isDropFrameTimecode,
  timecodeToFrame,
  frameToMs,
  msToFrame,
  frameToTimecode,
  decodeBasicChar,
  SPECIAL_CHARS,
  decodeExtendedChar,
  decodeMidRow,
  isPac,
  decodePac,
  encodeWord,
  encodePac,
  encodeChar,
  canEncodeCea608,
  decodeControl
};

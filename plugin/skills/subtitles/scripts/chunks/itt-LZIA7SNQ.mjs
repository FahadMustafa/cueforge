import {
  parseTtml,
  serializeTtmlProfile
} from "./chunk-CEEQKJ3V.mjs";
import {
  msToTimecode
} from "./chunk-K32MESKF.mjs";
import {
  canonicalFps
} from "./chunk-GP4UVXBM.mjs";
import "./chunk-RCR4PM7R.mjs";

// src/core/formats/itt/itt.ts
var DEFAULT_ITT_FPS = 24;
var SMPTE_RATES = {
  23.976: { frameRate: "24", multiplier: "1000 1001" },
  24: { frameRate: "24" },
  25: { frameRate: "25" },
  29.97: { frameRate: "30", multiplier: "1000 1001", dropMode: "dropNTSC" },
  30: { frameRate: "30" }
};
var ITT_TT_ATTRS = {
  xmlns: "http://www.w3.org/ns/ttml",
  "xmlns:tts": "http://www.w3.org/ns/ttml#styling",
  "xmlns:ttp": "http://www.w3.org/ns/ttml#parameter",
  "xmlns:ttm": "http://www.w3.org/ns/ttml#metadata",
  "ttp:cellResolution": "50 33",
  "xml:lang": "en"
};
function parseItt(text) {
  const doc = parseTtml(text);
  return { ...doc, metadata: { ...doc.metadata, sourceFormat: "itt" } };
}
function serializeItt(doc) {
  const fps = canonicalFps(doc.metadata.frameRate ?? DEFAULT_ITT_FPS);
  const rate = SMPTE_RATES[fps] ?? { frameRate: String(Math.round(fps)) };
  const timing = {
    "ttp:timeBase": "smpte",
    "ttp:frameRate": rate.frameRate
  };
  if (rate.multiplier !== void 0) timing["ttp:frameRateMultiplier"] = rate.multiplier;
  if (rate.dropMode !== void 0) timing["ttp:dropMode"] = rate.dropMode;
  const dropFrame = timing["ttp:dropMode"] !== void 0;
  return serializeTtmlProfile(doc, {
    defaultTtAttrs: ITT_TT_ATTRS,
    overrideTtAttrs: timing,
    // TTML clock-time uses ':' for the frames field; drop-frame is signalled by
    // ttp:dropMode, not a ';' separator, so normalise the SCC drop-frame form.
    formatTime: (ms) => msToTimecode(ms, fps, dropFrame).replace(";", ":")
  });
}
export {
  parseItt,
  serializeItt
};

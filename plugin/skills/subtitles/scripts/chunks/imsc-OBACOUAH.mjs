import {
  parseTtml,
  serializeTtmlProfile
} from "./chunk-CEEQKJ3V.mjs";
import "./chunk-K32MESKF.mjs";
import "./chunk-GP4UVXBM.mjs";
import "./chunk-RCR4PM7R.mjs";

// src/core/formats/imsc/imsc.ts
var IMSC_HEAD = [
  "  <head>",
  "    <styling>",
  '      <style xml:id="s0" tts:fontSize="100%" tts:fontFamily="default" tts:color="white" tts:textAlign="center"/>',
  "    </styling>",
  "    <layout>",
  '      <region xml:id="r0" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after"/>',
  "    </layout>",
  "  </head>"
].join("\n");
function imscTtAttrs(doc, profileAttrs) {
  return {
    xmlns: "http://www.w3.org/ns/ttml",
    "xmlns:ttp": "http://www.w3.org/ns/ttml#parameter",
    "xmlns:tts": "http://www.w3.org/ns/ttml#styling",
    "xmlns:ttm": "http://www.w3.org/ns/ttml#metadata",
    "ttp:timeBase": "media",
    // IMSC requires xml:lang present; an unknown language is spec-valid as ''.
    "xml:lang": doc.metadata.language ?? "",
    // The root container extent is the one place IMSC permits pixel units.
    "tts:extent": "1920px 1080px",
    ...profileAttrs
  };
}
function serializeImscProfile(doc, profileAttrs) {
  const ttAttrs = imscTtAttrs(doc, profileAttrs);
  return serializeTtmlProfile(doc, {
    defaultTtAttrs: ttAttrs,
    // Source raw ttAttrs (timing, a stale profile designator, source xml:lang…)
    // must not leak into an IMSC export — the profile owns its whole parameter
    // set, so force it via override rather than default.
    overrideTtAttrs: ttAttrs,
    head: IMSC_HEAD,
    forceRegion: "r0",
    forceStyle: "s0"
  });
}
function serializeImsc101(doc) {
  return serializeImscProfile(doc, {
    "ttp:profile": "http://www.w3.org/ns/ttml/profile/imsc1/text"
  });
}
function serializeImsc11(doc) {
  return serializeImscProfile(doc, {
    "ttp:contentProfiles": "http://www.w3.org/ns/ttml/profile/imsc1.1/text"
  });
}
function parseImsc101(text) {
  const doc = parseTtml(text);
  return { ...doc, metadata: { ...doc.metadata, sourceFormat: "imsc101" } };
}
function parseImsc11(text) {
  const doc = parseTtml(text);
  return { ...doc, metadata: { ...doc.metadata, sourceFormat: "imsc11" } };
}
export {
  parseImsc101,
  parseImsc11,
  serializeImsc101,
  serializeImsc11
};

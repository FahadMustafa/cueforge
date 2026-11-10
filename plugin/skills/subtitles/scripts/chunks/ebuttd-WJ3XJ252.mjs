import {
  XmlError,
  escapeAttr,
  escapeText,
  parseTtml,
  parseXml,
  serializeTtmlProfile,
  serializeXml
} from "./chunk-CEEQKJ3V.mjs";
import "./chunk-K32MESKF.mjs";
import "./chunk-GP4UVXBM.mjs";
import "./chunk-RCR4PM7R.mjs";

// src/core/formats/ebuttd/ebuttd.ts
var CONFORMS_TO = "urn:ebu:tt:distribution:2014";
var BASE_STYLE_ID = "s0";
var REGION_ID = "r0";
function local(name) {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}
function attrByLocal(el, localName) {
  for (const key of Object.keys(el.attrs)) if (local(key) === localName) return el.attrs[key];
  return void 0;
}
function spanStyle(span) {
  if (span.opaque !== void 0) return null;
  const s = {};
  if (span.italic) s.italic = true;
  if (span.bold) s.bold = true;
  if (span.underline) s.underline = true;
  if (span.color !== void 0) s.color = span.color;
  return Object.keys(s).length > 0 ? s : null;
}
function styleKey(s) {
  return [s.italic ? "i" : "", s.bold ? "b" : "", s.underline ? "u" : "", s.color ?? ""].join("|");
}
function collectStyles(doc) {
  const byKey = /* @__PURE__ */ new Map();
  const order = [];
  for (const cue of doc.cues) {
    for (const line of cue.lines) {
      for (const span of line.spans) {
        const s = spanStyle(span);
        if (!s) continue;
        const key = styleKey(s);
        if (byKey.has(key)) continue;
        const id = `s${order.length + 1}`;
        byKey.set(key, id);
        order.push({ id, style: s });
      }
    }
  }
  return { order, byKey };
}
function styleAttrs(s) {
  const a = [];
  if (s.italic) a.push('tts:fontStyle="italic"');
  if (s.bold) a.push('tts:fontWeight="bold"');
  if (s.underline) a.push('tts:textDecoration="underline"');
  if (s.color !== void 0) a.push(`tts:color="${escapeAttr(s.color)}"`);
  return a.join(" ");
}
function ebuttdTtAttrs(doc) {
  return {
    xmlns: "http://www.w3.org/ns/ttml",
    "xmlns:ttp": "http://www.w3.org/ns/ttml#parameter",
    "xmlns:tts": "http://www.w3.org/ns/ttml#styling",
    "xmlns:ebuttm": "urn:ebu:tt:metadata",
    "xmlns:ebutts": "urn:ebu:tt:style",
    "ttp:timeBase": "media",
    "ttp:cellResolution": "32 15",
    // The root container extent is the one place absolute pixels are valid; it
    // defines the reference video size the percentage region resolves against.
    "tts:extent": "1920px 1080px",
    // xml:lang is required; an unknown language is spec-valid as '' (matches serializeTtml).
    "xml:lang": doc.metadata.language ?? ""
  };
}
function buildHead(order) {
  const styles = [
    `      <style xml:id="${BASE_STYLE_ID}" tts:fontFamily="proportionalSansSerif" tts:fontSize="80%" tts:lineHeight="normal" tts:textAlign="center" tts:color="#FFFFFF"/>`,
    ...order.map(({ id, style }) => `      <style xml:id="${id}" ${styleAttrs(style)}/>`)
  ];
  return [
    "  <head>",
    "    <metadata>",
    "      <ebuttm:documentMetadata>",
    `        <ebuttm:conformsToStandard>${CONFORMS_TO}</ebuttm:conformsToStandard>`,
    "      </ebuttm:documentMetadata>",
    "    </metadata>",
    "    <styling>",
    ...styles,
    "    </styling>",
    "    <layout>",
    `      <region xml:id="${REGION_ID}" tts:origin="10% 10%" tts:extent="80% 80%" tts:displayAlign="after" tts:overflow="visible"/>`,
    "    </layout>",
    "  </head>"
  ].join("\n");
}
function renderContent(lines, byKey) {
  return lines.map(
    (line) => line.spans.map((span) => {
      const text = escapeText(span.text);
      const s = spanStyle(span);
      if (!s) return text;
      return `<span style="${byKey.get(styleKey(s))}">${text}</span>`;
    }).join("")
  ).join("<br/>");
}
function serializeEbuttd(doc) {
  const { order, byKey } = collectStyles(doc);
  const ttAttrs = ebuttdTtAttrs(doc);
  return serializeTtmlProfile(doc, {
    defaultTtAttrs: ttAttrs,
    // EBU-TT-D owns its whole parameter set; force it so no source timing/profile
    // attrs leak through when re-serializing a document parsed from another format.
    overrideTtAttrs: ttAttrs,
    head: buildHead(order),
    forceStyle: BASE_STYLE_ID,
    forceRegion: REGION_ID,
    serializeContent: (lines) => renderContent(lines, byKey)
  });
}
function collectHeadStyles(tt) {
  const map = /* @__PURE__ */ new Map();
  const head = tt.children.find((c) => typeof c !== "string" && local(c.tag) === "head");
  const styling = head?.children.find(
    (c) => typeof c !== "string" && local(c.tag) === "styling"
  );
  if (!styling) return map;
  for (const c of styling.children) {
    if (typeof c === "string" || local(c.tag) !== "style") continue;
    const id = attrByLocal(c, "id");
    if (id === void 0) continue;
    const tts = {};
    for (const [k, v] of Object.entries(c.attrs)) if (k.startsWith("tts:")) tts[k] = v;
    map.set(id, tts);
  }
  return map;
}
function inlineSpanStyles(el, styleMap) {
  for (const c of el.children) {
    if (typeof c === "string") continue;
    if (local(c.tag) === "span") {
      const ref = attrByLocal(c, "style");
      if (ref !== void 0) {
        for (const id of ref.trim().split(/\s+/)) {
          const tts = styleMap.get(id);
          if (!tts) continue;
          for (const [k, v] of Object.entries(tts)) {
            if (attrByLocal(c, local(k)) === void 0) c.attrs[k] = v;
          }
        }
      }
    }
    inlineSpanStyles(c, styleMap);
  }
}
function parseEbuttd(text) {
  let resolved = text;
  try {
    const tt = parseXml(text);
    const styleMap = collectHeadStyles(tt);
    if (styleMap.size > 0) {
      inlineSpanStyles(tt, styleMap);
      resolved = serializeXml(tt);
    }
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
  }
  const doc = parseTtml(resolved);
  return {
    ...doc,
    metadata: { ...doc.metadata, sourceFormat: "ebuttd" }
  };
}
export {
  parseEbuttd,
  serializeEbuttd
};

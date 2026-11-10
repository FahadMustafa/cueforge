import { describe, expect, it } from 'vitest';
import { normalizeForTarget, type ConversionTargetId } from '../../core/formats/convert';
import { parseXml, type XmlElement } from '../../core/formats/ttml/xml';
import { exportDocument, exportProDocument, importBytes, importFile } from './session';

const encode = (text: string) => new TextEncoder().encode(text);

const vtt = `WEBVTT - Native styling

STYLE
::cue(.special) { color: lime; }

REGION
id:bottom
width:80%
lines:3

NOTE keep this note

caption-one
00:00:01.000 --> 00:00:02.000 region:bottom align:start
<c.special>Hello</c>
`;

const ass = `[Script Info]
Title: Native styling
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Special,Arial,42,&H0000FF00

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 3,0:00:01.00,0:00:02.00,Special,Narrator,10,20,30,,Hello
Comment: 0,0:00:03.00,0:00:04.00,Special,,0,0,0,,Keep this comment

[Fonts]
fontname: custom.ttf
`;

const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="en">
  <head>
    <styling><style xml:id="special" tts:fontStyle="italic"/></styling>
    <layout><region xml:id="bottom" tts:origin="10% 80%" tts:extent="80% 20%"/></layout>
  </head>
  <body><div><p begin="1s" end="2s" style="special" region="bottom">Hello</p></div></body>
</tt>`;

function elements(root: XmlElement): XmlElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (typeof child === 'string' ? [] : elements(child))),
  ];
}

function expectResolvedReferences(text: string): void {
  const nodes = elements(parseXml(text));
  const styleIds = new Set(
    nodes.filter((node) => node.tag === 'style').map((node) => node.attrs['xml:id']),
  );
  const regionIds = new Set(
    nodes.filter((node) => node.tag === 'region').map((node) => node.attrs['xml:id']),
  );
  for (const node of nodes) {
    for (const reference of node.attrs.style?.split(/\s+/) ?? [])
      expect(styleIds.has(reference)).toBe(true);
    if (node.attrs.region !== undefined) expect(regionIds.has(node.attrs.region)).toBe(true);
  }
}

describe('native fidelity through session import/export', () => {
  it('keeps WebVTT STYLE, REGION, notes, header and cue settings together', () => {
    const loaded = importBytes('styled.vtt', encode(vtt));
    const before = structuredClone(loaded.doc);
    const output = exportDocument(loaded, 'vtt');
    expect(output.text).toContain('WEBVTT - Native styling');
    expect(output.text).toContain('::cue(.special) { color: lime; }');
    expect(output.text).toContain('REGION\nid:bottom');
    expect(output.text).toContain('NOTE keep this note');
    expect(output.text).toContain('region:bottom align:start');
    expect(output.text).toContain('<c.special>Hello</c>');
    expect(output.warnings).toEqual([]);
    expect(loaded.doc).toEqual(before);
  });

  it('keeps ASS headers, named styles, event fields, comments and trailing sections', () => {
    const loaded = importBytes('styled.ass', encode(ass));
    const before = structuredClone(loaded.doc);
    const output = exportDocument(loaded, 'ass');
    expect(output.text).toContain('Title: Native styling');
    expect(output.text).toContain('PlayResX: 1920');
    expect(output.text).toContain('Style: Special,Arial,42,&H0000FF00');
    expect(output.text).toContain(
      'Dialogue: 3,0:00:01.00,0:00:02.00,Special,Narrator,10,20,30,,Hello',
    );
    expect(output.text).toContain('Comment:');
    expect(output.text).toContain('fontname: custom.ttf');
    expect(output.warnings).toEqual([]);
    expect(loaded.doc).toEqual(before);
  });

  it.each(['ttml', 'itt'] as const)(
    'keeps %s head definitions and resolves every cue reference',
    async (format) => {
      const loaded = await importFile(`styled.${format}`, encode(ttml), { allowPro: true });
      const before = structuredClone(loaded.doc);
      const output = await exportProDocument(loaded, format);
      expect(output.text).toContain('<head>');
      expect(output.text).toContain('xml:id="special"');
      expect(output.text).toContain('style="special"');
      expect(output.text).toContain('region="bottom"');
      expectResolvedReferences(output.text!);
      expect(output.warnings).toEqual([]);
      expect(loaded.doc).toEqual(before);
    },
  );

  it('preserves legacy SSA headers on the shared ASS export path', () => {
    const loaded = importBytes('styled.ssa', encode(ass.replace('[V4+ Styles]', '[V4 Styles]')));
    const output = exportDocument(loaded, 'ass');
    expect(output.text).toContain('[V4 Styles]');
    expect(output.text).toContain('Style: Special,Arial,42,&H0000FF00');
  });

  it('preserves source namespace aliases while declaring prefixes used by the TTML serializer', async () => {
    const source = ttml
      .replace('xmlns:tts=', 'xmlns:sty=')
      .replaceAll('tts:', 'sty:')
      .replace('Hello', '<span sty:color="lime">Hello</span>');
    const loaded = await importFile('styled.ttml', encode(source), { allowPro: true });
    const output = await exportProDocument(loaded, 'ttml');
    expect(output.text).toContain('xmlns:sty="http://www.w3.org/ns/ttml#styling"');
    expect(output.text).toContain('xmlns:tts="http://www.w3.org/ns/ttml#styling"');
    expect(output.text).toContain('tts:color="lime"');
    expectResolvedReferences(output.text!);
  });
});

describe('cross-format native-data isolation', () => {
  it.each(['itt', 'imsc101', 'imsc11', 'ebuttd'] as const)(
    'TTML → %s has no dangling source references and reports native layout loss',
    async (target) => {
      const loaded = await importFile('styled.ttml', encode(ttml), { allowPro: true });
      const output = await exportProDocument(loaded, target);
      expectResolvedReferences(output.text!);
      expect(output.text).not.toContain('style="special"');
      expect(output.text).not.toContain('region="bottom"');
      expect(output.warnings.some((warning) => /native|references/i.test(warning.message))).toBe(
        true,
      );
    },
  );

  it('does not turn an ASS style name into an undefined TTML style reference', async () => {
    const loaded = importBytes('styled.ass', encode(ass));
    const output = await exportProDocument(loaded, 'ttml');
    expect(output.text).not.toContain('Special');
    expect(output.text).not.toContain('[Script Info]');
    expectResolvedReferences(output.text!);
    expect(output.warnings.some((warning) => /native|references/i.test(warning.message))).toBe(
      true,
    );
  });

  it('does not carry WebVTT region settings back through an intermediate format', () => {
    const loaded = importBytes('styled.vtt', encode(vtt));
    const { doc, warnings } = normalizeForTarget(loaded.doc, 'srt');
    const output = exportDocument({ ...loaded, doc }, 'vtt');
    expect(doc.metadata.raw).toBeUndefined();
    expect(doc.cues[0]!.position?.raw).toBeUndefined();
    expect(output.text).not.toContain('region:bottom');
    expect(output.text).not.toContain('special');
    expect(warnings.some((warning) => /native|references/i.test(warning.message))).toBe(true);
  });

  it.each<ConversionTargetId>([
    'srt',
    'vtt',
    'sbv',
    'ass',
    'scc',
    'stl',
    'mcc',
    'itt',
    'imsc101',
    'imsc11',
    'ebuttd',
  ])(
    'strips TTML-only raw data and references for %s without mutating the source',
    async (target) => {
      const loaded = await importFile('styled.ttml', encode(ttml), { allowPro: true });
      const before = structuredClone(loaded.doc);
      const { doc } = normalizeForTarget(loaded.doc, target);
      expect(doc.metadata.raw).toBeUndefined();
      expect(doc.cues[0]!.styleRefs).toBeUndefined();
      expect(doc.cues[0]!.raw).toBeUndefined();
      expect(loaded.doc).toEqual(before);
    },
  );
});

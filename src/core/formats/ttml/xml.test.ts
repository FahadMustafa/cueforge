import { describe, expect, it } from 'vitest';
import { parseXml, serializeXml, XmlError, type XmlElement } from './xml';

/** Convenience: the single root element of a parsed document. */
function root(src: string): XmlElement {
  return parseXml(src);
}

describe('parseXml', () => {
  it('parses a single element with text', () => {
    const el = root('<p>hello</p>');
    expect(el.tag).toBe('p');
    expect(el.children).toEqual(['hello']);
  });

  it('parses attributes including namespaced ones', () => {
    const el = root('<tt xml:lang="ar" ttp:frameRate="25">x</tt>');
    expect(el.attrs['xml:lang']).toBe('ar');
    expect(el.attrs['ttp:frameRate']).toBe('25');
  });

  it('parses nested element children', () => {
    const el = root('<div><p>a</p><p>b</p></div>');
    const kids = el.children.filter((c): c is XmlElement => typeof c !== 'string');
    expect(kids).toHaveLength(2);
    expect(kids[0]!.tag).toBe('p');
    expect(kids[0]!.children).toEqual(['a']);
    expect(kids[1]!.children).toEqual(['b']);
  });

  it('parses self-closing elements', () => {
    const el = root('<p>a<br/>b</p>');
    expect(el.children).toHaveLength(3);
    expect((el.children[1] as XmlElement).tag).toBe('br');
    expect((el.children[1] as XmlElement).children).toEqual([]);
  });

  it('decodes named and numeric entities in text', () => {
    const el = root('<p>a &amp; b &lt;c&gt; &#65; &#x41;</p>');
    expect(el.children).toEqual(['a & b <c> A A']);
  });

  it('decodes entities in attribute values', () => {
    const el = root('<p title="a &amp; b">x</p>');
    expect(el.attrs['title']).toBe('a & b');
  });

  it('skips the XML declaration, comments and doctype', () => {
    const el = root(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- a note -->\n<!DOCTYPE tt>\n<tt>body</tt>',
    );
    expect(el.tag).toBe('tt');
    expect(el.children).toEqual(['body']);
  });

  it('strips a leading UTF-8 BOM', () => {
    const el = root('﻿<p>x</p>');
    expect(el.tag).toBe('p');
  });

  it('handles single-quoted attribute values', () => {
    const el = root('<p a=\'1\' b="2">x</p>');
    expect(el.attrs['a']).toBe('1');
    expect(el.attrs['b']).toBe('2');
  });

  it('preserves significant whitespace between inline children', () => {
    const el = root('<p>a <span>b</span> c</p>');
    expect(el.children[0]).toBe('a ');
    expect((el.children[1] as XmlElement).tag).toBe('span');
    expect(el.children[2]).toBe(' c');
  });

  it('throws on a missing closing tag', () => {
    expect(() => root('<p>oops')).toThrow();
  });

  it('throws on mismatched closing tag', () => {
    expect(() => root('<p>x</q>')).toThrow();
  });

  it('throws on an unquoted attribute value', () => {
    expect(() => root('<p a=1>x</p>')).toThrow();
  });

  it('returns the literal source text for out-of-range numeric character references', () => {
    const el = root('<p>&#x110000; &#1114112;</p>');
    expect(el.children).toEqual(['&#x110000; &#1114112;']);
  });

  it('returns the literal source text for lone-surrogate numeric character references', () => {
    const el = root('<p>&#xD800;&#xDFFF;&#55296;</p>');
    expect(el.children).toEqual(['&#xD800;&#xDFFF;&#55296;']);
  });

  it('returns the literal source text for a zero numeric character reference', () => {
    const el = root('<p>&#0;&#x0;</p>');
    expect(el.children).toEqual(['&#0;&#x0;']);
  });

  it('throws a controlled XmlError when element nesting exceeds the depth limit', () => {
    const deep = '<a>'.repeat(300) + '</a>'.repeat(300);
    expect(() => root(deep)).toThrow(XmlError);
    expect(() => root(deep)).toThrow(/depth/i);
  });

  it('skips comments that appear between child elements', () => {
    const el = root('<div><p>a</p><!-- note --><p>b</p></div>');
    const kids = el.children.filter((c): c is XmlElement => typeof c !== 'string');
    expect(kids).toHaveLength(2);
  });
});

describe('serializeXml', () => {
  it('re-encodes special characters in text and attributes', () => {
    const el: XmlElement = { tag: 'p', attrs: { title: 'a & "b"' }, children: ['x < y & z'] };
    const out = serializeXml(el);
    expect(out).toBe('<p title="a &amp; &quot;b&quot;">x &lt; y &amp; z</p>');
  });

  it('emits self-closing syntax for empty elements', () => {
    expect(serializeXml({ tag: 'br', attrs: {}, children: [] })).toBe('<br/>');
  });

  it('round-trips an element tree (parse → serialize → parse)', () => {
    const src =
      '<head>\n  <styling><style xml:id="s1" tts:color="red"/></styling>\n' +
      '  <layout><region xml:id="r1"/></layout>\n</head>';
    const once = parseXml(src);
    const twice = parseXml(serializeXml(once));
    expect(twice).toEqual(once);
  });
});

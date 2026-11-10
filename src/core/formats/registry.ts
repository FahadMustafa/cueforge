import type { SubtitleDocument, SubtitleFormat } from '../model/types';
import { parseSrt, serializeSrt } from './srt';
import { parseVtt, serializeVtt } from './vtt';
import { parseSbv, serializeSbv } from './sbv';
import { parseAss, serializeAss } from './ass';

/** A text-format codec: decoded string in, {@link SubtitleDocument} out, and back. */
export interface TextFormatCodec {
  id: SubtitleFormat;
  name: string;
  extensions: string[];
  parse(text: string): SubtitleDocument;
  serialize(doc: SubtitleDocument): string;
}

/** Registry of text formats implemented so far (spec §3). Pro/binary formats land in M6. */
export const TEXT_FORMATS = {
  srt: {
    id: 'srt',
    name: 'SubRip',
    extensions: ['.srt'],
    parse: parseSrt,
    serialize: serializeSrt,
  },
  vtt: {
    id: 'vtt',
    name: 'WebVTT',
    extensions: ['.vtt'],
    parse: parseVtt,
    serialize: serializeVtt,
  },
  sbv: {
    id: 'sbv',
    name: 'YouTube SBV',
    extensions: ['.sbv'],
    parse: parseSbv,
    serialize: serializeSbv,
  },
  ass: {
    id: 'ass',
    name: 'Advanced SubStation Alpha',
    extensions: ['.ass', '.ssa'],
    parse: parseAss,
    serialize: serializeAss,
  },
} as const satisfies Record<string, TextFormatCodec>;

export type TextFormatId = keyof typeof TEXT_FORMATS;

export const TEXT_FORMAT_IDS = Object.keys(TEXT_FORMATS) as TextFormatId[];

/** Look up a text-format codec by id. */
export function getTextFormat(id: TextFormatId): TextFormatCodec {
  return TEXT_FORMATS[id];
}

/**
 * Document session — the app-side pipeline that turns an uploaded file into a
 * canonical {@link SubtitleDocument} and back out to a chosen target format.
 *
 * Import is: decode bytes → parse with the source codec → repair-on-import
 * (spec §4.1 #5: renumber, normalize timestamps, fix reversed start/end; BOM and
 * encoding are handled by {@link decode}). The repaired document is held in app
 * state so the editor and QC panel operate on the same in-memory model.
 *
 * This module is framework-free so it is unit-testable without a DOM.
 */
// Specific core modules, not the `../../core` barrel: the CLI's import closure
// runs through this file and must not pull in licensing or transcription.
import { decode, type DetectedEncoding } from '../../core/encoding/decode';
import { checkCharset } from '../../core/formats/charset';
import { normalizeForTarget } from '../../core/formats/convert';
import { getTextFormat, TEXT_FORMAT_IDS, type TextFormatId } from '../../core/formats/registry';
import type { ParseWarning, SubtitleDocument, SubtitleFormat } from '../../core/model/types';
import { repairDocument, type RepairAction } from '../../core/repair';
import {
  getProFormat,
  loadProCodec,
  PRO_FORMAT_IDS,
  type ProFormatId,
} from '../../core/formats/pro';
import { assignUids } from '../editor/uid';

/** A file loaded into the session: the canonical doc plus import provenance. */
export interface LoadedDocument {
  /** Original file name, e.g. "movie.srt". */
  filename: string;
  /** Format the source was parsed as (Free text or Pro). */
  sourceFormat: TextFormatId | ProFormatId;
  /** Repaired canonical document. */
  doc: SubtitleDocument;
  /** Decoded text encoding, or `'binary'` for byte-based Pro formats (STL). */
  encoding: DetectedEncoding | 'binary';
  hadBom: boolean;
  /** Repairs applied on import (renumber / normalize-timing / fix-reversed). */
  repairs: RepairAction[];
  /** Warnings emitted while decoding or parsing the source. */
  parseWarnings: ParseWarning[];
  /**
   * QC accept keys (cue-forge-n3e.7): issues the operator has marked intentional
   * so they no longer count or re-surface on the next QC pass. App-layer review
   * metadata keyed on cue content (see `qc/accept.ts`) — deliberately NOT part of
   * the canonical `SubtitleDocument`, so it never reaches a serializer. Rides the
   * session autosave with the rest of `LoadedDocument`; absent until first accept.
   */
  qcAccepted?: string[];
}

/**
 * Normalize a core {@link SubtitleFormat} to `LoadedDocument['sourceFormat']`
 * (`TextFormatId | ProFormatId`) — cue-forge-sdv.11.6 final-review fix. The two
 * type families are *almost* the same set, but core's `SubtitleFormat` also
 * carries the ASS parser's legacy `'ssa'` id (the registered format id is
 * `'ass'`; `.ssa` is just one of its extensions), which is not a member of
 * either narrower type. `loadFreshDocument` (`SessionContext.tsx`) used to
 * paper over this with an `as` cast, which silently accepts any future
 * `SubtitleFormat` value — including ones that would break format-keyed
 * lookups downstream. This does the real mapping instead: known Free/Pro ids
 * pass through, `'ssa'` maps to `'ass'`, and anything else (none exist today —
 * `SubtitleFormat` is exhaustively covered — but this is future-proofing
 * against it growing without a matching update here) falls back to the
 * neutral `'srt'` default `resync.worker.ts`/`freshTranscriptDocument` already
 * use for synthetic documents.
 */
export function normalizeSourceFormat(format: SubtitleFormat): TextFormatId | ProFormatId {
  if (format === 'ssa') return 'ass';
  // Every other `SubtitleFormat` member is already a `TextFormatId |
  // ProFormatId` (TS narrows `format` to exactly that union here), so these
  // `includes` checks are the runtime mirror of that fact — they only ever
  // matter if `SubtitleFormat` grows a member neither registry lists yet.
  if ((TEXT_FORMAT_IDS as readonly string[]).includes(format)) return format;
  if ((PRO_FORMAT_IDS as readonly string[]).includes(format)) return format;
  return 'srt';
}

/** A file's lower-cased extension including the dot (e.g. ".srt"), or "". */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

/** Detect a Free-tier text format from a file name's extension, else null. */
export function detectFormatFromName(filename: string): TextFormatId | null {
  const ext = extensionOf(filename);
  if (ext === '') return null;
  for (const id of TEXT_FORMAT_IDS) {
    if (getTextFormat(id).extensions.includes(ext)) return id;
  }
  return null;
}

/** A detected import format, tagged with whether it requires a Pro license. */
export type DetectedFormat = { id: TextFormatId; pro: false } | { id: ProFormatId; pro: true };

/** Decode the first bytes as UTF-8 (non-fatal) for signature/root sniffing. */
function sniffHead(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512));
}

/** An EBU-STL GSI block carries the "STL25.01"/"STL30.01" Disk Format Code at byte 3. */
function looksLikeStl(bytes: Uint8Array): boolean {
  return bytes.length > 11 && bytes[3] === 0x53 && bytes[4] === 0x54 && bytes[5] === 0x4c; // "STL"
}

/** A TTML root element (`<tt …>`, optionally namespace-prefixed) in sniffed text. */
const TTML_ROOT_RE = /<(?:\w+:)?tt[\s/>]/;

/**
 * An EBU-TT-D document (a distribution-profile TTML) carries the distribution
 * URN — or an `ebuttm:` metadata prefix — that a plain-TTML `.xml` never does.
 * Used to disambiguate the shared `.xml`/TTML-root cases (both are `<tt>` XML).
 */
const EBUTTD_RE = /urn:ebu:tt:distribution|ebuttm:/;

/** MacCaption MCC files open with a fixed `File Format=MacCaption_MCC` header. */
const MCC_RE = /File Format=MacCaption_MCC/i;

/**
 * Detect an importable format — Free or Pro — from a file's name and bytes
 * (spec §4.1 #1, H1). Extension wins for unambiguous cases; `.xml` is
 * disambiguated by root element (`tt` → TTML, further split into EBU-TT-D vs
 * plain TTML by the distribution namespace; `fcpxml` is not importable yet),
 * and an unknown/missing extension falls back to content signatures (STL GSI,
 * the Scenarist SCC header, the MacCaption MCC header, a TTML root). Returns
 * null when nothing matches.
 */
export function detectImportFormat(filename: string, bytes: Uint8Array): DetectedFormat | null {
  const free = detectFormatFromName(filename);
  if (free) return { id: free, pro: false };

  const ext = extensionOf(filename);
  if (ext === '.scc') return { id: 'scc', pro: true };
  if (ext === '.stl') return { id: 'stl', pro: true };
  if (ext === '.itt') return { id: 'itt', pro: true };
  if (ext === '.mcc') return { id: 'mcc', pro: true };
  if (ext === '.ttml' || ext === '.dfxp') return { id: 'ttml', pro: true };
  if (ext === '.xml') {
    const head = sniffHead(bytes);
    if (!TTML_ROOT_RE.test(head)) return null;
    return EBUTTD_RE.test(head) ? { id: 'ebuttd', pro: true } : { id: 'ttml', pro: true };
  }

  // No or unknown extension: fall back to content signatures.
  if (looksLikeStl(bytes)) return { id: 'stl', pro: true };
  const head = sniffHead(bytes);
  if (/Scenarist_SCC/i.test(head)) return { id: 'scc', pro: true };
  if (MCC_RE.test(head)) return { id: 'mcc', pro: true };
  if (TTML_ROOT_RE.test(head)) {
    return EBUTTD_RE.test(head) ? { id: 'ebuttd', pro: true } : { id: 'ttml', pro: true };
  }
  return null;
}

/** Raised when an uploaded file's format cannot be determined. */
export class UnknownFormatError extends Error {
  constructor(filename: string) {
    super(
      `Unrecognized subtitle format for "${filename}". Supported: .srt, .vtt, .sbv, .ass/.ssa, and (Pro) .scc, .stl, .ttml, .itt, .mcc, .xml (EBU-TT-D).`,
    );
    this.name = 'UnknownFormatError';
  }
}

/** Raised when a Pro-format file is imported without a Pro license. */
export class ProImportLockedError extends Error {
  constructor(public readonly formatName: string) {
    super(`Opening ${formatName} files is a Pro feature. Unlock Pro to import ${formatName}.`);
    this.name = 'ProImportLockedError';
  }
}

/**
 * Hard cap on import size (cue-forge-9ww.3). Real subtitle files are well under
 * 1 MB even for feature-length content; this generous ceiling refuses
 * pathological inputs (a mis-dropped video, a multi-hundred-MB blob) before they
 * can hang the parser, while never rejecting a genuine caption file.
 */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

/** Raised when an import exceeds {@link MAX_IMPORT_BYTES}. */
export class FileTooLargeError extends Error {
  constructor(filename: string, bytes: number) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const limit = Math.round(MAX_IMPORT_BYTES / (1024 * 1024));
    super(
      `"${filename}" is ${mb} MB — too large to open (limit ${limit} MB). Subtitle files are usually under 1 MB; please check it's a subtitle file.`,
    );
    this.name = 'FileTooLargeError';
  }
}

/** Guard a buffer's size before any parsing work. */
function guardSize(filename: string, bytes: Uint8Array): void {
  if (bytes.length > MAX_IMPORT_BYTES) throw new FileTooLargeError(filename, bytes.length);
}

/**
 * Append an actionable warning when a recognized, non-empty file parsed to zero
 * cues — the common "wrong content behind a familiar extension" case. Truly
 * empty inputs are left alone.
 */
function withEmptyResultWarning(
  warnings: ParseWarning[],
  cueCount: number,
  hadContent: boolean,
  formatName: string,
  filename: string,
): ParseWarning[] {
  if (cueCount > 0 || !hadContent) return warnings;
  return [
    ...warnings,
    {
      code: 'empty-result',
      message: `No subtitles were found in "${filename}" — it may be empty or not a valid ${formatName} file.`,
    },
  ];
}

/**
 * Turn any load failure into one clear, user-facing sentence (cue-forge-9ww.3).
 * Our own errors already carry friendly copy; anything else (an unexpected throw
 * from a codec or decoder) collapses to a generic message rather than leaking a
 * stack string like "TypeError: …" into the UI. Malformed-but-parseable files
 * don't reach here — they load with an actionable {@link withEmptyResultWarning}.
 */
export function friendlyLoadError(err: unknown, filename: string): string {
  if (err instanceof UnknownFormatError || err instanceof FileTooLargeError) {
    return err.message;
  }
  return `Couldn't open "${filename}". The file may be corrupted or in an unsupported format.`;
}

/**
 * The export/convert/preset counterpart of {@link friendlyLoadError}
 * (cue-forge-w28.12): raw exception strings ("TypeError: …") must never reach
 * the UI. Our own error classes carry copy written for the operator, so their
 * messages pass through; anything unexpected collapses to the caller's calm
 * `fallback` sentence (which should offer a path forward, e.g. "try a different
 * target format"). Callers whose expected errors live in other modules (the
 * custom-preset store's quota error, say) list those classes in `alsoUserFacing`.
 */
export function friendlyErrorMessage(
  err: unknown,
  fallback: string,
  alsoUserFacing: ReadonlyArray<new (...args: never[]) => Error> = [],
): string {
  // Built inside the function: the class declarations below this point are in
  // their temporal dead zone at module-evaluation time.
  const userFacing: ReadonlyArray<new (...args: never[]) => Error> = [
    UnknownFormatError,
    FileTooLargeError,
    ProImportLockedError,
    CharsetUnsupportedError,
    ...alsoUserFacing,
  ];
  for (const cls of userFacing) {
    if (err instanceof cls) return err.message;
  }
  // The calm fallback deliberately hides the raw error from the UI — but the
  // original must not vanish entirely (site-review): one console.error here
  // preserves the diagnostic for every call site's unexpected-throw path.
  console.error(err);
  return fallback;
}

/**
 * Decode + parse + repair an uploaded file into a {@link LoadedDocument}.
 * `sourceFormat` overrides extension-based detection when the caller knows better.
 */
export function importBytes(
  filename: string,
  bytes: Uint8Array,
  sourceFormat?: TextFormatId,
): LoadedDocument {
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
      warning
        ? [{ code: 'encoding-assumed', message: warning }, ...parsed.warnings]
        : parsed.warnings,
      doc.cues.length,
      text.trim().length > 0,
      codec.name,
      filename,
    ),
  };
}

/** Options for {@link importFile}. */
export interface ImportOptions {
  /** Whether Pro-format imports (SCC/STL/TTML) are permitted (i.e. licensed). */
  allowPro: boolean;
}

/**
 * Detect, decode, parse, and repair any supported file — Free or Pro — into a
 * {@link LoadedDocument} (spec §4.1 #1, H1). Free formats take the synchronous
 * {@link importBytes} path; Pro codecs are loaded on demand via
 * {@link loadProCodec} (text codecs decode first; binary STL parses the raw
 * bytes). Pro imports require `allowPro`, otherwise {@link ProImportLockedError}
 * is thrown so the UI can show an upgrade prompt instead of a broken load.
 */
export async function importFile(
  filename: string,
  bytes: Uint8Array,
  opts: ImportOptions = { allowPro: false },
): Promise<LoadedDocument> {
  guardSize(filename, bytes);
  const detected = detectImportFormat(filename, bytes);
  if (!detected) throw new UnknownFormatError(filename);
  if (!detected.pro) return importBytes(filename, bytes, detected.id);

  if (!opts.allowPro) throw new ProImportLockedError(getProFormat(detected.id).name);

  const proName = getProFormat(detected.id).name;
  const codec = await loadProCodec(detected.id);
  let parsed: SubtitleDocument;
  let encoding: DetectedEncoding | 'binary' = 'binary';
  let hadBom = false;
  let hadContent = bytes.length > 0;
  let decodeWarning: string | undefined;
  if (codec.kind === 'binary') {
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
      decodeWarning
        ? [{ code: 'encoding-assumed', message: decodeWarning }, ...parsed.warnings]
        : parsed.warnings,
      doc.cues.length,
      hadContent,
      proName,
      filename,
    ),
  };
}

/** Result of serializing a session document to a target format. */
export interface ExportResult {
  text: string;
  /** Suggested download name: source base name with the target extension. */
  filename: string;
  format: TextFormatId;
  /** Capability-drop warnings from normalizing for the target. */
  warnings: ParseWarning[];
}

/** Swap a file name's extension for the target format's primary extension. */
export function retargetFilename(filename: string, target: TextFormatId): string {
  const ext = getTextFormat(target).extensions[0] ?? `.${target}`;
  const dot = filename.lastIndexOf('.');
  const base = dot < 0 ? filename : filename.slice(0, dot);
  return base + ext;
}

/** Serialize a session document to `target`, normalizing for its capabilities. */
export function exportDocument(loaded: LoadedDocument, target: TextFormatId): ExportResult {
  const { doc, warnings } = normalizeForTarget(loaded.doc, target);
  const text = getTextFormat(target).serialize(doc);
  return {
    text,
    filename: retargetFilename(loaded.filename, target),
    format: target,
    warnings,
  };
}

/** Result of serializing to a Pro format. Text codecs fill `text`; binary `bytes`. */
export interface ProExportResult {
  filename: string;
  format: ProFormatId;
  kind: 'text' | 'binary';
  text?: string;
  bytes?: Uint8Array;
  /**
   * Capability-drop warnings from normalizing for the target, charset
   * replacement warnings, and serializer warnings (e.g. SCC caption density).
   */
  warnings: ParseWarning[];
}

/**
 * Share of unrepresentable non-whitespace characters above which a Pro export
 * fails outright instead of emitting a garbage file (e.g. Arabic → SCC).
 */
export const CHARSET_FAIL_SHARE = 0.3;

/** Raised when a target charset cannot represent most of the document's text. */
export class CharsetUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharsetUnsupportedError';
  }
}

/** Swap a file name's extension for `ext` (e.g. ".scc"). */
function retargetExtension(filename: string, ext: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot < 0 ? filename : filename.slice(0, dot);
  return base + ext;
}

/**
 * Serialize a session document to a Pro format (spec §4.2). The codec is loaded
 * on demand via {@link loadProCodec} so TTML/SCC/STL stay in lazy chunks excluded
 * from the initial bundle; STL is binary so the result is discriminated by
 * `kind`. Gated behind the Pro license at the call site, not here.
 *
 * Like the free path, the document is normalized for the target's capabilities
 * first, and legacy-charset targets (SCC/STL) get a representability preflight:
 * a few unrepresentable characters warn (they are replaced on encode), but past
 * {@link CHARSET_FAIL_SHARE} the export throws {@link CharsetUnsupportedError}.
 */
export async function exportProDocument(
  loaded: LoadedDocument,
  target: ProFormatId,
): Promise<ProExportResult> {
  const codec = await loadProCodec(target);
  const { name, extensions } = getProFormat(target);
  const filename = retargetExtension(loaded.filename, extensions[0] ?? `.${target}`);
  const { doc, warnings } = normalizeForTarget(loaded.doc, target);

  if (codec.canEncodeChar) {
    const report = checkCharset(doc, codec.canEncodeChar);
    if (report.unrepresentable > 0) {
      const examples = report.samples.map((s) => `"${s}"`).join(', ');
      if (report.share > CHARSET_FAIL_SHARE) {
        throw new CharsetUnsupportedError(
          `${name} cannot represent ${report.unrepresentable} of ${report.total} character(s) (e.g. ${examples}); export aborted.`,
        );
      }
      warnings.push({
        code: 'charset-unrepresentable',
        message: `${name} cannot represent ${report.unrepresentable} character(s) (e.g. ${examples}); they will be replaced.`,
      });
    }
  }

  if (codec.kind === 'binary') {
    return { filename, format: target, kind: 'binary', bytes: codec.serialize(doc), warnings };
  }
  // Text codecs may push their own warnings (SCC density) into the same sink.
  return { filename, format: target, kind: 'text', text: codec.serialize(doc, warnings), warnings };
}

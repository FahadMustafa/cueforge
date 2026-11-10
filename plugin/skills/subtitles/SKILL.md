---
name: subtitles
description: Use when the user has a subtitle or caption file (.srt, .vtt, .sbv, .ass, .ssa, .ttml, .dfxp, .xml, .scc, .stl, .itt, .mcc) and wants to convert it to another format, for example SCC to SRT, SRT to EBU-STL, WebVTT to TTML or IMSC, or anything to Apple iTT, MCC or EBU-TT-D. Also use when they want subtitles checked against delivery rules (Netflix line length, reading speed or CPS, minimum and maximum duration, gaps between cues, overlaps, Arabic and right-to-left punctuation and digit rules), want those problems auto-fixed, want every cue moved earlier or later by a fixed offset, ask whether captions are ready for Netflix or YouTube, or ask which subtitle formats or QC presets are supported. Runs a local script on the file; do not convert, retime or fix subtitle text by hand.
---

# Subtitles

This skill runs CueForge, a local command-line tool, on subtitle files. It parses the file, works on a structured copy and writes a new file. Nothing is uploaded and the tool makes no network requests.

## Rules

1. Do the work with the script. Never convert a format, change timecodes or apply fixes by editing the subtitle text yourself, and never hand-write a subtitle format. If the script cannot do something, tell the user.
2. Always pass `-o <path>` with a location you can write to. Never write next to an uploaded file.
3. Relay the script's `warning:` lines to the user. They are the tool saying what it assumed, repaired or dropped.
4. Never call a file "delivery-ready" or "Netflix-ready". Report which preset ran, whether it is Verified or Draft, and what issues remain.

## Running the script

The script is `scripts/cueforge.mjs`, relative to this SKILL.md. It needs Node 22 or later and has nothing to install.

```sh
node "${CLAUDE_SKILL_DIR}/scripts/cueforge.mjs" --help
```

If `${CLAUDE_SKILL_DIR}` is not substituted (claude.ai chat does not substitute it), use the absolute path of the folder this SKILL.md is in, for example `/mnt/skills/plugins/cueforge:subtitles/scripts/cueforge.mjs`. Keep the path in quotes; it contains a colon.

Below, `cueforge` stands for `node "<skill folder>/scripts/cueforge.mjs"`.

## Where to write output

- **Claude chat or another sandbox:** uploaded files are read-only (for example under `/mnt/user-data/uploads/`). Write to the outputs folder, for example `-o /mnt/user-data/outputs/episode1.srt`, and give the user that file.
- **Claude Code:** files are on the user's disk. Write wherever the user asked; if they did not say, put the output next to the input with a clear name.
- The script refuses to overwrite an existing file. Pass `--force` only when the user asked to replace that file; otherwise choose another name.
- The script prints the path it wrote on stdout. Use that path when you report back.

## Commands

List formats and presets (run these when unsure; they are the authority):

```sh
cueforge formats    # id, name, extensions, text/binary, read, write
cueforge presets    # generic, netflix-latin, youtube, netflix-arabic, each Verified or Draft
```

Format ids for `--to`: `srt`, `vtt`, `sbv`, `ass`, `ttml`, `scc`, `stl` (EBU-STL, binary), `itt` (Apple iTT), `imsc101`, `imsc11`, `mcc`, `ebuttd` (EBU-TT-D). The input format comes from the file extension. Only SCC, EBU-STL, MCC and the TTML family are also recognised by their contents when the extension is missing or unknown (see Limits).

Convert:

```sh
cueforge convert input.scc --to srt -o out/input.srt
```

Check (QC). Prefer `--json`:

```sh
cueforge qc input.srt --preset netflix-latin --json
```

`--json` prints one object: `{ file, format, preset, presetBuiltin, presetVerified, cueCount, counts: { error, warning }, issues: [{ ruleId, cueIndex, severity, message, fixable }] }`. `cueIndex` is the 1-based cue number after import repairs; `-1` means the issue is about the whole document.

Auto-fix (writes the same format as the input):

```sh
cueforge fix input.srt --preset netflix-latin -o out/input.fixed.srt
```

Shift every cue by a signed number of milliseconds (`1500` is 1.5 s later, `-500` is half a second earlier):

```sh
cueforge shift input.srt --ms -500 -o out/input.shifted.srt
```

## Exit codes

- `0`: success. For `qc` it means no error-severity issues; warnings can still be present, so read the counts.
- `1`: `qc` found at least one error-severity issue. This is a result, not a tool failure. Report the issues.
- `2`: usage or input error. Read the `error:` line on stderr. Fix the command if it was yours (wrong flag, unknown format id, output already exists). If the file is the problem (unreadable, not a subtitle file, parses to no cues), tell the user what the error said. Do not retry the same command.

## Warnings

Warnings go to stderr, one per line, starting with `warning:`. Tell the user about each kind; summarise repeats (for example, 40 "Captions too dense" lines from an SCC export become one line with the count). They come in three groups:

- **Assumed encoding:** the file was not UTF-8, so the tool guessed its encoding. Ask the user to check that accented or Arabic text looks right. Output is always UTF-8.
- **Import repairs and parse notes:** the tool changed something on load (renumbered cues, swapped a reversed start and end) or noticed a problem in the source (overlapping cues, empty cues, lines it could not parse).
- **Conversion losses:** the target format cannot hold something the source had (styling, positioning, colour, native headers), so it was dropped.

## QC presets

| Preset           | Status   | Basis                                                                                                                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `netflix-latin`  | Verified | Thresholds cited to the Netflix English (USA) Timed Text Style Guide: 42 characters per line, 2 lines, 20 characters per second, 833 ms minimum, 7 s maximum, 2-frame gap |
| `netflix-arabic` | Verified | Thresholds cited to the Netflix Arabic Timed Text Style Guide, plus Arabic and RTL rules (bidi punctuation, digit style, Latin run isolation, kashida, ellipsis)          |
| `youtube`        | Draft    | Baseline for YouTube uploads, not verified                                                                                                                                |
| `generic`        | Draft    | Default when `--preset` is omitted; a general baseline, not tied to any spec                                                                                              |

- Pick the preset from what the user asked for: Netflix and Arabic text means `netflix-arabic`; Netflix and another language means `netflix-latin`. If the user named no target, run `generic` and say it is a draft baseline; offer the others.
- `--preset` also takes a path to a ruleset JSON file. A custom ruleset is never Verified (`presetBuiltin` and `presetVerified` are false); say so.
- Verified means the preset's thresholds are cited to that guide. It does not mean every rule in the guide is checked: shot changes, approved character lists, translation and placement against the picture are not.

Report a QC run like this: the preset and its status, the error and warning counts, then the issues grouped by rule with cue numbers, marking which are fixable. Example: "netflix-latin (Verified): 2 errors, 7 warnings. Reading speed over 20 cps on cues 1, 5 and 6 (fixable)..."

## After fix

1. `fix` prints `Resolved N issues, M remaining (...)`. Fixes can re-wrap lines, adjust cue timings, normalise punctuation and some characters, and remove empty cues. They never reword or translate text. Tell the user what kinds of changes were made.
2. Run `qc` on the fixed file with the same preset and report what is left.
3. Issues with `fixable: false` need a person (for example too many lines, duplicate cues, cues out of order). Some issues marked fixable can also remain: the tool undoes any fix that would create a new issue. List both kinds as manual work.

## Limits

- IMSC input is read as plain TTML, so `fix` and `shift` on an IMSC file write TTML without the IMSC profile. If the profile matters, convert the result with `--to imsc11` or `--to imsc101`.
- SCC, MCC and EBU-STL use legacy character sets that hold Latin-script text only. If more than 30% of the characters cannot be stored (Arabic, Cyrillic, Greek, Hebrew, CJK), the export stops with an error and writes nothing; fewer are replaced, with a warning. Do not retry. Offer `ebuttd`, `ttml`, `imsc11` or `itt`, which hold any script.
- `shift` moves every cue by the same amount. Cues pushed before zero are clamped to zero (there is a warning). It does not convert frame rates or correct drift.
- Inputs over 25 MB are rejected.
- A text format with the wrong extension (an SRT saved as `.txt`, say) is rejected as unrecognised. Copy it to a writable folder under the right extension and run the command on the copy.

For visual review, or editing against the video, the same engine runs in the browser at https://cue-forge.com, and files stay on the device.

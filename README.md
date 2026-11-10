# CueForge

CueForge converts subtitle and caption files between formats, checks them against delivery rules such as line length, reading speed and cue timing, and auto-fixes the issues that have a safe fix. It is a local script with no dependencies, used from a Claude plugin or as a command-line tool.

## Install as a Claude plugin

In Claude Code 2.1.275 or later:

```text
/plugin install cueforge --marketplace FahadMustafa/cueforge
```

On older versions, add the marketplace first, then install:

```text
/plugin marketplace add FahadMustafa/cueforge
/plugin install cueforge@cueforge
```

Then give Claude a subtitle file and say what you need: "convert this SCC file to SRT", "check these subtitles against the Netflix rules", "move every cue 1.5 seconds later". The plugin has one skill, `subtitles`, which runs the bundled script in `plugin/skills/subtitles/scripts/` and reports what it changed, dropped or found.

## Use as a command-line tool

Needs Node 22 or later. There is nothing else to install.

```sh
npx cueforge --help
npx cueforge convert episode1.scc --to srt -o episode1.srt
npx cueforge qc episode1.srt --preset netflix-latin
npx cueforge qc episode1.srt --preset netflix-latin --json
npx cueforge fix episode1.srt --preset netflix-latin -o episode1.fixed.srt
npx cueforge shift episode1.srt --ms -500 -o episode1.shifted.srt
npx cueforge formats
npx cueforge presets
```

Results and written paths go to stdout, warnings to stderr. The tool never overwrites an existing file unless you pass `--force`. Exit codes: `0` ok, `1` `qc` found at least one error-severity issue, `2` usage or input error.

Warnings say what the tool assumed or changed: a guessed text encoding for a file that was not UTF-8, repairs made on load (renumbered cues, a reversed start and end swapped), and anything the target format cannot hold, such as styling or positioning.

## Formats

| Id        | Format                    | Extensions               | Read               | Write |
| --------- | ------------------------- | ------------------------ | ------------------ | ----- |
| `srt`     | SubRip                    | `.srt`                   | yes                | yes   |
| `vtt`     | WebVTT                    | `.vtt`                   | yes                | yes   |
| `sbv`     | YouTube SBV               | `.sbv`                   | yes                | yes   |
| `ass`     | Advanced SubStation Alpha | `.ass`, `.ssa`           | yes                | yes   |
| `ttml`    | TTML / IMSC1              | `.ttml`, `.xml`, `.dfxp` | yes                | yes   |
| `scc`     | Scenarist Closed Caption  | `.scc`                   | yes                | yes   |
| `stl`     | EBU-STL (binary)          | `.stl`                   | yes                | yes   |
| `itt`     | Apple iTT                 | `.itt`                   | yes                | yes   |
| `imsc101` | IMSC 1.0.1                | `.ttml`, `.xml`          | read as plain TTML | yes   |
| `imsc11`  | IMSC 1.1                  | `.ttml`, `.xml`          | read as plain TTML | yes   |
| `mcc`     | MacCaption MCC (CEA-708)  | `.mcc`                   | yes                | yes   |
| `ebuttd`  | EBU-TT-D                  | `.xml`                   | yes                | yes   |

The input format comes from the file extension. SCC, EBU-STL, MCC and the TTML family are also recognised by their contents. Inputs over 25 MB are rejected.

## QC presets

| Preset           | Status   | Basis                                                                                                                                              |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `netflix-latin`  | Verified | Netflix English (USA) Timed Text Style Guide: 42 characters per line, 2 lines, 20 characters per second, 833 ms minimum, 7 s maximum, 2-frame gap  |
| `netflix-arabic` | Verified | Netflix Arabic Timed Text Style Guide, plus Arabic and right-to-left rules (bidi punctuation, digit style, Latin run isolation, kashida, ellipsis) |
| `youtube`        | Draft    | A baseline for YouTube uploads                                                                                                                     |
| `generic`        | Draft    | The default when `--preset` is omitted; a general baseline not tied to any spec                                                                    |

Verified means each threshold in the preset is cited to the named style guide. It does not mean a file that passes meets the whole guide: shot changes, approved character lists, translation and placement against the picture are not checked. Draft presets are baselines whose thresholds have not been checked against a published spec. `--preset` also takes a path to your own ruleset JSON file, which is always reported as Draft.

`fix` re-wraps lines, adjusts cue timings, normalises punctuation and some characters, and removes empty cues. It never rewords or translates text, and it undoes any fix that would create a new issue, so some fixable issues can remain.

## Privacy

The script runs where it is started: on your machine, or in the sandbox of the agent running the plugin. It reads the files you give it, writes the files you ask for, and makes no network requests: no account, no telemetry, nothing uploaded.

## Review and edit against video

For visual review, or for editing subtitles against the video, the same engine runs in the browser at https://cue-forge.com. Files stay on your device there too.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build          # dist/cueforge.mjs, the npm bin
npm run build:plugin   # rebuilds plugin/skills/subtitles/scripts/ from src/
```

The built plugin is committed under `plugin/` because Claude installs plugins straight from the repository. A test fails when the committed scripts differ from a fresh build, so run `npm run build:plugin` after changing anything in `src/`.

This code is exported from the CueForge web app's source tree, which is why the import pipeline lives under `src/app/session/`.

## Licence

MIT. See [LICENSE](LICENSE).

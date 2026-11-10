# CueForge

CueForge converts, checks and fixes subtitle and caption files. It reads and writes SRT, WebVTT, YouTube SBV, ASS/SSA, TTML (including IMSC 1.0.1, IMSC 1.1, Apple iTT and EBU-TT-D), Scenarist SCC, EBU-STL and MCC. It checks a file against delivery rules such as line length, reading speed, cue duration, gaps and overlaps, with presets based on the Netflix English (USA) and Arabic timed text style guides, and it can auto-fix the issues that have a safe fix and shift all timings by a fixed offset.

## Install

In Claude Code:

```text
/plugin install cueforge --marketplace FahadMustafa/cueforge
```

## How to use it

After installing the plugin, give Claude a subtitle file and say what you need, for example:

- "Convert this SCC file to SRT."
- "Check these subtitles against the Netflix rules."
- "Fix the reading-speed problems in this file."
- "Move every cue 1.5 seconds later."

Claude runs the bundled `subtitles` skill, which calls the command-line tool and reports the result, including anything the tool had to drop or repair.

You can also run the tool yourself with Node 22 or later:

```sh
node skills/subtitles/scripts/cueforge.mjs --help
node skills/subtitles/scripts/cueforge.mjs convert input.scc --to srt -o output.srt
node skills/subtitles/scripts/cueforge.mjs qc input.srt --preset netflix-latin
```

## What it runs, sends and fetches

The skill runs one local Node script, `skills/subtitles/scripts/cueforge.mjs`, on the files you give it, and writes new files only where it is told to. It sends nothing and fetches nothing: no network access, no account, no telemetry. The script has no dependencies to install.

The same engine runs in the browser at https://cue-forge.com, for reviewing and editing subtitles against video.

## License

MIT. See `LICENSE`.

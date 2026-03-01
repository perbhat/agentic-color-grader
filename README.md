# Color Grader

AI-powered color grading toolkit for video editors. Uses [Pi](https://github.com/mariozechner/pi-coding-agent) to give an LLM agent direct control over ffmpeg — it analyzes your footage, applies corrections, and iterates until the grade looks right.

Built for Sony S-Log workflows but works with any footage ffmpeg can read.

## What It Does

You talk to the Pi agent in natural language. It calls specialized color grading tools behind the scenes:

- **Analyze** footage numerically (luminance, chrominance, saturation, zone distribution)
- **Apply corrections** — LUT, exposure, contrast, gamma, color temperature, saturation, curves, color balance
- **Compare** before/after frames side-by-side
- **Match shots** — automatically derive corrections to make one clip match another
- **Detect scenes** — group clips by visual similarity
- **Render scopes** — waveform, parade, vectorscope, histogram
- **Live preview** — real-time ffplay playback with corrections applied
- **Import/export FCPXML** — roundtrip with Final Cut Pro
- **Export** — concatenated timeline or individual graded clips

The agent follows an iterative workflow: analyze → correct → re-analyze → refine. It reads every preview image it generates and adjusts based on both the numbers and what it sees.

## Prerequisites

- **[Pi](https://github.com/mariozechner/pi-coding-agent)** — the coding agent framework
- **ffmpeg** and **ffprobe** — installed and on your PATH
- **Node.js** 18+

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Verify
ffmpeg -version
ffprobe -version
```

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/color-grader.git
cd color-grader
```

No `npm install` needed — the extensions are loaded directly by Pi.

## Quick Start

### Single Clip

```bash
pi
```

Then tell the agent what you want:

```
Grade my S-Log3 footage at ./footage/interview.mov to Rec.709
```

The agent will:
1. Analyze the raw frame (detect it's S-Log, note the flat contrast and low saturation)
2. Apply the bundled S-Log3 → Rec.709 LUT
3. Re-analyze and fix exposure, white balance, saturation
4. Show you before/after comparisons
5. Export the final graded file

### Multiple Clips

```
Import my FCP timeline from ./MyProject.fcpxml, group the clips by scene,
grade the hero shot, then match all other clips to it and export.
```

The agent will run the full multi-clip workflow — import, scene detection, hero grading, shot matching, consistency verification, and export.

## Using with Final Cut Pro

### Import from FCP

1. In Final Cut Pro, select your project and go to **File → Export XML...**
2. Save the `.fcpxml` file somewhere accessible
3. Start Pi and tell it:

```
Import timeline from ./MyProject.fcpxml and grade all clips
```

The agent reads the FCPXML, resolves all source media paths, and populates its internal timeline with clip references and in/out points.

### Export Back to FCP

After grading, tell the agent:

```
Export graded clips for roundtrip back to Final Cut Pro
```

This uses `export_roundtrip` which:
- Renders each clip individually as ProRes (preserving quality)
- Generates a new `.fcpxml` file referencing the graded media
- You import that FCPXML into FCP and the graded clips drop into your timeline

Alternatively, for a single concatenated output:

```
Export the timeline as a single MP4
```

## Using with Premiere Pro

Premiere doesn't use FCPXML natively, but there are two workflows:

### Option A: XML Roundtrip via FCPXML

1. Export from Premiere as **Final Cut Pro XML** (File → Export → Final Cut Pro XML)
2. Import into the color grader as above
3. Export graded clips with `export_roundtrip`
4. In Premiere, relink media to the graded files, or import the graded clips and replace in your timeline

### Option B: Direct File Workflow

If you don't need XML roundtrip:

1. Export individual clips from Premiere (or note the file paths of your source media)
2. Tell the agent:

```
Grade these clips and match them to each other:
- ./clip1.mov
- ./clip2.mov
- ./clip3.mov
```

3. Import the exported graded files back into Premiere

## Available Tools

| Tool | Description |
|------|-------------|
| `analyze_frame` | Extract signal stats and auto-diagnose exposure, color cast, saturation |
| `apply_correction` | Build filter chain from correction params, render preview |
| `compare_frames` | Side-by-side or split before/after comparison |
| `detect_scenes` | Auto-group clips by visual similarity or metadata |
| `match_shots` | Derive corrections to match a target clip to a reference |
| `render_scopes` | Waveform, parade, vectorscope, histogram |
| `live_preview` | Real-time ffplay playback with corrections |
| `preview_server` | Local web dashboard with thumbnails and live updates |
| `import_timeline` | Parse FCPXML into internal timeline |
| `manage_timeline` | Create/edit timeline, assign groups, propagate grades |
| `export_timeline` | Concatenate all clips with corrections into one file |
| `export_roundtrip` | Export individual graded clips + FCPXML for NLE roundtrip |
| `export_video` | Apply filter chain to a single file and export |

## Correction Parameters

All corrections are composable. The agent builds an ffmpeg filter chain from these parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `lut` | string | LUT file path or `"slog3-to-rec709"` shorthand |
| `exposure` | number | Exposure in stops (0.3 = half stop brighter) |
| `contrast` | number | Contrast multiplier (1.0 = no change) |
| `gamma` | number | Gamma (< 1.0 = brighter midtones) |
| `gamma_r`, `gamma_g`, `gamma_b` | number | Per-channel gamma |
| `saturation` | number | Saturation multiplier (1.0 = no change) |
| `color_temperature` | number | Kelvin (6500 = neutral, lower = warmer) |
| `color_balance` | object | `{ shadows: {r,g,b}, midtones: {r,g,b}, highlights: {r,g,b} }` — values -1.0 to 1.0 |
| `curves` | object | `{ master, r, g, b }` — control points like `"0/0 0.25/0.3 1/1"` |
| `custom_filter` | string | Raw ffmpeg filter (escape hatch) |

## Bundled LUTs

- **slog3-to-rec709** — Sony S-Log3 to Rec.709 conversion (also works for S-Log2 as a starting point)

Place additional `.cube` LUT files in the `luts/` directory and reference them by path.

## How It Works

The agent follows two built-in workflows (Pi "skills"):

### Single-Clip Grading (`slog-to-rec709`)
1. Analyze raw footage — identify it as log, note the flat profile
2. Apply LUT — convert log gamma curve to Rec.709
3. Iteratively fix exposure, white balance, saturation — one adjustment at a time, re-analyze after each
4. Verify with scopes and visual comparison
5. Export

### Multi-Clip Grading (`multi-clip-grade`)
1. Import timeline (FCPXML or manual file list)
2. Auto-group clips by visual similarity
3. Grade the hero (reference) clip in each group
4. Propagate the hero grade to all clips in the group
5. Fine-tune each clip with `match_shots` to match the reference
6. Verify consistency (YAVG within ±5, UAVG/VAVG within ±3)
7. Export

### Target Values (Rec.709)

| Metric | Target | Notes |
|--------|--------|-------|
| YMIN | 0–16 | Black level |
| YAVG | 80–140 | Average luminance (scene dependent) |
| YMAX | 235–255 | Peak white |
| UAVG | ~128 | Neutral chroma (blue-yellow axis) |
| VAVG | ~128 | Neutral chroma (red-green axis) |
| SATAVG | 40–80 | Moderate saturation |

## Project Structure

```
color-grader/
├── package.json                    # Pi package config
├── luts/
│   └── slog3-to-rec709.cube       # Bundled LUT
└── .pi/
    ├── extensions/                 # Tool implementations
    │   ├── analyze-frame.ts
    │   ├── apply-correction.ts
    │   ├── compare-frames.ts
    │   ├── detect-scenes.ts
    │   ├── export-roundtrip.ts
    │   ├── export-timeline.ts
    │   ├── export-video.ts
    │   ├── import-timeline.ts
    │   ├── live-preview.ts
    │   ├── manage-timeline.ts
    │   ├── match-shots.ts
    │   ├── preview-server.ts
    │   ├── render-scopes.ts
    │   └── lib/
    │       ├── ffmpeg.ts           # FFmpeg/ffprobe wrappers, filter chain builder
    │       ├── fcpxml.ts           # FCPXML parser and generator
    │       └── timeline.ts         # Timeline data model and persistence
    └── skills/                     # High-level workflow guides
        ├── slog-to-rec709/         # Single-clip S-Log correction
        └── multi-clip-grade/       # Multi-clip timeline grading
```

Working data (timeline state, preview frames, scope renders) is stored in `.color-grader-tmp/` within your project directory. This directory is created automatically and can be safely deleted at any time.

## License

MIT

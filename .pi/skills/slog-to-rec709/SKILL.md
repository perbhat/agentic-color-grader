# S-Log to Rec.709 Color Correction

## When to Use

Trigger this workflow when the user asks to:
- Color correct S-Log (SLog2 or SLog3) footage
- Convert log footage to Rec.709
- Fix flat/washed-out Sony camera footage
- Grade Sony A7, FX3, FX6, FX30, or similar camera footage

## Key Principles

**One adjustment at a time, always re-analyze after each change.** Never stack multiple untested corrections. The iterative loop is: analyze → correct → analyze → correct → ...

**Always visually inspect.** After every tool call that generates an image, READ the image file to visually evaluate the result. Numbers tell you the signal is correct; your eyes tell you the image looks right. Check for skin tone quality, banding, color casts that stats might miss, and overall aesthetic. The tools will output image paths prefixed with "⚡ VISUAL CHECK" — always read those files.

**Use live_preview for real-time feedback.** Open an ffplay window with `live_preview(action: "play")` at the start of grading, and update it with each correction via `live_preview(action: "update")`. This lets the user watch the video transform in real time.

## Target Values (Rec.709)

| Metric | Broadcast Safe | Web/Full Range | Notes |
|--------|---------------|----------------|-------|
| YMIN   | 16            | 0-5            | Black level |
| YAVG   | 80-130        | 80-140         | Average luminance (scene dependent) |
| YMAX   | 235           | 250-255        | Peak white |
| UAVG   | ~128          | ~128           | Neutral = 128 |
| VAVG   | ~128          | ~128           | Neutral = 128 |
| SATAVG | 40-80         | 40-80          | Moderate saturation |

## Step-by-Step Workflow

### Step 1: Analyze Raw Footage

```
analyze_frame(video: "input.mp4")
```

**What to look for:**
- S-Log footage will show YMIN ~30-40 (lifted blacks), YAVG ~80-100 (flat midtones), YMAX ~170-200 (compressed highlights)
- Low saturation (SATAVG ~10-30)
- These are NORMAL for log footage — the LUT will fix the primary issues

### Step 2: Apply LUT Conversion

```
apply_correction(video: "input.mp4", corrections: { lut: "slog3-to-rec709" })
```

This is the most critical step. The LUT converts the logarithmic gamma curve to Rec.709's standard gamma, which:
- Expands contrast (blacks get darker, whites get brighter)
- Restores color saturation
- Maps the log curve to a display-referred image

### Step 3: Analyze Post-LUT

```
analyze_frame(video: "input.mp4", filter_chain: "<chain from step 2>")
```

**After LUT application, check:**
- Is YMIN now near 0-16? If still too high → need to lower blacks
- Is YMAX near 235-255? If too low → need to lift highlights
- Is YAVG in 80-140 range? If not → adjust exposure/gamma
- Are UAVG/VAVG near 128? If not → color cast needs correction
- Is SATAVG in 40-80 range? If too high/low → adjust saturation

### Step 4: Fix Exposure (if needed)

If the image is too dark or bright after LUT:

```
apply_correction(video: "input.mp4", corrections: {
  lut: "slog3-to-rec709",
  exposure: 0.3,          // positive = brighter, negative = darker (in stops)
  gamma: 0.95             // <1 = brighter midtones, >1 = darker midtones
})
```

**Guidelines:**
- Adjust exposure in small increments (0.1-0.3 stops)
- Use gamma to shift midtones without affecting blacks/whites
- Re-analyze after each adjustment

### Step 5: Fix White Balance (if needed)

If UAVG or VAVG deviate from 128:

```
apply_correction(video: "input.mp4", corrections: {
  lut: "slog3-to-rec709",
  exposure: 0.3,                    // keep previous corrections
  color_temperature: 6200           // <6500 = warmer, >6500 = cooler
})
```

**Color cast interpretation:**
- UAVG > 133: Blue cast → lower color_temperature (warm it up)
- UAVG < 123: Yellow cast → raise color_temperature (cool it down)
- VAVG > 133: Red/magenta cast → use color_balance to reduce red
- VAVG < 123: Green/cyan cast → use color_balance to reduce green

**For fine control, use color_balance:**
```
corrections: {
  ...previous,
  color_balance: {
    shadows:    { r: 0.0, g: 0.0, b: 0.0 },
    midtones:   { r: -0.05, g: 0.0, b: 0.05 },  // reduce red, add blue
    highlights: { r: 0.0, g: 0.0, b: 0.0 }
  }
}
```

### Step 6: Fix Saturation (if needed)

```
apply_correction(video: "input.mp4", corrections: {
  ...previous,
  saturation: 1.1    // >1 = more saturated, <1 = less saturated
})
```

**Guidelines:**
- S-Log footage often needs a slight saturation boost (1.05-1.2) after LUT
- Oversaturated skin tones are a common issue — check vectorscope
- Target SATAVG of 40-80 for natural-looking results

### Step 7: Visual Verification

```
render_scopes(video: "input.mp4", filter_chain: "<final chain>", scopes: ["waveform", "vectorscope"])
compare_frames(video: "input.mp4", filter_chain: "<final chain>")
```

**Waveform check:**
- Signal should span most of the 0-255 range (or 16-235 for broadcast)
- No large areas crushed to 0 or clipped at 255
- Smooth distribution without hard bands

**Vectorscope check:**
- Signal should be centered (no strong pull in one direction)
- Skin tones should fall along the skin tone line (~11 o'clock position)
- No extreme saturation spikes

### Step 8: Export

```
export_video(video: "input.mp4", output: "output_rec709.mp4", filter_chain: "<final chain>")
```

## Reading the Diagnosis

The `analyze_frame` tool provides automatic diagnosis. Here's how to act on each:

| Diagnosis | Action |
|-----------|--------|
| UNDEREXPOSED | Increase exposure (+0.2 to +0.5) or lower gamma (<1.0) |
| OVEREXPOSED | Decrease exposure (-0.2 to -0.5) or raise gamma (>1.0) |
| LIFTED BLACKS | Expected pre-LUT; post-LUT: add contrast or use curves to lower blacks |
| CRUSHED BLACKS | Reduce contrast or lift shadows via color_balance |
| LOW HIGHLIGHTS | Increase exposure or use curves to lift highlights |
| CLIPPED HIGHLIGHTS | Decrease exposure or use curves to pull down highlights |
| COLOR CAST | Adjust color_temperature or color_balance per the direction indicated |
| LOW SATURATION | Expected pre-LUT; post-LUT: increase saturation (1.05-1.2) |
| HIGH SATURATION | Decrease saturation (0.8-0.95) |

## Common Pitfalls

1. **Don't skip the LUT step** — manual curves cannot properly linearize the S-Log gamma
2. **Don't adjust saturation before exposure** — exposure changes affect perceived saturation
3. **Don't over-correct** — small adjustments (0.1-0.2 at a time) prevent overcorrection
4. **Always re-analyze** — never assume a correction worked; verify numerically
5. **Use compare_frames** — the before/after visual is essential for judging the result
6. **Watch skin tones** — they're the most sensitive indicator of correct white balance

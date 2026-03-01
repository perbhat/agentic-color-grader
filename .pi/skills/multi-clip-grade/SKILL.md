# Multi-Clip Color Grading

## When to Use

Trigger this workflow when the user asks to:
- Grade multiple clips or an entire timeline
- Match colors across different shots/clips
- Ensure visual consistency across a sequence
- Batch-grade footage from a shoot
- Create a final edit from multiple graded clips

## Key Principle

**Grade the hero clip first, then propagate and fine-tune.** Never grade each clip from scratch — start with the best/most representative clip, get it perfect, copy that grade to similar clips, then match each one to the hero. This ensures consistency and saves time.

## Workflow

### Step 1: Create Timeline

```
manage_timeline(timeline_dir: ".", action: "create", name: "My Project")
```

### Step 2: Add Clips

```
manage_timeline(timeline_dir: ".", action: "add_clip", video: "clip1.mp4")
manage_timeline(timeline_dir: ".", action: "add_clip", video: "clip2.mp4")
manage_timeline(timeline_dir: ".", action: "add_clip", video: "clip3.mp4")
```

### Step 3: Auto-Group by Visual Similarity

```
detect_scenes(videos: ["clip1.mp4", "clip2.mp4", "clip3.mp4"], timeline_dir: ".", method: "visual")
```

This analyzes each clip's color signature and groups visually similar clips together. The first clip in each group becomes the reference (hero) clip.

**Alternative: Manual grouping**
```
manage_timeline(timeline_dir: ".", action: "set_group", clip_id: "clip-01", group: "interior")
manage_timeline(timeline_dir: ".", action: "set_group", clip_id: "clip-02", group: "interior")
manage_timeline(timeline_dir: ".", action: "set_group", clip_id: "clip-03", group: "exterior")
```

### Step 4: Grade the Hero Clip

For each group's reference clip, run the single-clip slog-to-rec709 workflow:

1. `analyze_frame(video: "<hero clip>")` — assess raw footage
2. `apply_correction(video: "<hero clip>", corrections: { lut: "slog3-to-rec709" })` — apply LUT
3. `analyze_frame(video: "<hero clip>", filter_chain: "<chain>")` — check post-LUT
4. Fix exposure, white balance, saturation iteratively (see slog-to-rec709 skill)
5. Continue until the hero clip looks correct

### Step 5: Propagate Grade to Group

```
manage_timeline(timeline_dir: ".", action: "propagate", from_clip_id: "clip-01")
```

This copies the hero clip's corrections to all other clips in the same group. It's a starting point — each clip will need fine-tuning.

### Step 6: Match Each Shot to the Hero

For each non-reference clip in the group:

```
match_shots(timeline_dir: ".", reference_clip_id: "clip-01", target_clip_id: "clip-02", match_aspects: ["all"])
```

This compares the target's stats to the reference and derives corrections for:
- **Exposure**: matches average luminance (YAVG)
- **White balance**: matches chrominance (UAVG, VAVG)
- **Saturation**: matches saturation level (SATAVG)

**Match order matters:**
1. Match exposure first (`match_aspects: ["exposure"]`)
2. Then white balance (`match_aspects: ["white_balance"]`)
3. Then saturation (`match_aspects: ["saturation"]`)

Or use `["all"]` to match everything at once.

### Step 7: Verify Consistency

After matching all clips in a group, verify consistency:

```
analyze_frame(video: "clip1.mp4", filter_chain: "<clip-01 chain>")
analyze_frame(video: "clip2.mp4", filter_chain: "<clip-02 chain>")
```

**Consistency targets (across clips in a group):**
- YAVG should be within ±5 of the reference
- UAVG/VAVG should be within ±3 of the reference
- SATAVG should be within ±5 of the reference

Use `compare_frames` between adjacent clips to visually check the transition:
```
compare_frames(video: "clip1.mp4", filter_chain: "<chain>")
compare_frames(video: "clip2.mp4", filter_chain: "<chain>")
```

### Step 8: Export

```
export_timeline(timeline_dir: ".", output: "final_graded.mp4")
```

This encodes each clip with its combined corrections and concatenates them into a single output file.

**Export specific clips only:**
```
export_timeline(timeline_dir: ".", output: "scene1_graded.mp4", clip_ids: ["clip-01", "clip-02"])
```

## Managing Groups

**Apply a base grade to an entire group:**
```
manage_timeline(timeline_dir: ".", action: "apply_group_grade", group: "interior", corrections: {
  lut: "slog3-to-rec709",
  exposure: 0.2,
  saturation: 1.1
})
```

**Check timeline status:**
```
manage_timeline(timeline_dir: ".", action: "status")
```

## Key Principles

1. **Grade the best clip first** — pick the most representative, well-exposed shot as the hero
2. **Propagate then fine-tune** — don't grade each clip from scratch; start from the hero's grade
3. **Match exposure first** — exposure changes affect perceived white balance and saturation
4. **Check consistency after each group** — verify stats across clips before moving to the next group
5. **Always visually inspect** — after every tool call that outputs an image path (marked with ⚡ VISUAL CHECK), READ the image to evaluate the result. Numbers alone miss skin tone issues, banding, and color casts.
6. **Use live_preview** — open `live_preview(action: "play")` for the hero clip, update with each correction so the user can watch the grade develop in real time
7. **One group at a time** — complete one group before starting the next

## Common Pitfalls

1. **Don't grade clips independently** — they'll look inconsistent when cut together
2. **Don't skip propagation** — starting from scratch on each clip wastes time and creates inconsistency
3. **Don't match before the hero is graded** — the reference must be correct first
4. **Don't ignore group base corrections** — they ensure a consistent foundation
5. **Don't export without verifying** — always check stats and visual comparisons before final export
6. **Don't forget to re-analyze** — after every correction, verify numerically

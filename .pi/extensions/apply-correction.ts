import { tool, ToolResult } from "pi-ext";
import {
	runFfmpeg,
	buildFilterChain,
	resolveTimecode,
	type CorrectionParams,
} from "./lib/ffmpeg.ts";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

export default tool({
	name: "apply_correction",
	description:
		"Build an ffmpeg filter chain from correction parameters and render a preview frame. " +
		"Returns the preview image path and the complete filter chain string for reuse in subsequent analyze/render/export calls. " +
		'Supports LUT application (use lut: "slog3-to-rec709" for the bundled LUT), exposure, contrast, gamma, ' +
		"per-channel gamma, saturation, color temperature, color balance (shadows/midtones/highlights), curves, and custom filters.",
	parameters: {
		video: {
			type: "string",
			description: "Path to the video file.",
		},
		timecode: {
			type: "string",
			description: 'Timecode for the preview frame. Default: "00:00:01".',
			default: "00:00:01",
		},
		corrections: {
			type: "object",
			description: `Correction parameters object. Supported keys:
  - lut: string — LUT file path or shorthand ("slog3-to-rec709")
  - exposure: number — exposure compensation in stops (e.g., 0.5 = half stop brighter)
  - contrast: number — contrast multiplier (1.0 = no change)
  - gamma: number — gamma value (1.0 = no change, <1 = brighter midtones)
  - gamma_r/gamma_g/gamma_b: number — per-channel gamma
  - saturation: number — saturation multiplier (1.0 = no change)
  - color_temperature: number — color temperature in Kelvin (6500 = neutral)
  - color_balance: object — { shadows?: {r,g,b}, midtones?: {r,g,b}, highlights?: {r,g,b} } values -1.0 to 1.0
  - curves: object — { master?: string, r?: string, g?: string, b?: string } control points like "0/0 0.25/0.3 0.75/0.7 1/1"
  - custom_filter: string — raw ffmpeg filter to append`,
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const videoPath = resolve(params.video);
		if (!existsSync(videoPath)) {
			return { error: `Video file not found: ${videoPath}` };
		}

		const tc = resolveTimecode(params.timecode ?? "00:00:01");
		const corrections = params.corrections as CorrectionParams;

		if (!corrections || Object.keys(corrections).length === 0) {
			return { error: "No corrections provided. Supply at least one correction parameter." };
		}

		const filterChain = buildFilterChain(corrections);
		if (!filterChain) {
			return { error: "Filter chain is empty. Check correction parameters." };
		}

		const outDir = resolve(dirname(videoPath), ".color-grader-tmp");
		const previewPath = resolve(outDir, "correction-preview.png");

		// Ensure output directory
		const { execFile } = await import("child_process");
		const { promisify } = await import("util");
		const exec = promisify(execFile);
		await exec("mkdir", ["-p", [outDir]]);

		// Render preview frame with corrections
		const args = [
			"-ss", tc,
			"-i", videoPath,
			"-vf", filterChain,
			"-frames:v", "1",
			"-q:v", "2",
			previewPath,
		];

		try {
			await runFfmpeg(args);
		} catch (err: any) {
			return { error: `Preview render failed: ${err.message}` };
		}

		const report = [
			"═══ CORRECTION APPLIED ═══",
			`Video: ${videoPath}`,
			`Timecode: ${tc}`,
			"",
			"── Filter Chain ──",
			filterChain,
			"",
			"── Corrections ──",
			...Object.entries(corrections).map(([key, val]) =>
				`  ${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`
			),
			"",
			"",
			`⚡ VISUAL CHECK: Read this image to visually inspect the correction: ${previewPath}`,
			"",
			"Next steps:",
			"  1. READ the preview image above to visually judge the correction",
			"  2. Use analyze_frame with this filter_chain to verify numerically",
			"  3. Use render_scopes to inspect waveform/vectorscope",
			"  4. Add more corrections by including previous params + new adjustments",
			"  5. When satisfied, use export_video with this filter_chain",
		].join("\n");

		return { output: report };
	},
});

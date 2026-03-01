import { tool, ToolResult } from "pi-ext";
import { runFfmpeg, resolveTimecode } from "./lib/ffmpeg.ts";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

type ScopeType = "waveform" | "parade" | "vectorscope" | "histogram";

const SCOPE_FILTERS: Record<ScopeType, string> = {
	waveform: "waveform=mode=column:filter=lowpass:graticule=green:flags=numbers+dots",
	parade: "waveform=mode=column:display=parade:filter=lowpass:graticule=green:flags=numbers+dots",
	vectorscope: "vectorscope=mode=color2:graticule=green:flags=name",
	histogram: "histogram=display_mode=parade:levels_mode=logarithmic",
};

export default tool({
	name: "render_scopes",
	description:
		"Generate visual scope images (waveform, parade, vectorscope, histogram) for a video frame. " +
		"Optionally applies a filter chain first (for viewing scopes of corrected footage). " +
		"Returns file paths to scope images that can be viewed with the read tool.",
	parameters: {
		video: {
			type: "string",
			description: "Path to the video file.",
		},
		timecode: {
			type: "string",
			description: 'Timecode for the frame. Default: "00:00:01".',
			default: "00:00:01",
		},
		scopes: {
			type: "array",
			description: 'Array of scope types to render. Options: "waveform", "parade", "vectorscope", "histogram". Default: all.',
			default: ["waveform", "parade", "vectorscope", "histogram"],
		},
		filter_chain: {
			type: "string",
			description: "Optional ffmpeg filter chain to apply before rendering scopes.",
			default: "",
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const videoPath = resolve(params.video);
		if (!existsSync(videoPath)) {
			return { error: `Video file not found: ${videoPath}` };
		}

		const tc = resolveTimecode(params.timecode ?? "00:00:01");
		const scopes = (params.scopes ?? ["waveform", "parade", "vectorscope", "histogram"]) as ScopeType[];
		const outDir = resolve(dirname(videoPath), ".color-grader-tmp");

		const { execFile } = await import("child_process");
		const { promisify } = await import("util");
		const exec = promisify(execFile);
		await exec("mkdir", ["-p", [outDir]]);

		const results: string[] = [];
		const errors: string[] = [];

		for (const scope of scopes) {
			const scopeFilter = SCOPE_FILTERS[scope];
			if (!scopeFilter) {
				errors.push(`Unknown scope type: "${scope}". Valid types: waveform, parade, vectorscope, histogram.`);
				continue;
			}

			// Build filter: optional corrections → split → [scope output, frame output]
			let vf: string;
			if (params.filter_chain) {
				vf = `${params.filter_chain},${scopeFilter}`;
			} else {
				vf = scopeFilter;
			}

			const outPath = resolve(outDir, `scope-${scope}.png`);
			const args = [
				"-ss", tc,
				"-i", videoPath,
				"-vf", vf,
				"-frames:v", "1",
				"-q:v", "2",
				outPath,
			];

			try {
				await runFfmpeg(args);
				results.push(`${scope}: ${outPath}`);
			} catch (err: any) {
				errors.push(`${scope}: render failed — ${err.message}`);
			}
		}

		const report = [
			"═══ SCOPE RENDERS ═══",
			`Video: ${videoPath}`,
			`Timecode: ${tc}`,
			params.filter_chain ? `Filter chain: ${params.filter_chain}` : "Filter chain: (none — raw footage)",
			"",
			"── Generated Scopes ──",
			...results.map((r) => `  ✓ ${r}`),
			...(errors.length > 0 ? ["", "── Errors ──", ...errors.map((e) => `  ✗ ${e}`)] : []),
			"",
			"⚡ VISUAL CHECK: Read each scope image above to visually inspect the signal distribution.",
		].join("\n");

		return { output: report };
	},
});

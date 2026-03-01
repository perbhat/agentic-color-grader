import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runFfmpeg, resolveTimecode } from "./lib/ffmpeg.ts";

type ScopeType = "waveform" | "parade" | "vectorscope" | "histogram";

const SCOPE_FILTERS: Record<ScopeType, string> = {
	waveform: "waveform=mode=column:filter=lowpass:graticule=green:flags=numbers+dots",
	parade: "waveform=mode=column:display=parade:filter=lowpass:graticule=green:flags=numbers+dots",
	vectorscope: "vectorscope=mode=color2:graticule=green:flags=name",
	histogram: "histogram=display_mode=parade:levels_mode=logarithmic",
};

const Parameters = Type.Object({
	video: Type.String({ description: "Path to the video file." }),
	timecode: Type.Optional(Type.String({ description: 'Timecode for the frame. Default: "00:00:01".' })),
	scopes: Type.Optional(Type.Array(Type.String(), { description: 'Array of scope types to render. Options: "waveform", "parade", "vectorscope", "histogram". Default: all.' })),
	filter_chain: Type.Optional(Type.String({ description: "Optional ffmpeg filter chain to apply before rendering scopes." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "render_scopes",
		label: "Render Scopes",
		description:
			"Generate visual scope images (waveform, parade, vectorscope, histogram) for a video frame. " +
			"Optionally applies a filter chain first (for viewing scopes of corrected footage). " +
			"Returns scope images for visual inspection.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const videoPath = resolve(params.video);
			if (!existsSync(videoPath)) {
				return { content: [{ type: "text", text: `Error: Video file not found: ${videoPath}` }], details: undefined };
			}

			const tc = resolveTimecode(params.timecode ?? "00:00:01");
			const scopes = (params.scopes ?? ["waveform", "parade", "vectorscope", "histogram"]) as ScopeType[];
			const outDir = resolve(dirname(videoPath), ".color-grader-tmp");

			const { execFile } = await import("child_process");
			const { promisify } = await import("util");
			const exec = promisify(execFile);
			await exec("mkdir", ["-p", outDir]);

			const results: string[] = [];
			const errors: string[] = [];
			const content: any[] = [];

			for (const scope of scopes) {
				const scopeFilter = SCOPE_FILTERS[scope];
				if (!scopeFilter) {
					errors.push(`Unknown scope type: "${scope}". Valid types: waveform, parade, vectorscope, histogram.`);
					continue;
				}

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

					// Read and include scope image
					try {
						const imgData = await readFile(outPath);
						content.push({ type: "text" as const, text: `\n── ${scope} scope ──` });
						content.push({ type: "image" as const, data: imgData.toString("base64"), mimeType: "image/png" });
					} catch {
						// File saved but couldn't read for inline
					}
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
			].join("\n");

			// Prepend the text report
			content.unshift({ type: "text" as const, text: report });

			return { content, details: undefined };
		},
	});
};

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import {
	runFfmpeg,
	extractSignalStats,
	buildFilterChain,
	diagnoseExposure,
	deriveCorrectionFromStats,
	resolveTimecode,
	prepareImageForApi,
	type CorrectionParams,
} from "./lib/ffmpeg.ts";
import { detectSourceFormat } from "./lib/timeline.ts";

const Parameters = Type.Object({
	video: Type.String({ description: "Path to the video file." }),
	timecode: Type.Optional(Type.String({ description: 'Timecode for the analysis/preview frame. Default: "00:00:01".' })),
	lut: Type.Optional(Type.String({ description: 'LUT to apply. Default: auto-detected based on source format. Use "slog3-to-rec709" for Sony S-Log footage.' })),
	extra_corrections: Type.Optional(Type.Any({ description: "Additional corrections to merge on top of the auto-derived ones (e.g., creative saturation boost)." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "auto_correct_base",
		label: "Auto Correct Base",
		description:
			"Automatically color correct footage from log/S-Log to a neutral Rec.709 base in a single step. " +
			"Detects source format, applies the appropriate LUT, analyzes post-LUT stats, then auto-derives " +
			"exposure, white balance (tint removal), contrast, and saturation corrections to produce a clean, " +
			"neutral starting point. Returns a preview image, the complete filter chain, and correction parameters " +
			"that can be further refined. This replaces the manual analyze→correct→analyze→correct loop for the " +
			"initial base grade.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const videoPath = resolve(params.video);
			if (!existsSync(videoPath)) {
				return { content: [{ type: "text", text: `Error: Video file not found: ${videoPath}` }], details: undefined };
			}

			const tc = resolveTimecode(params.timecode ?? "00:00:01");
			const outDir = resolve(dirname(videoPath), ".color-grader-tmp");
			const { execFile } = await import("child_process");
			const { promisify } = await import("util");
			const exec = promisify(execFile);
			await exec("mkdir", ["-p", outDir]);

			const reportLines: string[] = ["═══ AUTO CORRECT BASE ═══", `Video: ${videoPath}`, `Timecode: ${tc}`, ""];

			// ── Step 1: Detect source format ──
			const sourceFormat = await detectSourceFormat(videoPath);
			reportLines.push(`Source format: ${sourceFormat}`);

			// ── Step 2: Analyze raw footage ──
			let rawStats;
			try {
				rawStats = await extractSignalStats(videoPath, tc);
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: Raw analysis failed: ${err.message}` }], details: undefined };
			}
			reportLines.push("", "── Raw Footage Stats ──");
			reportLines.push(`  YAVG=${rawStats.YAVG.toFixed(1)} YMIN=${rawStats.YMIN.toFixed(0)} YMAX=${rawStats.YMAX.toFixed(0)}`);
			reportLines.push(`  UAVG=${rawStats.UAVG.toFixed(1)} VAVG=${rawStats.VAVG.toFixed(1)} SATAVG=${rawStats.SATAVG.toFixed(1)}`);

			// ── Step 3: Determine LUT ──
			let lutKey = params.lut;
			if (!lutKey) {
				const isLog = /^(slog|log)/i.test(sourceFormat);
				if (isLog) {
					lutKey = "slog3-to-rec709";
				}
				// HLG/PQ footage could use a different LUT — for now we flag it
			}

			// ── Step 4: Apply LUT and analyze post-LUT ──
			const baseCorrectionParams: CorrectionParams = {};
			if (lutKey) {
				baseCorrectionParams.lut = lutKey;
				reportLines.push("", `── LUT Applied: ${lutKey} ──`);
			} else {
				reportLines.push("", "── No LUT needed (source is already Rec.709 or unknown) ──");
			}

			const lutChain = buildFilterChain(baseCorrectionParams);
			let postLutStats;
			try {
				postLutStats = await extractSignalStats(videoPath, tc, lutChain || undefined);
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: Post-LUT analysis failed: ${err.message}` }], details: undefined };
			}

			reportLines.push("", "── Post-LUT Stats ──");
			reportLines.push(`  YAVG=${postLutStats.YAVG.toFixed(1)} YMIN=${postLutStats.YMIN.toFixed(0)} YMAX=${postLutStats.YMAX.toFixed(0)}`);
			reportLines.push(`  UAVG=${postLutStats.UAVG.toFixed(1)} VAVG=${postLutStats.VAVG.toFixed(1)} SATAVG=${postLutStats.SATAVG.toFixed(1)}`);
			reportLines.push("", "── Post-LUT Diagnosis ──");
			reportLines.push(diagnoseExposure(postLutStats));

			// ── Step 5: Auto-derive corrections from post-LUT stats ──
			const derived = deriveCorrectionFromStats(postLutStats);
			const finalCorrections: CorrectionParams = { ...baseCorrectionParams };

			if (derived.exposure !== undefined) finalCorrections.exposure = derived.exposure;
			if (derived.gamma !== undefined) finalCorrections.gamma = derived.gamma;
			if (derived.contrast !== undefined) finalCorrections.contrast = derived.contrast;
			if (derived.color_temperature !== undefined) finalCorrections.color_temperature = derived.color_temperature;
			if (derived.saturation !== undefined) finalCorrections.saturation = derived.saturation;
			if (derived.color_balance) finalCorrections.color_balance = derived.color_balance;

			// Merge any user-provided extra corrections
			if (params.extra_corrections) {
				let extra = params.extra_corrections as CorrectionParams;
				if (typeof extra === "string") {
					try { extra = JSON.parse(extra); } catch { /* ignore */ }
				}
				Object.assign(finalCorrections, extra);
			}

			reportLines.push("", "── Auto-Derived Corrections ──");
			for (const [key, val] of Object.entries(derived)) {
				reportLines.push(`  ${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
			}
			if (Object.keys(derived).length === 0) {
				reportLines.push("  (none needed — post-LUT stats look good!)");
			}

			// ── Step 6: Build final filter chain and render preview ──
			const finalChain = buildFilterChain(finalCorrections);
			reportLines.push("", "── Final Filter Chain ──");
			reportLines.push(finalChain);

			// Analyze the final corrected image
			let finalStats;
			try {
				finalStats = await extractSignalStats(videoPath, tc, finalChain);
			} catch {
				// Non-critical — we'll still show the preview
			}

			if (finalStats) {
				reportLines.push("", "── Final Corrected Stats ──");
				reportLines.push(`  YAVG=${finalStats.YAVG.toFixed(1)} YMIN=${finalStats.YMIN.toFixed(0)} YMAX=${finalStats.YMAX.toFixed(0)}`);
				reportLines.push(`  UAVG=${finalStats.UAVG.toFixed(1)} VAVG=${finalStats.VAVG.toFixed(1)} SATAVG=${finalStats.SATAVG.toFixed(1)}`);
				reportLines.push("", "── Final Diagnosis ──");
				reportLines.push(diagnoseExposure(finalStats));
			}

			reportLines.push("", "── Correction Parameters (for further refinement) ──");
			reportLines.push(JSON.stringify(finalCorrections, null, 2));

			reportLines.push("", "── Next Steps ──");
			reportLines.push("  1. Visually inspect the preview image above");
			reportLines.push("  2. Use render_scopes with this filter_chain to check vectorscope/waveform");
			reportLines.push("  3. Fine-tune by adding to the correction parameters above via apply_correction");
			reportLines.push("  4. Use compare_frames to see before/after");
			reportLines.push("  5. When satisfied, export_video with this filter_chain");

			// Render the preview frame
			const previewPath = resolve(outDir, "auto-correct-preview.png");
			const content: any[] = [];

			try {
				await runFfmpeg([
					"-ss", tc,
					"-i", videoPath,
					"-vf", finalChain,
					"-frames:v", "1",
					"-q:v", "2",
					previewPath,
				]);

				const img = await prepareImageForApi(previewPath);
				content.push({ type: "text" as const, text: reportLines.join("\n") });
				content.push({ type: "image" as const, data: img.data, mimeType: img.mimeType });
			} catch (err: any) {
				content.push({ type: "text" as const, text: reportLines.join("\n") + `\n\nPreview render failed: ${err.message}` });
			}

			return { content, details: undefined };
		},
	});
};

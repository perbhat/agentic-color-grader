import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import {
	runFfmpeg,
	extractSignalStats,
	computeZoneDistribution,
	diagnoseExposure,
	resolveTimecode,
} from "./lib/ffmpeg.ts";

const Parameters = Type.Object({
	video: Type.String({ description: "Path to the video file to analyze." }),
	timecode: Type.Optional(Type.String({ description: 'Timecode to extract the frame at. Default: "00:00:01". Accepts HH:MM:SS, MM:SS, or seconds.' })),
	filter_chain: Type.Optional(Type.String({ description: "Optional ffmpeg filter chain to apply before analysis (for evaluating corrections without re-encoding)." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "analyze_frame",
		label: "Analyze Frame",
		description:
			"Extract a frame from a video and compute numerical scope data (luminance, chrominance, saturation, zone distribution). " +
			"Returns an LLM-readable text summary with auto-diagnosis for exposure, black/white levels, color cast, and saturation. " +
			"Optionally applies a filter chain before analysis (for evaluating corrections). Returns the frame image for visual inspection.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const videoPath = resolve(params.video);
			if (!existsSync(videoPath)) {
				return { content: [{ type: "text", text: `Error: Video file not found: ${videoPath}` }], details: undefined };
			}

			const tc = resolveTimecode(params.timecode ?? "00:00:01");
			const outDir = resolve(dirname(videoPath), ".color-grader-tmp");
			const framePath = resolve(outDir, "analysis-frame.png");

			// Ensure output directory exists
			const { execFile } = await import("child_process");
			const { promisify } = await import("util");
			const exec = promisify(execFile);
			await exec("mkdir", ["-p", outDir]);

			// Extract signalstats using ffmpeg (not ffprobe — ffprobe doesn't support -vf/-frames:v)
			let stats;
			try {
				stats = await extractSignalStats(videoPath, tc, params.filter_chain || undefined);
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: signalstats extraction failed: ${err.message}` }], details: undefined };
			}

			// Also extract the visual frame (with corrections applied if any)
			const frameFilter = params.filter_chain || undefined;
			const frameArgs = [
				"-ss", tc,
				"-i", videoPath,
				...(frameFilter ? ["-vf", frameFilter] : []),
				"-frames:v", "1",
				"-q:v", "2",
				framePath,
			];

			try {
				await runFfmpeg(frameArgs);
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: Frame extraction failed: ${err.message}` }], details: undefined };
			}

			const zones = computeZoneDistribution(stats);
			const diagnosis = diagnoseExposure(stats);

			// Build text report
			const report = [
				"═══ FRAME ANALYSIS ═══",
				`Video: ${videoPath}`,
				`Timecode: ${tc}`,
				params.filter_chain ? `Filter chain: ${params.filter_chain}` : "Filter chain: (none — raw footage)",
				"",
				"── Luminance (Y) ──",
				`  YMIN:  ${stats.YMIN.toFixed(1)}   (black level)`,
				`  YLOW:  ${stats.YLOW.toFixed(1)}   (10th percentile)`,
				`  YAVG:  ${stats.YAVG.toFixed(1)}   (average)`,
				`  YHIGH: ${stats.YHIGH.toFixed(1)}   (90th percentile)`,
				`  YMAX:  ${stats.YMAX.toFixed(1)}   (peak white)`,
				"",
				"── Chrominance ──",
				`  UAVG: ${stats.UAVG.toFixed(1)}   (blue-yellow axis, neutral=128)`,
				`  VAVG: ${stats.VAVG.toFixed(1)}   (red-green axis, neutral=128)`,
				`  U range: ${stats.UMIN.toFixed(0)}–${stats.UMAX.toFixed(0)}`,
				`  V range: ${stats.VMIN.toFixed(0)}–${stats.VMAX.toFixed(0)}`,
				"",
				"── Saturation ──",
				`  SATMIN: ${stats.SATMIN.toFixed(1)}`,
				`  SATAVG: ${stats.SATAVG.toFixed(1)}`,
				`  SATMAX: ${stats.SATMAX.toFixed(1)}`,
				"",
				"── Hue ──",
				`  HUEMED: ${stats.HUEMED.toFixed(1)}°`,
				`  HUEAVG: ${stats.HUEAVG.toFixed(1)}°`,
				"",
				"── Zone Distribution (estimated) ──",
				`  Blacks:     ${zones.blacks.toFixed(1)}%`,
				`  Shadows:    ${zones.shadows.toFixed(1)}%`,
				`  Midtones:   ${zones.midtones.toFixed(1)}%`,
				`  Highlights: ${zones.highlights.toFixed(1)}%`,
				`  Whites:     ${zones.whites.toFixed(1)}%`,
				"",
				"── Diagnosis ──",
				diagnosis,
			].join("\n");

			// Read frame image and return as ImageContent
			const content: any[] = [{ type: "text" as const, text: report }];
			try {
				const imgData = await readFile(framePath);
				content.push({ type: "image" as const, data: imgData.toString("base64"), mimeType: "image/png" });
			} catch {
				content.push({ type: "text" as const, text: `\nFrame saved to: ${framePath} (could not read for inline display)` });
			}

			return { content, details: undefined };
		},
	});
};

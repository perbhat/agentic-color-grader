import { tool, ToolResult } from "pi-ext";
import {
	runFfprobe,
	runFfmpeg,
	parseSignalStats,
	computeZoneDistribution,
	diagnoseExposure,
	resolveTimecode,
	buildFilterChain,
	type SignalStats,
	type ZoneDistribution,
	type CorrectionParams,
} from "./lib/ffmpeg.ts";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

export default tool({
	name: "analyze_frame",
	description:
		"Extract a frame from a video and compute numerical scope data (luminance, chrominance, saturation, zone distribution). " +
		"Returns an LLM-readable text summary with auto-diagnosis for exposure, black/white levels, color cast, and saturation. " +
		"Optionally applies a filter chain before analysis (for evaluating corrections).",
	parameters: {
		video: {
			type: "string",
			description: "Path to the video file to analyze.",
		},
		timecode: {
			type: "string",
			description: 'Timecode to extract the frame at. Default: "00:00:01". Accepts HH:MM:SS, MM:SS, or seconds.',
			default: "00:00:01",
		},
		filter_chain: {
			type: "string",
			description: "Optional ffmpeg filter chain to apply before analysis (for evaluating corrections without re-encoding).",
			default: "",
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const videoPath = resolve(params.video);
		if (!existsSync(videoPath)) {
			return { error: `Video file not found: ${videoPath}` };
		}

		const tc = resolveTimecode(params.timecode ?? "00:00:01");
		const outDir = resolve(dirname(videoPath), ".color-grader-tmp");
		const framePath = resolve(outDir, "analysis-frame.png");

		// Ensure output directory exists
		await runFfmpeg(["-version"]).catch(() => {}); // noop warmup
		const { execFile } = await import("child_process");
		const { promisify } = await import("util");
		const exec = promisify(execFile);
		await exec("mkdir", ["-p", outDir]);

		// Build signalstats filter, prepending user corrections if provided
		let analysisFilter = "signalstats=stat=brng+tout+vrep+ring";
		if (params.filter_chain) {
			analysisFilter = `${params.filter_chain},${analysisFilter}`;
		}

		// Extract frame with signalstats metadata via ffprobe
		const probeArgs = [
			"-v", "quiet",
			"-select_streams", "v:0",
			"-ss", tc,
			"-i", videoPath,
			"-vf", analysisFilter,
			"-frames:v", "1",
			"-show_entries", "frame_tags",
			"-print_format", "flat",
		];

		let probeResult;
		try {
			probeResult = await runFfprobe(probeArgs);
		} catch (err: any) {
			return { error: `ffprobe signalstats failed: ${err.message}` };
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
			return { error: `Frame extraction failed: ${err.message}` };
		}

		// Parse signalstats
		const stats = parseSignalStats(probeResult.stdout + probeResult.stderr);
		const zones = computeZoneDistribution(stats);
		const diagnosis = diagnoseExposure(stats);

		// Build text report
		const report = [
			"═══ FRAME ANALYSIS ═══",
			`Video: ${videoPath}`,
			`Timecode: ${tc}`,
			params.filter_chain ? `Filter chain: ${params.filter_chain}` : "Filter chain: (none — raw footage)",
			"",
			`⚡ VISUAL CHECK: Read this image to visually inspect the frame: ${framePath}`,
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

		return { output: report };
	},
});

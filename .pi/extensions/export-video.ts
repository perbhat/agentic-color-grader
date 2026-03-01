import { tool, ToolResult } from "pi-ext";
import { resolveTimecode } from "./lib/ffmpeg.ts";
import { existsSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";

export default tool({
	name: "export_video",
	description:
		"Apply a correction filter chain to the full video and export the result. " +
		"Copies audio streams, encodes video with the specified codec and quality. " +
		"Reports progress during encoding.",
	parameters: {
		video: {
			type: "string",
			description: "Path to the source video file.",
		},
		output: {
			type: "string",
			description: "Path for the output video file.",
		},
		filter_chain: {
			type: "string",
			description: "The ffmpeg filter chain to apply (from apply_correction output).",
		},
		codec: {
			type: "string",
			description: 'Video codec. Default: "libx264". Options: libx264, libx265, libsvtav1.',
			default: "libx264",
		},
		quality: {
			type: "number",
			description: "CRF value (lower = higher quality). Default: 18. Range: 0-51.",
			default: 18,
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const videoPath = resolve(params.video);
		if (!existsSync(videoPath)) {
			return { error: `Video file not found: ${videoPath}` };
		}

		if (!params.filter_chain) {
			return { error: "filter_chain is required for export." };
		}

		if (!params.output) {
			return { error: "output path is required." };
		}

		const outputPath = resolve(params.output);
		const codec = params.codec ?? "libx264";
		const crf = params.quality ?? 18;

		const args = [
			"-y",
			"-i", videoPath,
			"-vf", params.filter_chain,
			"-c:v", codec,
			"-crf", String(crf),
			"-preset", "medium",
			"-c:a", "copy",
			"-movflags", "+faststart",
			outputPath,
		];

		// Run ffmpeg with progress streaming
		return new Promise<ToolResult>((resolvePromise) => {
			const proc = execFile("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) {
					resolvePromise({
						error: `Export failed: ${err.message}\n${stderr}`,
					});
					return;
				}

				// Extract duration info from stderr for final report
				const durationMatch = stderr.match(/Duration: (\d{2}:\d{2}:\d{2}\.\d{2})/);
				const duration = durationMatch ? durationMatch[1] : "unknown";
				const sizeMatch = stderr.match(/video:(\d+\w+)/);
				const size = sizeMatch ? sizeMatch[1] : "unknown";

				const report = [
					"═══ EXPORT COMPLETE ═══",
					`Source: ${videoPath}`,
					`Output: ${outputPath}`,
					`Duration: ${duration}`,
					`Codec: ${codec}`,
					`Quality: CRF ${crf}`,
					`Approx video size: ${size}`,
					"",
					"── Filter Chain Applied ──",
					params.filter_chain,
					"",
					"Export finished successfully.",
				].join("\n");

				resolvePromise({ output: report });
			});
		});
	},
});

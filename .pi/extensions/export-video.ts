import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { resolve } from "path";
import { execFile } from "child_process";

const Parameters = Type.Object({
	video: Type.String({ description: "Path to the source video file." }),
	output: Type.String({ description: "Path for the output video file." }),
	filter_chain: Type.String({ description: "The ffmpeg filter chain to apply (from apply_correction output)." }),
	codec: Type.Optional(Type.String({ description: 'Video codec. Default: "libx264". Options: libx264, libx265, libsvtav1.' })),
	quality: Type.Optional(Type.Number({ description: "CRF value (lower = higher quality). Default: 18. Range: 0-51." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "export_video",
		label: "Export Video",
		description:
			"Apply a correction filter chain to the full video and export the result. " +
			"Copies audio streams, encodes video with the specified codec and quality. " +
			"Reports progress during encoding.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const videoPath = resolve(params.video);
			if (!existsSync(videoPath)) {
				return { content: [{ type: "text", text: `Error: Video file not found: ${videoPath}` }], details: undefined };
			}

			if (!params.filter_chain) {
				return { content: [{ type: "text", text: "Error: filter_chain is required for export." }], details: undefined };
			}

			if (!params.output) {
				return { content: [{ type: "text", text: "Error: output path is required." }], details: undefined };
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

			return new Promise((resolvePromise) => {
				execFile("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
					if (err) {
						resolvePromise({
							content: [{ type: "text", text: `Error: Export failed: ${err.message}\n${stderr}` }],
							details: undefined,
						});
						return;
					}

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

					resolvePromise({ content: [{ type: "text", text: report }], details: undefined });
				});
			});
		},
	});
};

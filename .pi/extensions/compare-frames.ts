import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runFfmpeg, resolveTimecode } from "./lib/ffmpeg.ts";

const Parameters = Type.Object({
	video: Type.String({ description: "Path to the video file." }),
	timecode: Type.Optional(Type.String({ description: 'Timecode for the frame. Default: "00:00:01".' })),
	filter_chain: Type.String({ description: "The ffmpeg filter chain to compare against the original." }),
	mode: Type.Optional(Type.String({ description: 'Comparison mode: "side_by_side" (two full frames) or "split" (single frame with divider). Default: "side_by_side".' })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "compare_frames",
		label: "Compare Frames",
		description:
			"Generate a before/after comparison image for a video frame with and without a correction filter chain. " +
			'Supports side-by-side mode (two full frames) or split mode (single frame with a vertical dividing line). ' +
			"Returns the comparison image for visual inspection.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const videoPath = resolve(params.video);
			if (!existsSync(videoPath)) {
				return { content: [{ type: "text", text: `Error: Video file not found: ${videoPath}` }], details: undefined };
			}

			if (!params.filter_chain) {
				return { content: [{ type: "text", text: "Error: filter_chain is required for comparison." }], details: undefined };
			}

			const tc = resolveTimecode(params.timecode ?? "00:00:01");
			const mode = params.mode ?? "side_by_side";
			const outDir = resolve(dirname(videoPath), ".color-grader-tmp");
			const comparePath = resolve(outDir, `compare-${mode}.png`);

			const { execFile } = await import("child_process");
			const { promisify } = await import("util");
			const exec = promisify(execFile);
			await exec("mkdir", ["-p", outDir]);

			let filterComplex: string;

			if (mode === "split") {
				// Split mode: left half original, right half corrected, thin red divider
				filterComplex = [
					`[0:v]split[a][b]`,
					`[a]crop=iw/2:ih:0:0[left]`,
					`[b]${params.filter_chain},crop=iw/2:ih:iw/2:0[right]`,
					`[left][right]hstack=inputs=2,drawbox=x=iw/2-1:y=0:w=2:h=ih:color=red:t=fill`,
				].join(";");
			} else {
				// Side-by-side mode: full original + full corrected, thin red divider between
				filterComplex = [
					`[0:v]split[a][b]`,
					`[b]${params.filter_chain}[right]`,
					`[a][right]hstack=inputs=2,drawbox=x=iw/2-1:y=0:w=2:h=ih:color=red:t=fill`,
				].join(";");
			}

			const args = [
				"-ss", tc,
				"-i", videoPath,
				"-filter_complex", filterComplex,
				"-frames:v", "1",
				"-q:v", "2",
				comparePath,
			];

			try {
				await runFfmpeg(args);
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: Comparison render failed: ${err.message}` }], details: undefined };
			}

			const report = [
				"═══ FRAME COMPARISON ═══",
				`Video: ${videoPath}`,
				`Timecode: ${tc}`,
				`Mode: ${mode}`,
				`Filter chain: ${params.filter_chain}`,
			].join("\n");

			const content: any[] = [{ type: "text" as const, text: report }];
			try {
				const imgData = await readFile(comparePath);
				content.push({ type: "image" as const, data: imgData.toString("base64"), mimeType: "image/png" });
			} catch {
				content.push({ type: "text" as const, text: `\nComparison saved to: ${comparePath}` });
			}

			return { content, details: undefined };
		},
	});
};

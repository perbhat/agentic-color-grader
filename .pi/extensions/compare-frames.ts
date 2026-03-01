import { tool, ToolResult } from "pi-ext";
import { runFfmpeg, resolveTimecode } from "./lib/ffmpeg.ts";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

export default tool({
	name: "compare_frames",
	description:
		"Generate a before/after comparison image for a video frame with and without a correction filter chain. " +
		'Supports side-by-side mode (two full frames) or split mode (single frame with a vertical dividing line). ' +
		"Returns the comparison image path.",
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
		filter_chain: {
			type: "string",
			description: "The ffmpeg filter chain to compare against the original.",
		},
		mode: {
			type: "string",
			description: 'Comparison mode: "side_by_side" (two full frames) or "split" (single frame with divider). Default: "side_by_side".',
			default: "side_by_side",
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const videoPath = resolve(params.video);
		if (!existsSync(videoPath)) {
			return { error: `Video file not found: ${videoPath}` };
		}

		if (!params.filter_chain) {
			return { error: "filter_chain is required for comparison." };
		}

		const tc = resolveTimecode(params.timecode ?? "00:00:01");
		const mode = params.mode ?? "side_by_side";
		const outDir = resolve(dirname(videoPath), ".color-grader-tmp");
		const comparePath = resolve(outDir, `compare-${mode}.png`);

		const { execFile } = await import("child_process");
		const { promisify } = await import("util");
		const exec = promisify(execFile);
		await exec("mkdir", ["-p", [outDir]]);

		let filterComplex: string;

		if (mode === "split") {
			// Split mode: overlay corrected on right half with a vertical line
			filterComplex = [
				"[0:v]split[original][tocorrect]",
				`[tocorrect]${params.filter_chain}[corrected]`,
				"[original][corrected]overlay=W/2:0:shortest=1",
				// Draw a thin white dividing line at the center
				"drawbox=x=iw/2-1:y=0:w=2:h=ih:color=white:t=fill",
				// Add labels
				"drawtext=text='BEFORE':x=10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black",
				"drawtext=text='AFTER':x=iw/2+10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black",
			].join(",");

			// For split mode, we need the corrected version to only show the right half
			// Simpler approach: use crop and hstack
			filterComplex = [
				`[0:v]split[a][b]`,
				`[a]crop=iw/2:ih:0:0,drawtext=text='BEFORE':x=10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black[left]`,
				`[b]${params.filter_chain},crop=iw/2:ih:iw/2:0,drawtext=text='AFTER':x=10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black[right]`,
				`[left][right]hstack=inputs=2`,
			].join(";");
		} else {
			// Side by side: full frames stacked horizontally
			filterComplex = [
				`[0:v]split[a][b]`,
				`[a]drawtext=text='BEFORE':x=10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black[left]`,
				`[b]${params.filter_chain},drawtext=text='AFTER':x=10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black[right]`,
				`[left][right]hstack=inputs=2`,
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
			return { error: `Comparison render failed: ${err.message}` };
		}

		const report = [
			"═══ FRAME COMPARISON ═══",
			`Video: ${videoPath}`,
			`Timecode: ${tc}`,
			`Mode: ${mode}`,
			`Filter chain: ${params.filter_chain}`,
			"",
			"",
			`⚡ VISUAL CHECK: Read this image to visually compare before/after: ${comparePath}`,
		].join("\n");

		return { output: report };
	},
});

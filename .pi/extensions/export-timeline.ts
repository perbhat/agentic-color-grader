import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { resolve, dirname, basename } from "path";
import { execFile } from "child_process";
import {
	loadTimeline,
	buildCombinedFilterChain,
	type TimelineClip,
} from "./lib/timeline.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

async function encodeClip(
	clip: TimelineClip,
	filterChain: string,
	outputPath: string,
	codec: string,
	crf: number,
): Promise<void> {
	const args = [
		"-y",
		...(clip.in_point && clip.in_point !== "00:00:00" ? ["-ss", clip.in_point] : []),
		"-i", clip.video,
		...(clip.out_point && clip.out_point !== "end" ? ["-to", clip.out_point] : []),
		...(filterChain ? ["-vf", filterChain] : []),
		"-c:v", codec,
		"-crf", String(crf),
		"-preset", "medium",
		"-c:a", "aac",
		"-b:a", "192k",
		"-movflags", "+faststart",
		outputPath,
	];

	return new Promise((res, rej) => {
		execFile("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) rej(new Error(`Encode failed for ${clip.id}: ${err.message}\n${stderr}`));
			else res();
		});
	});
}

async function concatenateFiles(
	filePaths: string[],
	outputPath: string,
): Promise<void> {
	const concatDir = dirname(outputPath);
	const concatFile = resolve(concatDir, ".concat-list.txt");
	const concatContent = filePaths.map((f) => `file '${f}'`).join("\n");
	await writeFile(concatFile, concatContent, "utf-8");

	const args = [
		"-y",
		"-f", "concat",
		"-safe", "0",
		"-i", concatFile,
		"-c", "copy",
		"-movflags", "+faststart",
		outputPath,
	];

	return new Promise((res, rej) => {
		execFile("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) rej(new Error(`Concatenation failed: ${err.message}\n${stderr}`));
			else res();
		});
	});
}

// ─── Tool ─────────────────────────────────────────────────────────────────

const Parameters = Type.Object({
	timeline_dir: Type.String({ description: "Working directory for the timeline." }),
	output: Type.String({ description: "Output video file path." }),
	codec: Type.Optional(Type.String({ description: 'Video codec. Default: "libx264". Options: libx264, libx265, libsvtav1.' })),
	quality: Type.Optional(Type.Number({ description: "CRF value (lower = higher quality). Default: 18." })),
	clip_ids: Type.Optional(Type.Array(Type.String(), { description: "Optional: export only specific clip IDs. Default: all clips in timeline order." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "export_timeline",
		label: "Export Timeline",
		description:
			"Export all clips in a timeline as a single concatenated video. " +
			"Each clip is encoded with its combined corrections (group base + per-clip), then concatenated in timeline order. " +
			"Audio is re-encoded to ensure consistent format across clips.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const dir = resolve(params.timeline_dir);
			const timeline = await loadTimeline(dir);

			if (timeline.clips.length === 0) {
				return { content: [{ type: "text", text: "Error: Timeline has no clips." }], details: undefined };
			}

			if (!params.output) {
				return { content: [{ type: "text", text: "Error: output path is required." }], details: undefined };
			}

			const outputPath = resolve(params.output);
			const codec = params.codec ?? "libx264";
			const crf = params.quality ?? 18;
			const requestedIds: string[] = params.clip_ids ?? [];

			let clipsToExport = timeline.clips;
			if (requestedIds.length > 0) {
				clipsToExport = [];
				for (const id of requestedIds) {
					const clip = timeline.clips.find((c) => c.id === id);
					if (!clip) return { content: [{ type: "text", text: `Error: Clip not found: ${id}` }], details: undefined };
					clipsToExport.push(clip);
				}
			}

			const groupBase: Record<string, any> = {};
			for (const [name, settings] of Object.entries(timeline.groups)) {
				groupBase[name] = settings.base_corrections;
			}

			const ungraded = clipsToExport.filter(
				(c) => !buildCombinedFilterChain(c, groupBase),
			);
			if (ungraded.length > 0) {
				return { content: [{ type: "text", text: `Error: ${ungraded.length} clip(s) have no corrections: ${ungraded.map((c) => c.id).join(", ")}. Grade all clips before exporting.` }], details: undefined };
			}

			const tmpDir = resolve(dir, ".color-grader-tmp", "export-tmp");
			if (!existsSync(tmpDir)) {
				await mkdir(tmpDir, { recursive: true });
			}

			const filterChains = clipsToExport.map((c) => buildCombinedFilterChain(c, groupBase));

			const report: string[] = [
				"═══ TIMELINE EXPORT ═══",
				`Clips: ${clipsToExport.length}`,
				`Codec: ${codec}`,
				`Quality: CRF ${crf}`,
				`Output: ${outputPath}`,
				"",
			];

			if (clipsToExport.length === 1) {
				const clip = clipsToExport[0];
				const filter = buildCombinedFilterChain(clip, groupBase);
				report.push(`Encoding ${clip.id}...`);
				try {
					await encodeClip(clip, filter, outputPath, codec, crf);
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error: ${err.message}` }], details: undefined };
				}
				report.push("Export complete.");
			} else {
				const tempFiles: string[] = [];

				for (let i = 0; i < clipsToExport.length; i++) {
					const clip = clipsToExport[i];
					const filter = buildCombinedFilterChain(clip, groupBase);
					const tempFile = resolve(tmpDir, `${clip.id}_encoded.mp4`);
					tempFiles.push(tempFile);

					report.push(`Encoding ${clip.id} (${i + 1}/${clipsToExport.length})...`);
					try {
						await encodeClip(clip, filter, tempFile, codec, crf);
					} catch (err: any) {
						return { content: [{ type: "text", text: `Error: Failed encoding ${clip.id}: ${err.message}` }], details: undefined };
					}
				}

				report.push("");
				report.push("Concatenating clips...");
				try {
					await concatenateFiles(tempFiles, outputPath);
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error: ${err.message}` }], details: undefined };
				}

				report.push("Concatenation complete.");
			}

			report.push("");
			report.push("── Clip Details ──");
			for (let i = 0; i < clipsToExport.length; i++) {
				const clip = clipsToExport[i];
				const filter = filterChains[i];
				report.push(`  ${clip.id}: ${basename(clip.video)}`);
				report.push(`    Filter: ${filter}`);
			}

			report.push("");
			report.push(`Output: ${outputPath}`);
			report.push("Export finished successfully.");

			return { content: [{ type: "text", text: report.join("\n") }], details: undefined };
		},
	});
};

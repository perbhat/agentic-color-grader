import { tool, ToolResult } from "pi-ext";
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
		"-i", clip.video,
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
	// Build concat demuxer file
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

export default tool({
	name: "export_timeline",
	description:
		"Export all clips in a timeline as a single concatenated video. " +
		"Each clip is encoded with its combined corrections (group base + per-clip), then concatenated in timeline order. " +
		"Audio is re-encoded to ensure consistent format across clips.",
	parameters: {
		timeline_dir: {
			type: "string",
			description: "Working directory for the timeline.",
		},
		output: {
			type: "string",
			description: "Output video file path.",
		},
		codec: {
			type: "string",
			description: 'Video codec. Default: "libx264". Options: libx264, libx265, libsvtav1.',
			default: "libx264",
		},
		quality: {
			type: "number",
			description: "CRF value (lower = higher quality). Default: 18.",
			default: 18,
		},
		clip_ids: {
			type: "array",
			description: "Optional: export only specific clip IDs. Default: all clips in timeline order.",
			default: [],
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const dir = resolve(params.timeline_dir);
		const timeline = await loadTimeline(dir);

		if (timeline.clips.length === 0) {
			return { error: "Timeline has no clips." };
		}

		if (!params.output) {
			return { error: "output path is required." };
		}

		const outputPath = resolve(params.output);
		const codec = params.codec ?? "libx264";
		const crf = params.quality ?? 18;
		const requestedIds: string[] = params.clip_ids ?? [];

		// Select clips to export
		let clipsToExport = timeline.clips;
		if (requestedIds.length > 0) {
			clipsToExport = [];
			for (const id of requestedIds) {
				const clip = timeline.clips.find((c) => c.id === id);
				if (!clip) return { error: `Clip not found: ${id}` };
				clipsToExport.push(clip);
			}
		}

		// Build group base corrections map
		const groupBase: Record<string, any> = {};
		for (const [name, settings] of Object.entries(timeline.groups)) {
			groupBase[name] = settings.base_corrections;
		}

		// Validate all clips have corrections
		const ungraded = clipsToExport.filter(
			(c) => !buildCombinedFilterChain(c, groupBase),
		);
		if (ungraded.length > 0) {
			return {
				error: `${ungraded.length} clip(s) have no corrections: ${ungraded.map((c) => c.id).join(", ")}. Grade all clips before exporting.`,
			};
		}

		const tmpDir = resolve(dir, ".color-grader-tmp", "export-tmp");
		if (!existsSync(tmpDir)) {
			await mkdir(tmpDir, { recursive: true });
		}

		// Check if all clips can use the same filter chain (concat-demux shortcut)
		const filterChains = clipsToExport.map((c) => buildCombinedFilterChain(c, groupBase));
		const allSameFilter = filterChains.every((f) => f === filterChains[0]);

		const report: string[] = [
			"═══ TIMELINE EXPORT ═══",
			`Clips: ${clipsToExport.length}`,
			`Codec: ${codec}`,
			`Quality: CRF ${crf}`,
			`Output: ${outputPath}`,
			"",
		];

		if (clipsToExport.length === 1) {
			// Single clip — direct encode
			const clip = clipsToExport[0];
			const filter = buildCombinedFilterChain(clip, groupBase);
			report.push(`Encoding ${clip.id}...`);
			try {
				await encodeClip(clip, filter, outputPath, codec, crf);
			} catch (err: any) {
				return { error: err.message };
			}
			report.push("Export complete.");
		} else {
			// Multiple clips — encode each then concatenate
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
					return { error: `Failed encoding ${clip.id}: ${err.message}` };
				}
			}

			// Concatenate all encoded clips
			report.push("");
			report.push("Concatenating clips...");
			try {
				await concatenateFiles(tempFiles, outputPath);
			} catch (err: any) {
				return { error: err.message };
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

		return { output: report.join("\n") };
	},
});

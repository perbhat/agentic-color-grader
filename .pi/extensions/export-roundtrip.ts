import { tool, ToolResult } from "pi-ext";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { resolve, basename, extname } from "path";
import { execFile } from "child_process";
import { runFfprobe } from "./lib/ffmpeg.ts";
import { generateFcpxml } from "./lib/fcpxml.ts";
import {
	loadTimeline,
	buildCombinedFilterChain,
	type TimelineClip,
} from "./lib/timeline.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

async function encodeClipRoundtrip(
	clip: TimelineClip,
	filterChain: string,
	outputPath: string,
	codec: string,
	quality: number,
): Promise<void> {
	let codecArgs: string[];

	if (codec === "prores_ks") {
		codecArgs = [
			"-c:v", "prores_ks",
			"-profile:v", String(quality),
			"-vendor", "apl0",
			"-pix_fmt", "yuv422p10le",
		];
	} else {
		// H.264, H.265, etc. — use CRF
		codecArgs = [
			"-c:v", codec,
			"-crf", String(quality),
			"-preset", "medium",
		];
	}

	const args = [
		"-y",
		"-i", clip.video,
		...(filterChain ? ["-vf", filterChain] : []),
		...codecArgs,
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

async function probeDuration(filePath: string): Promise<number> {
	try {
		const { stdout } = await runFfprobe([
			"-v", "quiet",
			"-show_entries", "format=duration",
			"-print_format", "flat",
			"-i", filePath,
		]);
		const match = stdout.match(/duration="?([\d.]+)"?/);
		return match ? parseFloat(match[1]) : 0;
	} catch {
		return 0;
	}
}

// ─── Tool ─────────────────────────────────────────────────────────────────

export default tool({
	name: "export_roundtrip",
	description:
		"Export graded clips individually for NLE roundtrip. Each clip is exported separately " +
		"with its corrections applied, preserving original filenames with a suffix. " +
		"Optionally generates an FCPXML file referencing the graded clips for direct import into Final Cut Pro.",
	parameters: {
		timeline_dir: {
			type: "string",
			description: "Working directory for the timeline.",
		},
		output_dir: {
			type: "string",
			description: "Directory for exported graded clips.",
		},
		generate_fcpxml: {
			type: "boolean",
			description: "Generate an FCPXML file referencing the graded clips. Default: true.",
			default: true,
		},
		suffix: {
			type: "string",
			description: 'Suffix appended to filenames. Default: "_graded".',
			default: "_graded",
		},
		codec: {
			type: "string",
			description: 'Video codec. Default: "prores_ks" (ProRes). Options: prores_ks, libx264, libx265.',
			default: "prores_ks",
		},
		quality: {
			type: "number",
			description: "Quality. ProRes: profile 0-5 (3=HQ). H.264/H.265: CRF 0-51 (18=good). Default: 3.",
			default: 3,
		},
		clip_ids: {
			type: "array",
			description: "Optional: export only specific clip IDs. Default: all graded clips.",
			default: [],
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const dir = resolve(params.timeline_dir);
		const timeline = await loadTimeline(dir);

		if (timeline.clips.length === 0) {
			return { error: "Timeline has no clips." };
		}

		if (!params.output_dir) {
			return { error: "output_dir is required." };
		}

		const outputDir = resolve(params.output_dir);
		const suffix = params.suffix ?? "_graded";
		const codec = params.codec ?? "prores_ks";
		const quality = params.quality ?? 3;
		const genFcpxml = params.generate_fcpxml ?? true;
		const requestedIds: string[] = params.clip_ids ?? [];
		const fileExt = codec === "prores_ks" ? ".mov" : ".mp4";

		// Select clips
		let clipsToExport = timeline.clips.filter((c) => c.filter_chain);
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

		// Validate
		const ungraded = clipsToExport.filter((c) => !buildCombinedFilterChain(c, groupBase));
		if (ungraded.length > 0) {
			return {
				error: `${ungraded.length} clip(s) have no corrections: ${ungraded.map((c) => c.id).join(", ")}. Grade all clips before exporting.`,
			};
		}

		// Ensure output directory exists
		if (!existsSync(outputDir)) {
			await mkdir(outputDir, { recursive: true });
		}

		const report: string[] = [
			"═══ ROUNDTRIP EXPORT ═══",
			`Clips: ${clipsToExport.length}`,
			`Codec: ${codec}${codec === "prores_ks" ? ` (profile ${quality})` : ` (CRF ${quality})`}`,
			`Output: ${outputDir}`,
			"",
		];

		const exportedClips: Array<{ filePath: string; durationSeconds: number; name: string }> = [];

		for (let i = 0; i < clipsToExport.length; i++) {
			const clip = clipsToExport[i];
			const filterChain = buildCombinedFilterChain(clip, groupBase);

			// Build output filename
			const origName = basename(clip.video, extname(clip.video));
			const outputFile = resolve(outputDir, `${origName}${suffix}${fileExt}`);

			report.push(`Encoding ${clip.id} (${i + 1}/${clipsToExport.length}): ${origName}${suffix}${fileExt}`);

			try {
				await encodeClipRoundtrip(clip, filterChain, outputFile, codec, quality);
			} catch (err: any) {
				return { error: err.message };
			}

			// Probe duration for FCPXML
			const dur = await probeDuration(outputFile);
			exportedClips.push({
				filePath: outputFile,
				durationSeconds: dur,
				name: clip.name || origName,
			});

			report.push(`  → ${outputFile}`);
		}

		// Generate FCPXML
		let fcpxmlPath = "";
		if (genFcpxml && exportedClips.length > 0) {
			const fcpxmlContent = generateFcpxml({
				projectName: `${timeline.name || "Graded"} Roundtrip`,
				clips: exportedClips,
			});
			fcpxmlPath = resolve(outputDir, "roundtrip.fcpxml");
			await writeFile(fcpxmlPath, fcpxmlContent, "utf-8");
			report.push("");
			report.push(`FCPXML: ${fcpxmlPath}`);
			report.push("Import this file into Final Cut Pro to relink to graded clips.");
		}

		report.push("");
		report.push("── Exported Files ──");
		for (const exp of exportedClips) {
			report.push(`  ${basename(exp.filePath)} (${exp.durationSeconds.toFixed(1)}s)`);
		}

		report.push("");
		report.push("Roundtrip export complete.");

		return { output: report.join("\n") };
	},
});

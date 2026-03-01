import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
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

const Parameters = Type.Object({
	timeline_dir: Type.String({ description: "Working directory for the timeline." }),
	output_dir: Type.String({ description: "Directory for exported graded clips." }),
	generate_fcpxml: Type.Optional(Type.Boolean({ description: "Generate an FCPXML file referencing the graded clips. Default: true." })),
	suffix: Type.Optional(Type.String({ description: 'Suffix appended to filenames. Default: "_graded".' })),
	codec: Type.Optional(Type.String({ description: 'Video codec. Default: "prores_ks" (ProRes). Options: prores_ks, libx264, libx265.' })),
	quality: Type.Optional(Type.Number({ description: "Quality. ProRes: profile 0-5 (3=HQ). H.264/H.265: CRF 0-51 (18=good). Default: 3." })),
	clip_ids: Type.Optional(Type.Array(Type.String(), { description: "Optional: export only specific clip IDs. Default: all graded clips." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "export_roundtrip",
		label: "Export Roundtrip",
		description:
			"Export graded clips individually for NLE roundtrip. Each clip is exported separately " +
			"with its corrections applied, preserving original filenames with a suffix. " +
			"Optionally generates an FCPXML file referencing the graded clips for direct import into Final Cut Pro.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const dir = resolve(params.timeline_dir);
			const timeline = await loadTimeline(dir);

			if (timeline.clips.length === 0) {
				return { content: [{ type: "text", text: "Error: Timeline has no clips." }], details: undefined };
			}

			if (!params.output_dir) {
				return { content: [{ type: "text", text: "Error: output_dir is required." }], details: undefined };
			}

			const outputDir = resolve(params.output_dir);
			const suffix = params.suffix ?? "_graded";
			const codec = params.codec ?? "prores_ks";
			const quality = params.quality ?? 3;
			const genFcpxml = params.generate_fcpxml ?? true;
			const requestedIds: string[] = params.clip_ids ?? [];
			const fileExt = codec === "prores_ks" ? ".mov" : ".mp4";

			let clipsToExport = timeline.clips.filter((c) => c.filter_chain);
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

			const ungraded = clipsToExport.filter((c) => !buildCombinedFilterChain(c, groupBase));
			if (ungraded.length > 0) {
				return { content: [{ type: "text", text: `Error: ${ungraded.length} clip(s) have no corrections: ${ungraded.map((c) => c.id).join(", ")}. Grade all clips before exporting.` }], details: undefined };
			}

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

				const origName = basename(clip.video, extname(clip.video));
				const outputFile = resolve(outputDir, `${origName}${suffix}${fileExt}`);

				report.push(`Encoding ${clip.id} (${i + 1}/${clipsToExport.length}): ${origName}${suffix}${fileExt}`);

				try {
					await encodeClipRoundtrip(clip, filterChain, outputFile, codec, quality);
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error: ${err.message}` }], details: undefined };
				}

				const dur = await probeDuration(outputFile);
				exportedClips.push({
					filePath: outputFile,
					durationSeconds: dur,
					name: clip.name || origName,
				});

				report.push(`  → ${outputFile}`);
			}

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

			return { content: [{ type: "text", text: report.join("\n") }], details: undefined };
		},
	});
};

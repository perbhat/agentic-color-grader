import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve, basename } from "path";
import {
	parseFcpxml,
	secondsToTimecode,
} from "./lib/fcpxml.ts";
import {
	loadTimeline,
	saveTimeline,
	addClip,
	formatTimelineSummary,
} from "./lib/timeline.ts";
import { probeStartTime } from "./lib/ffmpeg.ts";

const Parameters = Type.Object({
	fcpxml_path: Type.String({ description: "Path to the .fcpxml file to import." }),
	timeline_dir: Type.String({ description: "Working directory for the timeline." }),
	name: Type.Optional(Type.String({ description: "Timeline name. Default: extracted from FCPXML project name." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "import_timeline",
		label: "Import Timeline",
		description:
			"Import a Final Cut Pro XML (FCPXML) file to populate the timeline. " +
			"Extracts clip references, in/out points, and ordering from the FCPXML. " +
			"Resolves source file paths and auto-detects source format for each clip.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.fcpxml_path) {
				return { content: [{ type: "text", text: "Error: fcpxml_path is required." }], details: undefined };
			}

			const fcpxmlPath = resolve(params.fcpxml_path);
			if (!existsSync(fcpxmlPath)) {
				return { content: [{ type: "text", text: `Error: FCPXML file not found: ${fcpxmlPath}` }], details: undefined };
			}

			const dir = resolve(params.timeline_dir);

			let xmlContent: string;
			try {
				xmlContent = await readFile(fcpxmlPath, "utf-8");
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error: Failed to read FCPXML: ${err.message}` }], details: undefined };
			}

			const parsed = parseFcpxml(xmlContent);

			const timeline = await loadTimeline(dir);
			timeline.name = params.name || parsed.projectName || "Imported Timeline";

			const report: string[] = [
				"═══ FCPXML IMPORT ═══",
				`File: ${fcpxmlPath}`,
				`FCPXML version: ${parsed.version}`,
				`Project: ${parsed.projectName}`,
				`Assets found: ${parsed.assets.size}`,
				`Clips in spine: ${parsed.clips.length}`,
				"",
			];

			const missingFiles: string[] = [];
			let addedCount = 0;
			let skippedCount = 0;

			// Cache probed start times per source file to avoid redundant ffprobe calls
			const startTimeCache = new Map<string, number>();

			for (const clipRef of parsed.clips) {
				const asset = parsed.assets.get(clipRef.assetId);
				if (!asset) {
					report.push(`  SKIP: No asset found for ref "${clipRef.assetId}"`);
					skippedCount++;
					continue;
				}

				if (!existsSync(asset.src)) {
					missingFiles.push(asset.src);
					report.push(`  WARN: Source file missing: ${asset.src}`);
				}

				// Probe embedded start time to convert FCPXML timecodes to file-relative positions.
				// Camera files (e.g. Sony) embed a continuous timecode (e.g. 25:33) which FCPXML
				// references as the `start` attribute. FFmpeg's -ss seeks from file start (0),
				// so we subtract the embedded start_time to get the correct file-relative position.
				let embedStart = 0;
				if (existsSync(asset.src)) {
					if (startTimeCache.has(asset.src)) {
						embedStart = startTimeCache.get(asset.src)!;
					} else {
						embedStart = await probeStartTime(asset.src);
						startTimeCache.set(asset.src, embedStart);
					}
				}

				const fileRelativeIn = Math.max(0, clipRef.start - embedStart);
				const fileRelativeOut = Math.max(0, clipRef.start + clipRef.duration - embedStart);
				const inPoint = secondsToTimecode(fileRelativeIn);
				const outPoint = secondsToTimecode(fileRelativeOut);
				const clipName = clipRef.name || basename(asset.src);

				const clip = await addClip(timeline, asset.src, {
					in_point: inPoint,
					out_point: outPoint,
					name: clipName,
				});

				if (embedStart > 0) {
					report.push(`  ${clip.id}: ${clipName} (${inPoint} → ${outPoint}) [embedded TC offset: ${secondsToTimecode(embedStart)}]`);
				} else {
					report.push(`  ${clip.id}: ${clipName} (${inPoint} → ${outPoint})`);
				}
				addedCount++;
			}

			await saveTimeline(dir, timeline);

			report.push("");
			report.push(`── Summary ──`);
			report.push(`Added: ${addedCount} clips`);
			report.push(`Skipped: ${skippedCount}`);
			if (missingFiles.length > 0) {
				report.push(`Missing source files: ${missingFiles.length}`);
			}

			if (parsed.warnings.length > 0) {
				report.push("");
				report.push("── Warnings ──");
				for (const w of parsed.warnings) {
					report.push(`  ${w}`);
				}
			}

			report.push("");
			report.push("── Timeline ──");
			report.push(formatTimelineSummary(timeline));
			report.push("");
			report.push("Next: Run detect_scenes to auto-group clips, or use manage_timeline to group manually.");

			return { content: [{ type: "text", text: report.join("\n") }], details: undefined };
		},
	});
};

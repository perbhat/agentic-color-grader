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

				const inPoint = secondsToTimecode(clipRef.start);
				const outPoint = secondsToTimecode(clipRef.start + clipRef.duration);
				const clipName = clipRef.name || basename(asset.src);

				const clip = await addClip(timeline, asset.src, {
					in_point: inPoint,
					out_point: outPoint,
					name: clipName,
				});

				report.push(`  ${clip.id}: ${clipName} (${inPoint} → ${outPoint})`);
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

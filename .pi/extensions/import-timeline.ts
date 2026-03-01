import { tool, ToolResult } from "pi-ext";
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

export default tool({
	name: "import_timeline",
	description:
		"Import a Final Cut Pro XML (FCPXML) file to populate the timeline. " +
		"Extracts clip references, in/out points, and ordering from the FCPXML. " +
		"Resolves source file paths and auto-detects source format for each clip.",
	parameters: {
		fcpxml_path: {
			type: "string",
			description: "Path to the .fcpxml file to import.",
		},
		timeline_dir: {
			type: "string",
			description: "Working directory for the timeline.",
		},
		name: {
			type: "string",
			description: "Timeline name. Default: extracted from FCPXML project name.",
			default: "",
		},
	},
	execute: async (params): Promise<ToolResult> => {
		if (!params.fcpxml_path) {
			return { error: "fcpxml_path is required." };
		}

		const fcpxmlPath = resolve(params.fcpxml_path);
		if (!existsSync(fcpxmlPath)) {
			return { error: `FCPXML file not found: ${fcpxmlPath}` };
		}

		const dir = resolve(params.timeline_dir);

		// Read and parse FCPXML
		let xmlContent: string;
		try {
			xmlContent = await readFile(fcpxmlPath, "utf-8");
		} catch (err: any) {
			return { error: `Failed to read FCPXML: ${err.message}` };
		}

		const parsed = parseFcpxml(xmlContent);

		// Load or create timeline
		const timeline = await loadTimeline(dir);
		timeline.name = params.name || parsed.projectName || "Imported Timeline";

		// Process clips
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

			// Check if source file exists
			if (!existsSync(asset.src)) {
				missingFiles.push(asset.src);
				report.push(`  WARN: Source file missing: ${asset.src}`);
				// Still add it to timeline so user can relink later
			}

			// Convert rational times to timecodes
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

		return { output: report.join("\n") };
	},
});

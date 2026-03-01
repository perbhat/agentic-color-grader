import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { resolve } from "path";
import {
	runFfprobe,
	extractSignalStats,
	type SignalStats,
} from "./lib/ffmpeg.ts";
import {
	loadTimeline,
	saveTimeline,
	addClip,
	setGroup,
	setReference,
	formatTimelineSummary,
	type Timeline,
	type TimelineClip,
} from "./lib/timeline.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

async function getClipDuration(video: string): Promise<number> {
	try {
		const { stdout } = await runFfprobe([
			"-v", "quiet",
			"-show_entries", "format=duration",
			"-print_format", "flat",
			"-i", video,
		]);
		const match = stdout.match(/duration="?([\d.]+)"?/);
		return match ? parseFloat(match[1]) : 10;
	} catch {
		return 10;
	}
}

async function analyzeClipAtTimecode(video: string, timecode: string): Promise<SignalStats> {
	return extractSignalStats(video, timecode);
}

function statDistance(a: SignalStats, b: SignalStats): number {
	const yDist = Math.abs(a.YAVG - b.YAVG) / 255;
	const uDist = Math.abs(a.UAVG - b.UAVG) / 255;
	const vDist = Math.abs(a.VAVG - b.VAVG) / 255;
	const satDist = Math.abs(a.SATAVG - b.SATAVG) / 255;
	return (yDist + uDist + vDist + satDist) / 4;
}

async function getMetadataGroup(video: string): Promise<string> {
	try {
		const { stdout } = await runFfprobe([
			"-v", "quiet",
			"-show_entries", "format_tags=com.apple.quicktime.model,creation_time",
			"-show_entries", "stream_tags=handler_name",
			"-print_format", "flat",
			"-i", video,
		]);
		const model = stdout.match(/model="?([^"\n]+)"?/)?.[1] ?? "unknown";
		const time = stdout.match(/creation_time="?(\d{4}-\d{2}-\d{2}T\d{2})/)?.[1] ?? "";
		return `${model}_${time}`.replace(/[^a-zA-Z0-9_-]/g, "_");
	} catch {
		return "unknown";
	}
}

function groupClusters(
	clips: { clip: TimelineClip; stats: SignalStats }[],
	threshold: number,
): Map<string, TimelineClip[]> {
	const groups = new Map<string, { clips: TimelineClip[]; centroid: SignalStats }>();
	let groupCounter = 1;

	for (const { clip, stats } of clips) {
		let assigned = false;
		for (const [name, group] of groups) {
			if (statDistance(stats, group.centroid) <= (1 - threshold)) {
				group.clips.push(clip);
				assigned = true;
				break;
			}
		}
		if (!assigned) {
			const name = `scene-${groupCounter++}`;
			groups.set(name, { clips: [clip], centroid: stats });
		}
	}

	const result = new Map<string, TimelineClip[]>();
	for (const [name, group] of groups) {
		result.set(name, group.clips);
	}
	return result;
}

// ─── Tool ─────────────────────────────────────────────────────────────────

const Parameters = Type.Object({
	videos: Type.Array(Type.String(), { description: "Array of video file paths to analyze and group." }),
	timeline_dir: Type.String({ description: "Working directory for the timeline (where .color-grader-tmp lives)." }),
	method: Type.Optional(Type.String({ description: 'Grouping method: "visual" (compare color stats), "metadata" (camera/date), or "manual" (skip auto-grouping). Default: "visual".' })),
	threshold: Type.Optional(Type.Number({ description: "Similarity threshold 0-1 for visual grouping. Higher = stricter grouping. Default: 0.7." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "detect_scenes",
		label: "Detect Scenes",
		description:
			"Analyze multiple video clips and group them by visual similarity or metadata. " +
			"Adds clips to the timeline, extracts representative frames, compares stats, and assigns scene groups. " +
			"Picks a reference (hero) clip for each group.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const videos: string[] = params.videos;
			if (!videos || videos.length === 0) {
				return { content: [{ type: "text", text: "Error: No videos provided." }], details: undefined };
			}

			const dir = resolve(params.timeline_dir);
			const method = params.method ?? "visual";
			const threshold = params.threshold ?? 0.7;

			for (const v of videos) {
				if (!existsSync(resolve(v))) {
					return { content: [{ type: "text", text: `Error: Video file not found: ${v}` }], details: undefined };
				}
			}

			const timeline = await loadTimeline(dir);

			const addedClips: TimelineClip[] = [];
			for (const v of videos) {
				const clip = await addClip(timeline, v);
				addedClips.push(clip);
			}

			if (method === "manual") {
				await saveTimeline(dir, timeline);
				return {
					content: [{ type: "text", text: [
						"═══ SCENE DETECTION (Manual) ═══",
						`Added ${addedClips.length} clips to timeline.`,
						"Clips are ungrouped — use manage_timeline to assign groups manually.",
						"",
						formatTimelineSummary(timeline),
					].join("\n") }],
					details: undefined,
				};
			}

			if (method === "metadata") {
				const metaGroups = new Map<string, TimelineClip[]>();
				for (const clip of addedClips) {
					const key = await getMetadataGroup(clip.video);
					const groupName = key.substring(0, 30);
					if (!metaGroups.has(groupName)) metaGroups.set(groupName, []);
					metaGroups.get(groupName)!.push(clip);
				}

				let groupIdx = 1;
				for (const [metaKey, clips] of metaGroups) {
					const groupName = `scene-${groupIdx++}`;
					for (const clip of clips) {
						setGroup(timeline, clip.id, groupName);
					}
					setReference(timeline, clips[0].id);
				}

				await saveTimeline(dir, timeline);
				return {
					content: [{ type: "text", text: [
						"═══ SCENE DETECTION (Metadata) ═══",
						`Analyzed ${addedClips.length} clips by metadata.`,
						`Found ${metaGroups.size} group(s).`,
						"",
						formatTimelineSummary(timeline),
					].join("\n") }],
					details: undefined,
				};
			}

			// Visual grouping (default)
			const clipStats: { clip: TimelineClip; stats: SignalStats }[] = [];
			for (const clip of addedClips) {
				const duration = await getClipDuration(clip.video);
				const sampleTime = String(Math.max(0.5, duration * 0.25));

				try {
					const stats = await analyzeClipAtTimecode(clip.video, sampleTime);
					clip.analysis = stats;
					clipStats.push({ clip, stats });
				} catch {
					clipStats.push({
						clip,
						stats: {
							YMIN: 0, YLOW: 0, YAVG: 128, YHIGH: 0, YMAX: 255,
							UMIN: 0, UAVG: 128, UMAX: 255,
							VMIN: 0, VAVG: 128, VMAX: 255,
							SATMIN: 0, SATAVG: 50, SATMAX: 255,
							HUEMED: 0, HUEAVG: 0,
						},
					});
				}
			}

			const groups = groupClusters(clipStats, threshold);

			const report: string[] = [
				"═══ SCENE DETECTION (Visual) ═══",
				`Analyzed ${addedClips.length} clips.`,
				`Found ${groups.size} scene group(s) (threshold: ${threshold}).`,
				"",
			];

			for (const [groupName, clips] of groups) {
				for (const clip of clips) {
					setGroup(timeline, clip.id, groupName);
				}
				setReference(timeline, clips[0].id);

				report.push(`── ${groupName}: ${clips.length} clip(s), reference: ${clips[0].id} ──`);
				for (const clip of clips) {
					const stats = clip.analysis;
					const statsStr = stats
						? `YAVG=${stats.YAVG.toFixed(1)} UAVG=${stats.UAVG.toFixed(1)} VAVG=${stats.VAVG.toFixed(1)} SAT=${stats.SATAVG.toFixed(1)}`
						: "(no stats)";
					report.push(`  ${clip.id}: ${statsStr}`);
				}
				report.push("");
			}

			await saveTimeline(dir, timeline);

			report.push("── Full Timeline ──");
			report.push(formatTimelineSummary(timeline));

			return { content: [{ type: "text", text: report.join("\n") }], details: undefined };
		},
	});
};

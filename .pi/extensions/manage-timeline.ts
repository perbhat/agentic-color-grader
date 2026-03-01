import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { resolve } from "path";
import { buildFilterChain, type CorrectionParams } from "./lib/ffmpeg.ts";
import {
	loadTimeline,
	saveTimeline,
	addClip,
	removeClip,
	setGroup,
	setReference,
	getClipsByGroup,
	formatTimelineSummary,
	formatClipSummary,
} from "./lib/timeline.ts";

const Parameters = Type.Object({
	timeline_dir: Type.String({ description: "Working directory for the timeline." }),
	action: Type.String({ description: 'Action to perform: "create", "add_clip", "remove_clip", "set_group", "set_reference", "apply_group_grade", "list", "propagate", "status".' }),
	name: Type.Optional(Type.String({ description: 'Timeline name (for "create" action).' })),
	video: Type.Optional(Type.String({ description: 'Video file path (for "add_clip" action).' })),
	clip_id: Type.Optional(Type.String({ description: 'Clip ID (for "remove_clip", "set_group", "set_reference" actions).' })),
	group: Type.Optional(Type.String({ description: 'Group name (for "set_group", "apply_group_grade" actions).' })),
	in_point: Type.Optional(Type.String({ description: "Start timecode for clip." })),
	out_point: Type.Optional(Type.String({ description: "End timecode for clip." })),
	corrections: Type.Optional(Type.Any({ description: 'Correction params (for "apply_group_grade" action).' })),
	from_clip_id: Type.Optional(Type.String({ description: 'Source clip ID (for "propagate" action).' })),
	to_group: Type.Optional(Type.String({ description: 'Target group for propagation (for "propagate" action). If empty, propagates to same group.' })),
});

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: undefined };
}

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "manage_timeline",
		label: "Manage Timeline",
		description:
			"CRUD operations for a multi-clip timeline. Create timelines, add/remove clips, assign scene groups, " +
			"set reference clips, apply group-level grades, propagate corrections between clips, and view status.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const dir = resolve(params.timeline_dir);
			const timeline = await loadTimeline(dir);
			const action = params.action;

			switch (action) {
				case "create": {
					timeline.name = params.name || "Untitled Timeline";
					await saveTimeline(dir, timeline);
					return text([
						"═══ TIMELINE CREATED ═══",
						`Name: ${timeline.name}`,
						`Location: ${dir}/.color-grader-tmp/timeline.json`,
						"Timeline is empty — use add_clip to add videos.",
					].join("\n"));
				}

				case "add_clip": {
					if (!params.video) return text("Error: video path is required for add_clip.");
					const videoPath = resolve(params.video);
					if (!existsSync(videoPath)) return text(`Error: Video file not found: ${videoPath}`);

					const clip = await addClip(timeline, videoPath, {
						group: params.group || undefined,
						in_point: params.in_point || undefined,
						out_point: params.out_point || undefined,
					});
					await saveTimeline(dir, timeline);

					return text([
						"═══ CLIP ADDED ═══",
						formatClipSummary(clip),
						`  Source format: ${clip.source_format}`,
						`  Duration: ${clip.in_point} → ${clip.out_point}`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"));
				}

				case "remove_clip": {
					if (!params.clip_id) return text("Error: clip_id is required for remove_clip.");
					const removed = removeClip(timeline, params.clip_id);
					if (!removed) return text(`Error: Clip not found: ${params.clip_id}`);
					await saveTimeline(dir, timeline);
					return text([
						`═══ CLIP REMOVED: ${params.clip_id} ═══`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"));
				}

				case "set_group": {
					if (!params.clip_id) return text("Error: clip_id is required for set_group.");
					if (!params.group) return text("Error: group is required for set_group.");
					const ok = setGroup(timeline, params.clip_id, params.group);
					if (!ok) return text(`Error: Clip not found: ${params.clip_id}`);
					await saveTimeline(dir, timeline);
					return text([
						`═══ GROUP ASSIGNED ═══`,
						`Clip ${params.clip_id} → group "${params.group}"`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"));
				}

				case "set_reference": {
					if (!params.clip_id) return text("Error: clip_id is required for set_reference.");
					const ok = setReference(timeline, params.clip_id);
					if (!ok) return text(`Error: Clip not found: ${params.clip_id}`);
					await saveTimeline(dir, timeline);
					const clip = timeline.clips.find((c) => c.id === params.clip_id)!;
					return text([
						`═══ REFERENCE SET ═══`,
						`Clip ${params.clip_id} is now the reference for group "${clip.group}".`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"));
				}

				case "apply_group_grade": {
					if (!params.group) return text("Error: group is required for apply_group_grade.");
					const corrections = params.corrections as CorrectionParams;
					if (!corrections || Object.keys(corrections).length === 0) {
						return text("Error: corrections object is required for apply_group_grade.");
					}

					if (!timeline.groups[params.group]) {
						timeline.groups[params.group] = {
							base_corrections: corrections,
							reference_clip_id: "",
						};
					} else {
						timeline.groups[params.group].base_corrections = corrections;
					}

					const filterChain = buildFilterChain(corrections);
					const clips = getClipsByGroup(timeline, params.group);
					for (const clip of clips) {
						const merged = { ...corrections, ...clip.corrections };
						clip.filter_chain = buildFilterChain(merged);
					}

					await saveTimeline(dir, timeline);
					return text([
						`═══ GROUP GRADE APPLIED ═══`,
						`Group: ${params.group}`,
						`Base filter chain: ${filterChain}`,
						`Applied to ${clips.length} clip(s).`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"));
				}

				case "list": {
					return text([
						"═══ TIMELINE ═══",
						formatTimelineSummary(timeline),
					].join("\n"));
				}

				case "propagate": {
					if (!params.from_clip_id) return text("Error: from_clip_id is required for propagate.");
					const sourceClip = timeline.clips.find((c) => c.id === params.from_clip_id);
					if (!sourceClip) return text(`Error: Source clip not found: ${params.from_clip_id}`);
					if (!sourceClip.filter_chain) return text(`Error: Source clip ${params.from_clip_id} has no corrections to propagate.`);

					const targetGroup = params.to_group || sourceClip.group;
					const targets = getClipsByGroup(timeline, targetGroup).filter(
						(c) => c.id !== sourceClip.id,
					);

					if (targets.length === 0) {
						return text(`Error: No other clips in group "${targetGroup}" to propagate to.`);
					}

					let count = 0;
					for (const target of targets) {
						target.corrections = { ...sourceClip.corrections };
						target.filter_chain = sourceClip.filter_chain;
						count++;
					}

					await saveTimeline(dir, timeline);
					return text([
						`═══ GRADE PROPAGATED ═══`,
						`From: ${sourceClip.id} (${sourceClip.group})`,
						`To: ${count} clip(s) in group "${targetGroup}"`,
						`Filter chain: ${sourceClip.filter_chain}`,
						"",
						"Propagated clips:",
						...targets.map((t) => formatClipSummary(t)),
						"",
						"Use match_shots to fine-tune each clip's match to the reference.",
					].join("\n"));
				}

				case "status": {
					const totalClips = timeline.clips.length;
					const gradedClips = timeline.clips.filter((c) => c.filter_chain).length;
					const ungradedClips = totalClips - gradedClips;
					const groups = [...new Set(timeline.clips.map((c) => c.group))];
					const referencedGroups = groups.filter((g) =>
						timeline.clips.some((c) => c.group === g && c.reference),
					);

					return text([
						"═══ TIMELINE STATUS ═══",
						`Name: ${timeline.name || "(unnamed)"}`,
						`Total clips: ${totalClips}`,
						`Graded: ${gradedClips}`,
						`Ungraded: ${ungradedClips}`,
						`Groups: ${groups.length} (${referencedGroups.length} with reference clips)`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"));
				}

				default:
					return text(`Error: Unknown action: "${action}". Valid actions: create, add_clip, remove_clip, set_group, set_reference, apply_group_grade, list, propagate, status.`);
			}
		},
	});
};

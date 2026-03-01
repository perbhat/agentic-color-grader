import { tool, ToolResult } from "pi-ext";
import { existsSync } from "fs";
import { resolve, basename } from "path";
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

export default tool({
	name: "manage_timeline",
	description:
		"CRUD operations for a multi-clip timeline. Create timelines, add/remove clips, assign scene groups, " +
		"set reference clips, apply group-level grades, propagate corrections between clips, and view status.",
	parameters: {
		timeline_dir: {
			type: "string",
			description: "Working directory for the timeline.",
		},
		action: {
			type: "string",
			description:
				'Action to perform: "create", "add_clip", "remove_clip", "set_group", "set_reference", ' +
				'"apply_group_grade", "list", "propagate", "status".',
		},
		name: {
			type: "string",
			description: 'Timeline name (for "create" action).',
			default: "",
		},
		video: {
			type: "string",
			description: 'Video file path (for "add_clip" action).',
			default: "",
		},
		clip_id: {
			type: "string",
			description: 'Clip ID (for "remove_clip", "set_group", "set_reference" actions).',
			default: "",
		},
		group: {
			type: "string",
			description: 'Group name (for "set_group", "apply_group_grade" actions).',
			default: "",
		},
		in_point: {
			type: "string",
			description: "Start timecode for clip.",
			default: "",
		},
		out_point: {
			type: "string",
			description: "End timecode for clip.",
			default: "",
		},
		corrections: {
			type: "object",
			description: 'Correction params (for "apply_group_grade" action).',
			default: {},
		},
		from_clip_id: {
			type: "string",
			description: 'Source clip ID (for "propagate" action).',
			default: "",
		},
		to_group: {
			type: "string",
			description: 'Target group for propagation (for "propagate" action). If empty, propagates to same group.',
			default: "",
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const dir = resolve(params.timeline_dir);
		const timeline = await loadTimeline(dir);
		const action = params.action;

		switch (action) {
			case "create": {
				timeline.name = params.name || "Untitled Timeline";
				await saveTimeline(dir, timeline);
				return {
					output: [
						"═══ TIMELINE CREATED ═══",
						`Name: ${timeline.name}`,
						`Location: ${dir}/.color-grader-tmp/timeline.json`,
						"Timeline is empty — use add_clip to add videos.",
					].join("\n"),
				};
			}

			case "add_clip": {
				if (!params.video) return { error: "video path is required for add_clip." };
				const videoPath = resolve(params.video);
				if (!existsSync(videoPath)) return { error: `Video file not found: ${videoPath}` };

				const clip = await addClip(timeline, videoPath, {
					group: params.group || undefined,
					in_point: params.in_point || undefined,
					out_point: params.out_point || undefined,
				});
				await saveTimeline(dir, timeline);

				return {
					output: [
						"═══ CLIP ADDED ═══",
						formatClipSummary(clip),
						`  Source format: ${clip.source_format}`,
						`  Duration: ${clip.in_point} → ${clip.out_point}`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"),
				};
			}

			case "remove_clip": {
				if (!params.clip_id) return { error: "clip_id is required for remove_clip." };
				const removed = removeClip(timeline, params.clip_id);
				if (!removed) return { error: `Clip not found: ${params.clip_id}` };
				await saveTimeline(dir, timeline);
				return {
					output: [
						`═══ CLIP REMOVED: ${params.clip_id} ═══`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"),
				};
			}

			case "set_group": {
				if (!params.clip_id) return { error: "clip_id is required for set_group." };
				if (!params.group) return { error: "group is required for set_group." };
				const ok = setGroup(timeline, params.clip_id, params.group);
				if (!ok) return { error: `Clip not found: ${params.clip_id}` };
				await saveTimeline(dir, timeline);
				return {
					output: [
						`═══ GROUP ASSIGNED ═══`,
						`Clip ${params.clip_id} → group "${params.group}"`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"),
				};
			}

			case "set_reference": {
				if (!params.clip_id) return { error: "clip_id is required for set_reference." };
				const ok = setReference(timeline, params.clip_id);
				if (!ok) return { error: `Clip not found: ${params.clip_id}` };
				await saveTimeline(dir, timeline);
				const clip = timeline.clips.find((c) => c.id === params.clip_id)!;
				return {
					output: [
						`═══ REFERENCE SET ═══`,
						`Clip ${params.clip_id} is now the reference for group "${clip.group}".`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"),
				};
			}

			case "apply_group_grade": {
				if (!params.group) return { error: "group is required for apply_group_grade." };
				const corrections = params.corrections as CorrectionParams;
				if (!corrections || Object.keys(corrections).length === 0) {
					return { error: "corrections object is required for apply_group_grade." };
				}

				// Set base corrections for the group
				if (!timeline.groups[params.group]) {
					timeline.groups[params.group] = {
						base_corrections: corrections,
						reference_clip_id: "",
					};
				} else {
					timeline.groups[params.group].base_corrections = corrections;
				}

				// Build filter chain and apply to all clips in the group
				const filterChain = buildFilterChain(corrections);
				const clips = getClipsByGroup(timeline, params.group);
				for (const clip of clips) {
					// Merge group base + per-clip corrections
					const merged = { ...corrections, ...clip.corrections };
					clip.filter_chain = buildFilterChain(merged);
				}

				await saveTimeline(dir, timeline);
				return {
					output: [
						`═══ GROUP GRADE APPLIED ═══`,
						`Group: ${params.group}`,
						`Base filter chain: ${filterChain}`,
						`Applied to ${clips.length} clip(s).`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"),
				};
			}

			case "list": {
				return {
					output: [
						"═══ TIMELINE ═══",
						formatTimelineSummary(timeline),
					].join("\n"),
				};
			}

			case "propagate": {
				if (!params.from_clip_id) return { error: "from_clip_id is required for propagate." };
				const sourceClip = timeline.clips.find((c) => c.id === params.from_clip_id);
				if (!sourceClip) return { error: `Source clip not found: ${params.from_clip_id}` };
				if (!sourceClip.filter_chain) return { error: `Source clip ${params.from_clip_id} has no corrections to propagate.` };

				const targetGroup = params.to_group || sourceClip.group;
				const targets = getClipsByGroup(timeline, targetGroup).filter(
					(c) => c.id !== sourceClip.id,
				);

				if (targets.length === 0) {
					return { error: `No other clips in group "${targetGroup}" to propagate to.` };
				}

				let count = 0;
				for (const target of targets) {
					target.corrections = { ...sourceClip.corrections };
					target.filter_chain = sourceClip.filter_chain;
					count++;
				}

				await saveTimeline(dir, timeline);
				return {
					output: [
						`═══ GRADE PROPAGATED ═══`,
						`From: ${sourceClip.id} (${sourceClip.group})`,
						`To: ${count} clip(s) in group "${targetGroup}"`,
						`Filter chain: ${sourceClip.filter_chain}`,
						"",
						"Propagated clips:",
						...targets.map((t) => formatClipSummary(t)),
						"",
						"Use match_shots to fine-tune each clip's match to the reference.",
					].join("\n"),
				};
			}

			case "status": {
				const totalClips = timeline.clips.length;
				const gradedClips = timeline.clips.filter((c) => c.filter_chain).length;
				const ungradedClips = totalClips - gradedClips;
				const groups = [...new Set(timeline.clips.map((c) => c.group))];
				const referencedGroups = groups.filter((g) =>
					timeline.clips.some((c) => c.group === g && c.reference),
				);

				return {
					output: [
						"═══ TIMELINE STATUS ═══",
						`Name: ${timeline.name || "(unnamed)"}`,
						`Total clips: ${totalClips}`,
						`Graded: ${gradedClips}`,
						`Ungraded: ${ungradedClips}`,
						`Groups: ${groups.length} (${referencedGroups.length} with reference clips)`,
						"",
						formatTimelineSummary(timeline),
					].join("\n"),
				};
			}

			default:
				return {
					error: `Unknown action: "${action}". Valid actions: create, add_clip, remove_clip, set_group, set_reference, apply_group_grade, list, propagate, status.`,
				};
		}
	},
});

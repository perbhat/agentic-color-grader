import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, basename } from "path";
import { runFfprobe, buildFilterChain, type SignalStats, type CorrectionParams } from "./ffmpeg.ts";

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface TimelineClip {
	id: string;
	name?: string;
	video: string;
	in_point: string;
	out_point: string;
	source_format: string;
	group: string;
	filter_chain: string;
	corrections: CorrectionParams;
	analysis: SignalStats | null;
	analysis_corrected: SignalStats | null;
	reference: boolean;
}

export interface GroupSettings {
	base_corrections: CorrectionParams;
	reference_clip_id: string;
}

export interface Timeline {
	name: string;
	clips: TimelineClip[];
	groups: Record<string, GroupSettings>;
	output_settings: {
		codec: string;
		quality: number;
	};
}

// ─── Persistence ───────────────────────────────────────────────────────────

function timelinePath(dir: string): string {
	return resolve(dir, ".color-grader-tmp", "timeline.json");
}

export async function loadTimeline(dir: string): Promise<Timeline> {
	const p = timelinePath(dir);
	if (existsSync(p)) {
		const raw = await readFile(p, "utf-8");
		return JSON.parse(raw) as Timeline;
	}
	return {
		name: "",
		clips: [],
		groups: {},
		output_settings: { codec: "libx264", quality: 18 },
	};
}

export async function saveTimeline(dir: string, timeline: Timeline): Promise<void> {
	const p = timelinePath(dir);
	const outDir = resolve(dir, ".color-grader-tmp");
	if (!existsSync(outDir)) {
		await mkdir(outDir, { recursive: true });
	}
	await writeFile(p, JSON.stringify(timeline, null, 2), "utf-8");
}

// ─── Source format detection ───────────────────────────────────────────────

export async function detectSourceFormat(video: string): Promise<string> {
	try {
		const { stdout, stderr } = await runFfprobe([
			"-v", "quiet",
			"-select_streams", "v:0",
			"-show_entries", "stream=color_transfer,color_primaries,color_space",
			"-show_entries", "stream_tags",
			"-print_format", "flat",
			"-i", video,
		]);
		const output = stdout + stderr;

		// Check color transfer characteristics
		if (/color_transfer="?arib-std-b67"?/i.test(output)) return "hlg";
		if (/color_transfer="?smpte2084"?/i.test(output)) return "hlg";
		if (/color_transfer="?bt709"?/i.test(output)) return "rec709";

		// Check for Sony S-Log tags in metadata
		const lower = output.toLowerCase();
		if (lower.includes("s-log3") || lower.includes("slog3")) return "slog3";
		if (lower.includes("s-log2") || lower.includes("slog2")) return "slog2";
		if (lower.includes("s-log") || lower.includes("slog")) return "slog3";

		// Check color primaries as fallback
		if (/color_primaries="?bt2020"?/i.test(output)) return "hlg";
		if (/color_primaries="?bt709"?/i.test(output)) return "rec709";

		return "unknown";
	} catch {
		return "unknown";
	}
}

// ─── Clip ID generation ───────────────────────────────────────────────────

function nextClipId(timeline: Timeline): string {
	const existing = timeline.clips.map((c) => {
		const m = c.id.match(/^clip-(\d+)$/);
		return m ? parseInt(m[1], 10) : 0;
	});
	const max = existing.length > 0 ? Math.max(...existing) : 0;
	return `clip-${String(max + 1).padStart(2, "0")}`;
}

// ─── CRUD operations ──────────────────────────────────────────────────────

export async function addClip(
	timeline: Timeline,
	video: string,
	options?: { group?: string; in_point?: string; out_point?: string; name?: string },
): Promise<TimelineClip> {
	const absPath = resolve(video);
	// Check if already in timeline
	const existing = timeline.clips.find((c) => c.video === absPath);
	if (existing) return existing;

	const format = await detectSourceFormat(absPath);

	// Detect duration for default out_point
	let duration = "end";
	try {
		const { stdout } = await runFfprobe([
			"-v", "quiet",
			"-show_entries", "format=duration",
			"-print_format", "flat",
			"-i", absPath,
		]);
		const match = stdout.match(/duration="?([\d.]+)"?/);
		if (match) {
			const secs = parseFloat(match[1]);
			const h = Math.floor(secs / 3600);
			const m = Math.floor((secs % 3600) / 60);
			const s = Math.floor(secs % 60);
			duration = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
		}
	} catch {
		// keep default
	}

	const clip: TimelineClip = {
		id: nextClipId(timeline),
		name: options?.name,
		video: absPath,
		in_point: options?.in_point ?? "00:00:00",
		out_point: options?.out_point ?? duration,
		source_format: format,
		group: options?.group ?? "ungrouped",
		filter_chain: "",
		corrections: {},
		analysis: null,
		analysis_corrected: null,
		reference: false,
	};

	timeline.clips.push(clip);
	return clip;
}

export function removeClip(timeline: Timeline, clipId: string): boolean {
	const idx = timeline.clips.findIndex((c) => c.id === clipId);
	if (idx === -1) return false;
	const clip = timeline.clips[idx];

	// Clean up group reference if this was the reference clip
	const group = timeline.groups[clip.group];
	if (group && group.reference_clip_id === clipId) {
		group.reference_clip_id = "";
	}

	timeline.clips.splice(idx, 1);
	return true;
}

export function setGroup(timeline: Timeline, clipId: string, group: string): boolean {
	const clip = timeline.clips.find((c) => c.id === clipId);
	if (!clip) return false;
	clip.group = group;

	// Ensure group exists in groups map
	if (!timeline.groups[group]) {
		timeline.groups[group] = {
			base_corrections: {},
			reference_clip_id: "",
		};
	}
	return true;
}

export function setReference(timeline: Timeline, clipId: string): boolean {
	const clip = timeline.clips.find((c) => c.id === clipId);
	if (!clip) return false;

	// Clear previous reference in the same group
	for (const c of timeline.clips) {
		if (c.group === clip.group) {
			c.reference = false;
		}
	}

	clip.reference = true;

	// Update group settings
	if (!timeline.groups[clip.group]) {
		timeline.groups[clip.group] = {
			base_corrections: {},
			reference_clip_id: clipId,
		};
	} else {
		timeline.groups[clip.group].reference_clip_id = clipId;
	}
	return true;
}

export function getClipsByGroup(timeline: Timeline, group: string): TimelineClip[] {
	return timeline.clips.filter((c) => c.group === group);
}

// ─── Summary helpers ──────────────────────────────────────────────────────

export function formatClipSummary(clip: TimelineClip): string {
	const refTag = clip.reference ? " [REFERENCE]" : "";
	const graded = clip.filter_chain ? "graded" : "ungraded";
	const name = clip.name || basename(clip.video);
	return `  ${clip.id}: ${name} (${clip.source_format}, ${clip.group}, ${graded})${refTag}`;
}

export function formatTimelineSummary(timeline: Timeline): string {
	const lines: string[] = [];
	lines.push(`Timeline: ${timeline.name || "(unnamed)"}`);
	lines.push(`Clips: ${timeline.clips.length}`);

	const groupNames = [...new Set(timeline.clips.map((c) => c.group))];
	lines.push(`Groups: ${groupNames.join(", ") || "(none)"}`);
	lines.push("");

	for (const group of groupNames) {
		const clips = getClipsByGroup(timeline, group);
		const graded = clips.filter((c) => c.filter_chain).length;
		lines.push(`── ${group} (${clips.length} clips, ${graded} graded) ──`);
		for (const clip of clips) {
			lines.push(formatClipSummary(clip));
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ─── Filter chain helpers ────────────────────────────────────────────────

export function buildCombinedFilterChain(clip: TimelineClip, groupBaseCorrections: Record<string, any>): string {
	// If clip has its own filter chain, use it (it should already include group base)
	if (clip.filter_chain) return clip.filter_chain;

	// Otherwise build from group base + clip corrections
	const groupBase = groupBaseCorrections[clip.group];
	if (groupBase && Object.keys(groupBase).length > 0) {
		const merged = { ...groupBase, ...clip.corrections };
		return buildFilterChain(merged);
	}

	if (clip.corrections && Object.keys(clip.corrections).length > 0) {
		return buildFilterChain(clip.corrections);
	}

	return "";
}

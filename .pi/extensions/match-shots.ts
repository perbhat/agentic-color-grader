import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolve } from "path";
import {
	extractSignalStats,
	buildFilterChain,
	type SignalStats,
	type CorrectionParams,
} from "./lib/ffmpeg.ts";
import {
	loadTimeline,
	saveTimeline,
	type TimelineClip,
} from "./lib/timeline.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

async function analyzeClip(clip: TimelineClip, filterChain?: string): Promise<SignalStats> {
	return extractSignalStats(clip.video, "1", filterChain);
}

function deriveMatchingCorrections(
	refStats: SignalStats,
	targetStats: SignalStats,
	aspects: string[],
	existingCorrections: CorrectionParams,
): CorrectionParams {
	const corrections: CorrectionParams = { ...existingCorrections };
	const matchAll = aspects.includes("all");

	if (matchAll || aspects.includes("exposure")) {
		const yDelta = refStats.YAVG - targetStats.YAVG;
		if (Math.abs(yDelta) > 3) {
			const currentExposure = corrections.exposure ?? 0;
			const exposureAdjust = yDelta / 40;
			corrections.exposure = parseFloat((currentExposure + exposureAdjust).toFixed(3));
		}
	}

	if (matchAll || aspects.includes("white_balance")) {
		const uDelta = refStats.UAVG - targetStats.UAVG;
		const vDelta = refStats.VAVG - targetStats.VAVG;

		if (Math.abs(uDelta) > 2 || Math.abs(vDelta) > 2) {
			if (Math.abs(uDelta) > 2) {
				const currentTemp = corrections.color_temperature ?? 6500;
				const tempAdjust = uDelta * 60;
				corrections.color_temperature = Math.round(currentTemp + tempAdjust);
			}

			if (Math.abs(vDelta) > 2) {
				const vShift = vDelta / 255;
				corrections.color_balance = {
					...corrections.color_balance,
					midtones: {
						r: parseFloat((vShift * 0.5).toFixed(3)),
						g: parseFloat((-vShift * 0.25).toFixed(3)),
						b: parseFloat((-vShift * 0.25).toFixed(3)),
					},
				};
			}
		}
	}

	if (matchAll || aspects.includes("saturation")) {
		const satDelta = refStats.SATAVG - targetStats.SATAVG;
		if (Math.abs(satDelta) > 3 && targetStats.SATAVG > 0) {
			const currentSat = corrections.saturation ?? 1.0;
			const satMultiplier = refStats.SATAVG / targetStats.SATAVG;
			const blended = 1.0 + (satMultiplier - 1.0) * 0.7;
			corrections.saturation = parseFloat((currentSat * blended).toFixed(3));
		}
	}

	return corrections;
}

function formatStatsDelta(ref: SignalStats, target: SignalStats, label: string): string {
	const lines: string[] = [`── ${label} ──`];
	lines.push(`  YAVG:   ref=${ref.YAVG.toFixed(1)}  target=${target.YAVG.toFixed(1)}  delta=${(ref.YAVG - target.YAVG).toFixed(1)}`);
	lines.push(`  UAVG:   ref=${ref.UAVG.toFixed(1)}  target=${target.UAVG.toFixed(1)}  delta=${(ref.UAVG - target.UAVG).toFixed(1)}`);
	lines.push(`  VAVG:   ref=${ref.VAVG.toFixed(1)}  target=${target.VAVG.toFixed(1)}  delta=${(ref.VAVG - target.VAVG).toFixed(1)}`);
	lines.push(`  SATAVG: ref=${ref.SATAVG.toFixed(1)}  target=${target.SATAVG.toFixed(1)}  delta=${(ref.SATAVG - target.SATAVG).toFixed(1)}`);
	return lines.join("\n");
}

// ─── Tool ─────────────────────────────────────────────────────────────────

const Parameters = Type.Object({
	timeline_dir: Type.String({ description: "Working directory for the timeline." }),
	reference_clip_id: Type.String({ description: "ID of the reference (hero) clip to match to." }),
	target_clip_id: Type.String({ description: "ID of the target clip to adjust." }),
	match_aspects: Type.Optional(Type.Array(Type.String(), { description: 'Aspects to match: "exposure", "white_balance", "saturation", or "all". Default: ["all"].' })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "match_shots",
		label: "Match Shots",
		description:
			"Compare a reference clip's color stats to a target clip and derive corrections to match them. " +
			"Analyzes exposure, white balance, and saturation differences, then applies matching corrections to the target. " +
			"Re-analyzes to verify the match.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const dir = resolve(params.timeline_dir);
			const timeline = await loadTimeline(dir);

			const refClip = timeline.clips.find((c) => c.id === params.reference_clip_id);
			const targetClip = timeline.clips.find((c) => c.id === params.target_clip_id);

			if (!refClip) return { content: [{ type: "text", text: `Error: Reference clip not found: ${params.reference_clip_id}` }], details: undefined };
			if (!targetClip) return { content: [{ type: "text", text: `Error: Target clip not found: ${params.target_clip_id}` }], details: undefined };

			const aspects: string[] = params.match_aspects ?? ["all"];

			let refStats: SignalStats;
			if (refClip.analysis_corrected) {
				refStats = refClip.analysis_corrected;
			} else {
				const refFilter = refClip.filter_chain || undefined;
				refStats = await analyzeClip(refClip, refFilter);
				if (refFilter) {
					refClip.analysis_corrected = refStats;
				} else {
					refClip.analysis = refStats;
				}
			}

			const targetFilter = targetClip.filter_chain || undefined;
			const targetStatsBefore = await analyzeClip(targetClip, targetFilter);
			if (targetFilter) {
				targetClip.analysis_corrected = targetStatsBefore;
			} else {
				targetClip.analysis = targetStatsBefore;
			}

			const newCorrections = deriveMatchingCorrections(
				refStats,
				targetStatsBefore,
				aspects,
				targetClip.corrections,
			);

			targetClip.corrections = newCorrections;
			const newFilterChain = buildFilterChain(newCorrections);
			targetClip.filter_chain = newFilterChain;

			const targetStatsAfter = await analyzeClip(targetClip, newFilterChain);
			targetClip.analysis_corrected = targetStatsAfter;

			await saveTimeline(dir, timeline);

			const report = [
				"═══ SHOT MATCHING ═══",
				`Reference: ${refClip.id} (${refClip.group})`,
				`Target:    ${targetClip.id} (${targetClip.group})`,
				`Aspects:   ${aspects.join(", ")}`,
				"",
				formatStatsDelta(refStats, targetStatsBefore, "BEFORE matching"),
				"",
				formatStatsDelta(refStats, targetStatsAfter, "AFTER matching"),
				"",
				"── Corrections Applied ──",
				`  Filter chain: ${newFilterChain}`,
				`  Params: ${JSON.stringify(newCorrections, null, 2)}`,
				"",
				"── Match Quality ──",
				`  YAVG delta:   ${Math.abs(refStats.YAVG - targetStatsBefore.YAVG).toFixed(1)} → ${Math.abs(refStats.YAVG - targetStatsAfter.YAVG).toFixed(1)}`,
				`  UAVG delta:   ${Math.abs(refStats.UAVG - targetStatsBefore.UAVG).toFixed(1)} → ${Math.abs(refStats.UAVG - targetStatsAfter.UAVG).toFixed(1)}`,
				`  VAVG delta:   ${Math.abs(refStats.VAVG - targetStatsBefore.VAVG).toFixed(1)} → ${Math.abs(refStats.VAVG - targetStatsAfter.VAVG).toFixed(1)}`,
				`  SATAVG delta: ${Math.abs(refStats.SATAVG - targetStatsBefore.SATAVG).toFixed(1)} → ${Math.abs(refStats.SATAVG - targetStatsAfter.SATAVG).toFixed(1)}`,
			].join("\n");

			return { content: [{ type: "text", text: report }], details: undefined };
		},
	});
};

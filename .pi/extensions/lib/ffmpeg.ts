import { execFile } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

// ─── Interfaces ────────────────────────────────────────────────────────────

export interface SignalStats {
	YMIN: number;
	YLOW: number;
	YAVG: number;
	YHIGH: number;
	YMAX: number;
	UMIN: number;
	UAVG: number;
	UMAX: number;
	VMIN: number;
	VAVG: number;
	VMAX: number;
	SATMIN: number;
	SATAVG: number;
	SATMAX: number;
	HUEMED: number;
	HUEAVG: number;
}

export interface ZoneDistribution {
	blacks: number;
	shadows: number;
	midtones: number;
	highlights: number;
	whites: number;
}

export interface ColorBalance {
	r: number;
	g: number;
	b: number;
}

export interface CurvePoints {
	master?: string;
	r?: string;
	g?: string;
	b?: string;
}

export interface CorrectionParams {
	lut?: string;
	exposure?: number;
	contrast?: number;
	gamma?: number;
	gamma_r?: number;
	gamma_g?: number;
	gamma_b?: number;
	saturation?: number;
	color_temperature?: number;
	color_balance?: {
		shadows?: ColorBalance;
		midtones?: ColorBalance;
		highlights?: ColorBalance;
	};
	curves?: CurvePoints;
	custom_filter?: string;
}

// ─── LUT path resolution ──────────────────────────────────────────────────

function getLutDir(): string {
	// Try import.meta.url first, fall back to cwd-based resolution
	try {
		const metaDir = new URL("../../../luts", import.meta.url).pathname;
		if (existsSync(metaDir)) return metaDir;
	} catch {
		// import.meta.url not available or path doesn't exist
	}
	// Fallback: resolve relative to project root (cwd)
	const cwdDir = resolve(process.cwd(), "luts");
	if (existsSync(cwdDir)) return cwdDir;
	// Last resort: try relative to this file via __dirname-like approach
	const fileDir = resolve(new URL(".", import.meta.url).pathname, "../../../luts");
	return fileDir;
}

export function resolveLutPath(lut: string): string {
	const lutDir = getLutDir();
	const shortcuts: Record<string, string> = {
		"slog3-to-rec709": resolve(lutDir, "slog3-to-rec709.cube"),
		"slog2-to-rec709": resolve(lutDir, "slog3-to-rec709.cube"),
	};
	return shortcuts[lut] ?? lut;
}

// ─── Shell helpers ─────────────────────────────────────────────────────────

export async function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("ffmpeg", ["-y", ...args], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`ffmpeg failed: ${stderr}\n${err.message}`));
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

export async function runFfprobe(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("ffprobe", args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`ffprobe failed: ${stderr}\n${err.message}`));
			} else {
				resolve({ stdout, stderr });
			}
		});
	});
}

// ─── Signal stats extraction (uses ffmpeg, not ffprobe) ───────────────────

export async function extractSignalStats(
	video: string,
	timecode: string,
	filterChain?: string,
): Promise<SignalStats> {
	const vf = filterChain
		? `${filterChain},signalstats,metadata=mode=print`
		: "signalstats,metadata=mode=print";

	const args = [
		"-ss", timecode,
		"-i", video,
		"-vf", vf,
		"-frames:v", "1",
		"-f", "null",
		"-",
	];

	const { stderr } = await runFfmpeg(args);
	return parseSignalStats(stderr);
}

// ─── Filter chain builder ──────────────────────────────────────────────────

export function buildFilterChain(corrections: CorrectionParams): string {
	const filters: string[] = [];

	// 1. LUT (first — converts log to linear/rec709 space)
	if (corrections.lut) {
		const lutPath = resolveLutPath(corrections.lut);
		filters.push(`lut3d='${lutPath}'`);
	}

	// 2. Exposure / gamma (basic tonal)
	if (corrections.exposure !== undefined) {
		const factor = Math.pow(2, corrections.exposure);
		filters.push(`curves=master='0/0 ${0.5 / factor}/${0.5} 1/1'`);
	}
	if (corrections.gamma !== undefined) {
		filters.push(`eq=gamma=${corrections.gamma}`);
	}
	if (corrections.gamma_r !== undefined || corrections.gamma_g !== undefined || corrections.gamma_b !== undefined) {
		const r = corrections.gamma_r ?? 1;
		const g = corrections.gamma_g ?? 1;
		const b = corrections.gamma_b ?? 1;
		filters.push(`lutyuv=y=gammaval(${1 / ((r + g + b) / 3)})`);
		// Per-channel gamma via colorchannelmixer approach
		if (r !== 1 || g !== 1 || b !== 1) {
			filters.push(`colorbalance=rs=${r - 1}:gs=${g - 1}:bs=${b - 1}:rm=${r - 1}:gm=${g - 1}:bm=${b - 1}:rh=${r - 1}:gh=${g - 1}:bh=${b - 1}`);
		}
	}

	// 3. Contrast
	if (corrections.contrast !== undefined) {
		filters.push(`eq=contrast=${corrections.contrast}`);
	}

	// 4. Color temperature
	if (corrections.color_temperature !== undefined) {
		filters.push(`colortemperature=temperature=${corrections.color_temperature}`);
	}

	// 5. Color balance (shadows / midtones / highlights)
	if (corrections.color_balance) {
		const cb = corrections.color_balance;
		const parts: string[] = [];
		if (cb.shadows) {
			parts.push(`rs=${cb.shadows.r}:gs=${cb.shadows.g}:bs=${cb.shadows.b}`);
		}
		if (cb.midtones) {
			parts.push(`rm=${cb.midtones.r}:gm=${cb.midtones.g}:bm=${cb.midtones.b}`);
		}
		if (cb.highlights) {
			parts.push(`rh=${cb.highlights.r}:gh=${cb.highlights.g}:bh=${cb.highlights.b}`);
		}
		if (parts.length > 0) {
			filters.push(`colorbalance=${parts.join(":")}`);
		}
	}

	// 6. Curves
	if (corrections.curves) {
		const curveParts: string[] = [];
		if (corrections.curves.master) curveParts.push(`master='${corrections.curves.master}'`);
		if (corrections.curves.r) curveParts.push(`red='${corrections.curves.r}'`);
		if (corrections.curves.g) curveParts.push(`green='${corrections.curves.g}'`);
		if (corrections.curves.b) curveParts.push(`blue='${corrections.curves.b}'`);
		if (curveParts.length > 0) {
			filters.push(`curves=${curveParts.join(":")}`);
		}
	}

	// 7. Saturation
	if (corrections.saturation !== undefined) {
		filters.push(`eq=saturation=${corrections.saturation}`);
	}

	// 8. Custom filter (last — escape hatch)
	if (corrections.custom_filter) {
		filters.push(corrections.custom_filter);
	}

	return filters.join(",");
}

// ─── Signal stats parser ───────────────────────────────────────────────────

export function parseSignalStats(raw: string): SignalStats {
	const stats: Record<string, number> = {};
	const keyPattern = /lavfi\.signalstats\.([\w]+)=([\d.]+)/g;
	let match: RegExpExecArray | null;
	while ((match = keyPattern.exec(raw)) !== null) {
		stats[match[1]] = parseFloat(match[2]);
	}

	return {
		YMIN: stats["YMIN"] ?? 0,
		YLOW: stats["YLOW"] ?? 0,
		YAVG: stats["YAVG"] ?? 0,
		YHIGH: stats["YHIGH"] ?? 0,
		YMAX: stats["YMAX"] ?? 0,
		UMIN: stats["UMIN"] ?? 0,
		UAVG: stats["UAVG"] ?? 0,
		UMAX: stats["UMAX"] ?? 0,
		VMIN: stats["VMIN"] ?? 0,
		VAVG: stats["VAVG"] ?? 0,
		VMAX: stats["VMAX"] ?? 0,
		SATMIN: stats["SATMIN"] ?? 0,
		SATAVG: stats["SATAVG"] ?? 0,
		SATMAX: stats["SATMAX"] ?? 0,
		HUEMED: stats["HUEMED"] ?? 0,
		HUEAVG: stats["HUEAVG"] ?? 0,
	};
}

// ─── Zone distribution ─────────────────────────────────────────────────────

export function computeZoneDistribution(stats: SignalStats): ZoneDistribution {
	const range = stats.YMAX - stats.YMIN || 1;
	const low = ((stats.YLOW - stats.YMIN) / range) * 100;
	const mid = ((stats.YHIGH - stats.YLOW) / range) * 100;
	const high = ((stats.YMAX - stats.YHIGH) / range) * 100;

	return {
		blacks: Math.max(0, Math.min(100, stats.YMIN <= 16 ? 5 + (16 - stats.YMIN) : 2)),
		shadows: Math.max(0, Math.min(100, low * 0.4)),
		midtones: Math.max(0, Math.min(100, mid * 0.6)),
		highlights: Math.max(0, Math.min(100, high * 0.4)),
		whites: Math.max(0, Math.min(100, stats.YMAX >= 240 ? 5 + (stats.YMAX - 240) / 3 : 2)),
	};
}

// ─── Exposure diagnosis ────────────────────────────────────────────────────

export function diagnoseExposure(stats: SignalStats): string {
	const lines: string[] = [];

	if (stats.YAVG < 60) {
		lines.push("⚠ UNDEREXPOSED: Average luminance is low (YAVG=" + stats.YAVG.toFixed(1) + "). Consider increasing exposure or gamma.");
	} else if (stats.YAVG > 200) {
		lines.push("⚠ OVEREXPOSED: Average luminance is high (YAVG=" + stats.YAVG.toFixed(1) + "). Consider decreasing exposure.");
	} else {
		lines.push("✓ Exposure looks reasonable (YAVG=" + stats.YAVG.toFixed(1) + ").");
	}

	if (stats.YMIN > 30) {
		lines.push("⚠ LIFTED BLACKS: Minimum Y=" + stats.YMIN.toFixed(0) + " — blacks are not reaching true black. Typical for S-Log footage pre-correction.");
	} else if (stats.YMIN < 5) {
		lines.push("⚠ CRUSHED BLACKS: Minimum Y=" + stats.YMIN.toFixed(0) + " — shadow detail may be lost.");
	} else {
		lines.push("✓ Black level OK (YMIN=" + stats.YMIN.toFixed(0) + ").");
	}

	if (stats.YMAX < 200) {
		lines.push("⚠ LOW HIGHLIGHTS: Maximum Y=" + stats.YMAX.toFixed(0) + " — image doesn't use full brightness range.");
	} else if (stats.YMAX > 250) {
		lines.push("⚠ CLIPPED HIGHLIGHTS: Maximum Y=" + stats.YMAX.toFixed(0) + " — highlight detail may be lost.");
	} else {
		lines.push("✓ Highlight level OK (YMAX=" + stats.YMAX.toFixed(0) + ").");
	}

	const uOffset = stats.UAVG - 128;
	const vOffset = stats.VAVG - 128;
	if (Math.abs(uOffset) > 5 || Math.abs(vOffset) > 5) {
		const castParts: string[] = [];
		if (uOffset > 5) castParts.push("blue shift");
		if (uOffset < -5) castParts.push("yellow shift");
		if (vOffset > 5) castParts.push("red/magenta shift");
		if (vOffset < -5) castParts.push("green/cyan shift");
		lines.push(`⚠ COLOR CAST detected: ${castParts.join(", ")} (UAVG=${stats.UAVG.toFixed(1)}, VAVG=${stats.VAVG.toFixed(1)}, neutral=128).`);
	} else {
		lines.push("✓ Color balance looks neutral (UAVG=" + stats.UAVG.toFixed(1) + ", VAVG=" + stats.VAVG.toFixed(1) + ").");
	}

	if (stats.SATAVG < 20) {
		lines.push("⚠ LOW SATURATION: Average saturation=" + stats.SATAVG.toFixed(1) + ". Typical for log footage; will improve after LUT application.");
	} else if (stats.SATAVG > 120) {
		lines.push("⚠ HIGH SATURATION: Average saturation=" + stats.SATAVG.toFixed(1) + ". Consider reducing saturation.");
	} else {
		lines.push("✓ Saturation level OK (SATAVG=" + stats.SATAVG.toFixed(1) + ").");
	}

	return lines.join("\n");
}

// ─── Timecode helpers ──────────────────────────────────────────────────────

export function resolveTimecode(tc: string): string {
	if (/^\d+(\.\d+)?$/.test(tc)) {
		return tc;
	}
	if (/^\d{1,2}:\d{2}:\d{2}(\.\d+)?$/.test(tc)) {
		return tc;
	}
	if (/^\d{1,2}:\d{2}(\.\d+)?$/.test(tc)) {
		return "00:" + tc;
	}
	throw new Error(`Invalid timecode format: "${tc}". Use HH:MM:SS, MM:SS, or seconds.`);
}

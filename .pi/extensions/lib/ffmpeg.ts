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

export interface SuggestedCorrections {
	exposure?: number;
	gamma?: number;
	contrast?: number;
	color_temperature?: number;
	saturation?: number;
	color_balance?: {
		shadows?: ColorBalance;
		midtones?: ColorBalance;
		highlights?: ColorBalance;
	};
}

export function diagnoseExposure(stats: SignalStats, sourceFormat?: string): string {
	const lines: string[] = [];
	const isLog = sourceFormat ? /^(slog|log|hlg)/i.test(sourceFormat) : false;
	const logNote = " Expected for log/S-Log footage pre-LUT; will normalize after LUT application.";

	if (stats.YAVG < 60) {
		lines.push("⚠ UNDEREXPOSED: Average luminance is low (YAVG=" + stats.YAVG.toFixed(1) + ")." + (isLog ? logNote : " Consider increasing exposure or gamma."));
	} else if (stats.YAVG > 200) {
		lines.push("⚠ OVEREXPOSED: Average luminance is high (YAVG=" + stats.YAVG.toFixed(1) + "). Consider decreasing exposure.");
	} else {
		lines.push("✓ Exposure looks reasonable (YAVG=" + stats.YAVG.toFixed(1) + ").");
	}

	if (stats.YMIN > 30) {
		lines.push("⚠ LIFTED BLACKS: Minimum Y=" + stats.YMIN.toFixed(0) + " — blacks are not reaching true black." + (isLog ? logNote : " Typical for S-Log footage pre-correction."));
	} else if (stats.YMIN < 5) {
		lines.push("⚠ CRUSHED BLACKS: Minimum Y=" + stats.YMIN.toFixed(0) + " — shadow detail may be lost.");
	} else {
		lines.push("✓ Black level OK (YMIN=" + stats.YMIN.toFixed(0) + ").");
	}

	if (stats.YMAX < 200) {
		lines.push("⚠ LOW HIGHLIGHTS: Maximum Y=" + stats.YMAX.toFixed(0) + " — image doesn't use full brightness range." + (isLog ? logNote : ""));
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
		lines.push("⚠ LOW SATURATION: Average saturation=" + stats.SATAVG.toFixed(1) + "." + (isLog ? logNote : " Typical for log footage; will improve after LUT application."));
	} else if (stats.SATAVG > 120) {
		lines.push("⚠ HIGH SATURATION: Average saturation=" + stats.SATAVG.toFixed(1) + ". Consider reducing saturation.");
	} else {
		lines.push("✓ Saturation level OK (SATAVG=" + stats.SATAVG.toFixed(1) + ").");
	}

	return lines.join("\n");
}

/**
 * Derive concrete correction values from signal stats to neutralize the image.
 * Returns suggested parameters that can be directly applied via apply_correction.
 * Designed for post-LUT footage (Rec.709 space) — do NOT use on raw log footage.
 */
export function deriveCorrectionFromStats(stats: SignalStats): SuggestedCorrections {
	const corrections: SuggestedCorrections = {};

	// ── Exposure: target YAVG ~110 (middle of 80-140 range) ──
	if (stats.YAVG < 70) {
		// Need to brighten — map how far off we are to stops
		corrections.exposure = Math.min(1.5, (110 - stats.YAVG) / 80);
	} else if (stats.YAVG > 160) {
		corrections.exposure = Math.max(-1.5, (110 - stats.YAVG) / 80);
	}

	// ── Gamma: fine-tune midtones if YAVG is slightly off ──
	if (stats.YAVG >= 70 && stats.YAVG < 90) {
		corrections.gamma = 0.9 + (stats.YAVG - 70) * 0.005; // slight brightening
	} else if (stats.YAVG > 140 && stats.YAVG <= 160) {
		corrections.gamma = 1.0 + (stats.YAVG - 140) * 0.005; // slight darkening
	}

	// ── Contrast: if blacks are lifted post-LUT, add mild contrast ──
	if (stats.YMIN > 20 && stats.YMAX < 240) {
		corrections.contrast = 1.0 + Math.min(0.3, (stats.YMIN - 10) / 100);
	}

	// ── Color temperature: correct U-axis (blue/yellow) cast ──
	const uOffset = stats.UAVG - 128;
	if (Math.abs(uOffset) > 3) {
		// U > 128 = blue cast → lower temp (warmer), U < 128 = yellow cast → higher temp (cooler)
		// Scale: each unit of U offset ≈ 60K correction
		corrections.color_temperature = 6500 - (uOffset * 60);
		// Clamp to reasonable range
		corrections.color_temperature = Math.max(3000, Math.min(10000, corrections.color_temperature));
	}

	// ── Color balance: correct V-axis (red-green/magenta-cyan) tint ──
	const vOffset = stats.VAVG - 128;
	if (Math.abs(vOffset) > 3) {
		// V > 128 = red/magenta shift → reduce red, add green
		// V < 128 = green/cyan shift → add red, reduce green
		const shift = -(vOffset / 128) * 0.5; // map to -0.5 .. 0.5 range
		corrections.color_balance = {
			midtones: {
				r: parseFloat(shift.toFixed(3)),
				g: parseFloat((-shift * 0.5).toFixed(3)),
				b: parseFloat((-shift * 0.25).toFixed(3)),
			},
		};
	}

	// ── Saturation: target SATAVG ~55 (middle of 40-80 range) ──
	if (stats.SATAVG < 30) {
		corrections.saturation = Math.min(1.6, 55 / Math.max(stats.SATAVG, 5));
	} else if (stats.SATAVG > 90) {
		corrections.saturation = Math.max(0.5, 55 / stats.SATAVG);
	}

	return corrections;
}

// ─── Timecode helpers ──────────────────────────────────────────────────────

/**
 * Probe the embedded start time of a video file.
 * Camera files (e.g. Sony) often embed a continuous timecode (e.g. 00:25:33)
 * which FCPXML references as the `start` attribute. FFmpeg's `-ss` flag seeks
 * relative to the file start (0), not the embedded timecode, so we need to
 * know the offset to convert FCPXML timecodes to file-relative positions.
 *
 * Returns the start_time in seconds, or 0 if not found/not applicable.
 */
export async function probeStartTime(video: string): Promise<number> {
	try {
		const { stdout } = await runFfprobe([
			"-v", "quiet",
			"-show_entries", "format=start_time",
			"-print_format", "flat",
			"-i", video,
		]);
		const match = stdout.match(/start_time="?([\d.]+)"?/);
		if (match) {
			return parseFloat(match[1]);
		}
	} catch {
		// fall through
	}

	// Fallback: check video stream start_time
	try {
		const { stdout } = await runFfprobe([
			"-v", "quiet",
			"-select_streams", "v:0",
			"-show_entries", "stream=start_time",
			"-print_format", "flat",
			"-i", video,
		]);
		const match = stdout.match(/start_time="?([\d.]+)"?/);
		if (match) {
			return parseFloat(match[1]);
		}
	} catch {
		// fall through
	}

	return 0;
}

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

// ─── Image preparation for API ────────────────────────────────────────────

const API_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024; // 3.5MB — conservative limit to stay safely under 5MB API cap

/**
 * Read a PNG frame from disk and prepare it for the API.
 * If the file exceeds the size limit, re-encodes as a smaller PNG (never JPEG).
 * PNG is lossless and preserves chroma precision needed for tint/color cast detection.
 * Returns { data: base64string, mimeType: string }.
 */
export async function prepareImageForApi(
	pngPath: string,
): Promise<{ data: string; mimeType: string }> {
	const { readFile, stat } = await import("fs/promises");

	const info = await stat(pngPath);

	if (info.size <= API_IMAGE_MAX_BYTES) {
		const imgData = await readFile(pngPath);
		return { data: imgData.toString("base64"), mimeType: "image/png" };
	}

	// Re-encode as downscaled PNG — NEVER use JPEG for color grading previews.
	// JPEG compression smears subtle chroma shifts (UV ±5 from 128) making
	// tint detection unreliable. PNG stays lossless even when resized.
	const scaledPath = pngPath.replace(/\.png$/, "-api.png");

	// Try progressively smaller sizes until we fit
	for (const maxWidth of [1920, 1440, 1280, 960]) {
		await runFfmpeg([
			"-i", pngPath,
			"-vf", `scale='min(${maxWidth},iw)':-2`,
			scaledPath,
		]);

		const scaledInfo = await stat(scaledPath);
		if (scaledInfo.size <= API_IMAGE_MAX_BYTES) {
			const scaledData = await readFile(scaledPath);
			return { data: scaledData.toString("base64"), mimeType: "image/png" };
		}
	}

	// Last resort: smallest size, still PNG
	await runFfmpeg([
		"-i", pngPath,
		"-vf", "scale='min(800,iw)':-2",
		scaledPath,
	]);
	const scaledData = await readFile(scaledPath);
	return { data: scaledData.toString("base64"), mimeType: "image/png" };
}

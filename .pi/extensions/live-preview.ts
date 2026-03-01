import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { spawn, execFile, type ChildProcess } from "child_process";
import { buildFilterChain, resolveTimecode, type CorrectionParams } from "./lib/ffmpeg.ts";

// ─── Module-level state ───────────────────────────────────────────────────

let activeProcess: ChildProcess | null = null;
let activeVideo: string = "";
let activeFilterChain: string = "";

function killActive(): boolean {
	if (activeProcess) {
		try {
			activeProcess.kill("SIGTERM");
		} catch {}
		activeProcess = null;
		return true;
	}
	return false;
}

// ─── Tool ─────────────────────────────────────────────────────────────────

const Parameters = Type.Object({
	action: Type.String({ description: '"play" to open ffplay, "frame" for inline terminal image, "update" to change filter chain, "stop" to close.' }),
	video: Type.Optional(Type.String({ description: "Path to the video file." })),
	filter_chain: Type.Optional(Type.String({ description: "FFmpeg filter chain to apply. If omitted, uses corrections param instead." })),
	corrections: Type.Optional(Type.Any({ description: "Correction parameters (alternative to filter_chain). Same format as apply_correction." })),
	timecode: Type.Optional(Type.String({ description: 'Start timecode for playback or frame extraction. Default: "00:00:00".' })),
	loop: Type.Optional(Type.Boolean({ description: "Loop playback. Default: true." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "live_preview",
		label: "Live Preview",
		description:
			"Open a live video preview window using ffplay with the current filter chain applied. " +
			"Shows the graded video playing in real time. Can also render a preview frame inline. " +
			"Use action 'play' to open video playback, 'frame' for a single preview frame, " +
			"'update' to refresh with a new filter chain, or 'stop' to close.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const action = params.action;

			// ── Stop ──
			if (action === "stop") {
				const wasRunning = killActive();
				return {
					content: [{ type: "text", text: wasRunning ? "Live preview stopped." : "No live preview was running." }],
					details: undefined,
				};
			}

			// ── Resolve filter chain ──
			let filterChain = params.filter_chain || "";
			if (!filterChain) {
				const corrections = params.corrections as CorrectionParams;
				if (corrections && Object.keys(corrections).length > 0) {
					filterChain = buildFilterChain(corrections);
				}
			}

			// ── Frame (preview frame with image returned) ──
			if (action === "frame") {
				const videoPath = resolve(params.video || activeVideo);
				if (!videoPath || !existsSync(videoPath)) {
					return { content: [{ type: "text", text: `Error: Video file not found: ${params.video || activeVideo || "(none)"}` }], details: undefined };
				}

				const tc = resolveTimecode(params.timecode ?? "00:00:01");
				const tmpDir = resolve(videoPath, "..", ".color-grader-tmp");
				const framePath = resolve(tmpDir, "live-preview-frame.png");

				const { promisify } = await import("util");
				const exec = promisify(execFile);
				await exec("mkdir", ["-p", tmpDir]);

				const ffmpegArgs = [
					"-y",
					"-ss", tc,
					"-i", videoPath,
					...(filterChain ? ["-vf", filterChain] : []),
					"-frames:v", "1",
					"-q:v", "2",
					framePath,
				];

				try {
					await new Promise<void>((res, rej) => {
						execFile("ffmpeg", ffmpegArgs, { maxBuffer: 50 * 1024 * 1024 }, (err) => {
							if (err) rej(err);
							else res();
						});
					});
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error: Frame extraction failed: ${err.message}` }], details: undefined };
				}

				const report = [
					"═══ PREVIEW FRAME ═══",
					`Video: ${videoPath}`,
					`Timecode: ${tc}`,
					filterChain ? `Filter chain: ${filterChain}` : "Filter chain: (none — raw)",
				].join("\n");

				const content: any[] = [{ type: "text" as const, text: report }];
				try {
					const imgData = await readFile(framePath);
					content.push({ type: "image" as const, data: imgData.toString("base64"), mimeType: "image/png" });
				} catch {
					content.push({ type: "text" as const, text: `\nFrame saved to: ${framePath}` });
				}

				return { content, details: undefined };
			}

			// ── Play / Update ──
			if (action === "play" || action === "update") {
				const videoPath = resolve(params.video || activeVideo);
				if (!videoPath || !existsSync(videoPath)) {
					return { content: [{ type: "text", text: `Error: Video file not found: ${params.video || activeVideo || "(none)"}` }], details: undefined };
				}

				killActive();

				const tc = resolveTimecode(params.timecode ?? "00:00:00");
				const loop = params.loop ?? true;

				const ffplayArgs = [
					"-ss", tc,
					"-i", videoPath,
					...(filterChain ? ["-vf", filterChain] : []),
					"-window_title", `Grade Preview: ${filterChain ? "graded" : "raw"}`,
					"-autoexit",
					...(loop ? ["-loop", "0"] : []),
					"-loglevel", "quiet",
				];

				try {
					await new Promise<void>((res, rej) => {
						execFile("ffplay", ["-version"], { maxBuffer: 1024 * 1024 }, (err) => {
							if (err) rej(err);
							else res();
						});
					});
				} catch {
					return {
						content: [{ type: "text", text: "Error: ffplay not found. Install ffmpeg with ffplay support (brew install ffmpeg)." }],
						details: undefined,
					};
				}

				const proc = spawn("ffplay", ffplayArgs, {
					detached: false,
					stdio: "ignore",
				});

				proc.on("error", () => {
					activeProcess = null;
				});
				proc.on("exit", () => {
					if (activeProcess === proc) {
						activeProcess = null;
					}
				});

				proc.unref();

				activeProcess = proc;
				activeVideo = videoPath;
				activeFilterChain = filterChain;

				const verb = action === "update" ? "Updated" : "Started";
				return {
					content: [{ type: "text", text: [
						`═══ LIVE PREVIEW ${verb.toUpperCase()} ═══`,
						`Video: ${videoPath}`,
						filterChain ? `Filter chain: ${filterChain}` : "Playing raw (no corrections)",
						loop ? "Looping: yes" : "Looping: no",
						"",
						"A video window should have opened.",
						'Use live_preview(action: "update", filter_chain: "...") to apply new corrections.',
						'Use live_preview(action: "stop") to close.',
					].join("\n") }],
					details: undefined,
				};
			}

			return { content: [{ type: "text", text: `Error: Unknown action: "${action}". Use "play", "frame", "update", or "stop".` }], details: undefined };
		},
	});
};

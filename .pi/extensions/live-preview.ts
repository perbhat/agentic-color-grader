import { tool, ToolResult } from "pi-ext";
import { existsSync } from "fs";
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

// ─── iTerm2 inline image support ──────────────────────────────────────────

function isItermOrKitty(): "iterm" | "kitty" | null {
	const termProgram = process.env.TERM_PROGRAM || "";
	const termInfo = process.env.TERM || "";
	if (termProgram === "iTerm.app" || process.env.ITERM_SESSION_ID) return "iterm";
	if (termProgram === "WezTerm") return "iterm"; // WezTerm supports iTerm2 protocol
	if (termInfo === "xterm-kitty" || process.env.KITTY_PID) return "kitty";
	return null;
}

async function renderInlineImage(imagePath: string): Promise<string | null> {
	const terminal = isItermOrKitty();
	if (!terminal) return null;

	try {
		const { readFile } = await import("fs/promises");
		const data = await readFile(imagePath);
		const b64 = data.toString("base64");

		if (terminal === "iterm") {
			// iTerm2 inline image protocol
			const osc = `\x1b]1337;File=inline=1;width=auto;preserveAspectRatio=1:${b64}\x07`;
			process.stdout.write(osc);
			return "iterm";
		}

		if (terminal === "kitty") {
			// Kitty image protocol (chunked for large images)
			const chunkSize = 4096;
			for (let i = 0; i < b64.length; i += chunkSize) {
				const chunk = b64.substring(i, i + chunkSize);
				const more = i + chunkSize < b64.length ? 1 : 0;
				if (i === 0) {
					process.stdout.write(`\x1b_Ga=T,f=100,m=${more};${chunk}\x1b\\`);
				} else {
					process.stdout.write(`\x1b_Gm=${more};${chunk}\x1b\\`);
				}
			}
			return "kitty";
		}
	} catch {
		return null;
	}
	return null;
}

// ─── Tool ─────────────────────────────────────────────────────────────────

export default tool({
	name: "live_preview",
	description:
		"Open a live video preview window using ffplay with the current filter chain applied. " +
		"Shows the graded video playing in real time. Can also render a preview frame inline in " +
		"iTerm2/Kitty/WezTerm terminals. Use action 'play' to open video playback, 'frame' for " +
		"a single inline terminal frame, 'update' to refresh with a new filter chain, or 'stop' to close.",
	parameters: {
		action: {
			type: "string",
			description: '"play" to open ffplay, "frame" for inline terminal image, "update" to change filter chain, "stop" to close.',
		},
		video: {
			type: "string",
			description: "Path to the video file.",
			default: "",
		},
		filter_chain: {
			type: "string",
			description: "FFmpeg filter chain to apply. If omitted, uses corrections param instead.",
			default: "",
		},
		corrections: {
			type: "object",
			description: "Correction parameters (alternative to filter_chain). Same format as apply_correction.",
			default: {},
		},
		timecode: {
			type: "string",
			description: 'Start timecode for playback or frame extraction. Default: "00:00:00".',
			default: "00:00:00",
		},
		loop: {
			type: "boolean",
			description: "Loop playback. Default: true.",
			default: true,
		},
	},
	execute: async (params): Promise<ToolResult> => {
		const action = params.action;

		// ── Stop ──
		if (action === "stop") {
			const wasRunning = killActive();
			return {
				output: wasRunning
					? "Live preview stopped."
					: "No live preview was running.",
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

		// ── Frame (inline terminal image) ──
		if (action === "frame") {
			const videoPath = resolve(params.video || activeVideo);
			if (!videoPath || !existsSync(videoPath)) {
				return { error: `Video file not found: ${params.video || activeVideo || "(none)"}` };
			}

			const tc = resolveTimecode(params.timecode ?? "00:00:01");
			const tmpDir = resolve(videoPath, "..", ".color-grader-tmp");
			const framePath = resolve(tmpDir, "live-preview-frame.png");

			// Ensure dir exists
			const { promisify } = await import("util");
			const exec = promisify(execFile);
			await exec("mkdir", ["-p", tmpDir]);

			// Extract frame
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
				return { error: `Frame extraction failed: ${err.message}` };
			}

			// Try inline display
			const displayed = await renderInlineImage(framePath);
			const termNote = displayed
				? `Frame displayed inline via ${displayed} protocol.`
				: "Terminal doesn't support inline images. Frame saved to disk.";

			return {
				output: [
					"═══ PREVIEW FRAME ═══",
					`Video: ${videoPath}`,
					`Timecode: ${tc}`,
					filterChain ? `Filter chain: ${filterChain}` : "Filter chain: (none — raw)",
					`Frame: ${framePath}`,
					termNote,
				].join("\n"),
			};
		}

		// ── Play / Update ──
		if (action === "play" || action === "update") {
			const videoPath = resolve(params.video || activeVideo);
			if (!videoPath || !existsSync(videoPath)) {
				return { error: `Video file not found: ${params.video || activeVideo || "(none)"}` };
			}

			// Kill existing playback
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

			// Check ffplay exists
			try {
				await new Promise<void>((res, rej) => {
					execFile("ffplay", ["-version"], { maxBuffer: 1024 * 1024 }, (err) => {
						if (err) rej(err);
						else res();
					});
				});
			} catch {
				return {
					error: "ffplay not found. Install ffmpeg with ffplay support (brew install ffmpeg).",
				};
			}

			// Spawn ffplay (non-blocking)
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

			// Don't let ffplay keep the process alive
			proc.unref();

			activeProcess = proc;
			activeVideo = videoPath;
			activeFilterChain = filterChain;

			const verb = action === "update" ? "Updated" : "Started";
			return {
				output: [
					`═══ LIVE PREVIEW ${verb.toUpperCase()} ═══`,
					`Video: ${videoPath}`,
					filterChain ? `Filter chain: ${filterChain}` : "Playing raw (no corrections)",
					loop ? "Looping: yes" : "Looping: no",
					"",
					"A video window should have opened.",
					'Use live_preview(action: "update", filter_chain: "...") to apply new corrections.',
					'Use live_preview(action: "stop") to close.',
				].join("\n"),
			};
		}

		return { error: `Unknown action: "${action}". Use "play", "frame", "update", or "stop".` };
	},
});

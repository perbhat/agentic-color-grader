import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, createReadStream, readdirSync, statSync, watch } from "fs";
import { readFile } from "fs/promises";
import { resolve, extname, join } from "path";
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "http";
import type { FSWatcher } from "fs";

// ─── Module-level state ───────────────────────────────────────────────────

let activeServer: Server | null = null;
let activeWatcher: FSWatcher | null = null;
let sseClients: ServerResponse[] = [];
let activeTmpDir: string = "";
let activePort: number = 0;

// ─── HTML page ────────────────────────────────────────────────────────────

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Color Grader Preview</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a1a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'SF Mono', monospace; font-size: 13px; }

  header { background: #252525; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; }
  header h1 { font-size: 16px; font-weight: 600; color: #fff; }
  .status { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

  .timeline-strip { background: #202020; padding: 12px 20px; display: flex; gap: 8px; overflow-x: auto; border-bottom: 1px solid #333; }
  .clip-thumb { min-width: 120px; padding: 8px 12px; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; cursor: pointer; text-align: center; transition: border-color 0.2s; }
  .clip-thumb:hover { border-color: #888; }
  .clip-thumb.active { border-color: #4caf50; }
  .clip-thumb .clip-id { font-weight: 600; color: #fff; margin-bottom: 4px; }
  .clip-thumb .clip-name { font-size: 11px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-top: 4px; }
  .badge-graded { background: #2e7d32; color: #c8e6c9; }
  .badge-ungraded { background: #555; color: #999; }
  .badge-ref { background: #f9a825; color: #333; }

  .main { display: flex; flex-direction: column; gap: 16px; padding: 20px; max-height: calc(100vh - 160px); overflow-y: auto; }
  .preview-row { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
  .preview-card { background: #252525; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
  .preview-card h3 { padding: 8px 12px; font-size: 12px; background: #2a2a2a; border-bottom: 1px solid #333; }
  .preview-card img { display: block; max-width: 800px; width: 100%; height: auto; }
  .preview-card .empty { padding: 60px 40px; text-align: center; color: #666; }

  .activity { background: #202020; border-top: 1px solid #333; padding: 8px 20px; position: fixed; bottom: 0; left: 0; right: 0; max-height: 120px; overflow-y: auto; }
  .activity h3 { font-size: 11px; color: #888; margin-bottom: 4px; }
  .log-entry { font-size: 11px; color: #777; padding: 2px 0; }
  .log-entry .time { color: #4caf50; margin-right: 8px; }
</style>
</head>
<body>
  <header>
    <h1>Color Grader Preview</h1>
    <div class="status"><div class="dot"></div><span id="status-text">Connected</span></div>
  </header>

  <div class="timeline-strip" id="timeline-strip">
    <div style="color:#666; padding:8px;">Loading timeline...</div>
  </div>

  <div class="main">
    <div class="preview-row">
      <div class="preview-card">
        <h3>Correction Preview</h3>
        <img id="img-preview" src="" alt="Preview" style="display:none;">
        <div id="empty-preview" class="empty">Waiting for corrections...</div>
      </div>
    </div>
    <div class="preview-row">
      <div class="preview-card">
        <h3>Before / After Comparison</h3>
        <img id="img-compare" src="" alt="Comparison" style="display:none;">
        <div id="empty-compare" class="empty">Waiting for comparison...</div>
      </div>
    </div>
    <div class="preview-row" id="scopes-row"></div>
  </div>

  <div class="activity">
    <h3>Activity</h3>
    <div id="log"></div>
  </div>

<script>
const logEl = document.getElementById('log');
const maxLogs = 20;

function addLog(msg) {
  const now = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = '<span class="time">' + now + '</span>' + msg;
  logEl.insertBefore(entry, logEl.firstChild);
  while (logEl.children.length > maxLogs) logEl.removeChild(logEl.lastChild);
}

function refreshImage(id, path) {
  const img = document.getElementById('img-' + id);
  const empty = document.getElementById('empty-' + id);
  if (img) {
    img.src = path + '?t=' + Date.now();
    img.style.display = 'block';
    if (empty) empty.style.display = 'none';
  }
}

function loadTimeline() {
  fetch('/api/timeline').then(r => r.json()).then(data => {
    const strip = document.getElementById('timeline-strip');
    if (!data.clips || data.clips.length === 0) {
      strip.innerHTML = '<div style="color:#666;padding:8px;">No clips in timeline</div>';
      return;
    }
    strip.innerHTML = '';
    data.clips.forEach(clip => {
      const div = document.createElement('div');
      div.className = 'clip-thumb';
      const graded = clip.filter_chain ? 'graded' : 'ungraded';
      const badgeClass = clip.reference ? 'badge-ref' : (clip.filter_chain ? 'badge-graded' : 'badge-ungraded');
      const badgeText = clip.reference ? 'REF' : graded;
      const name = clip.name || clip.video.split('/').pop();
      div.innerHTML = '<div class="clip-id">' + clip.id + '</div>'
        + '<div class="clip-name" title="' + name + '">' + name + '</div>'
        + '<div class="badge ' + badgeClass + '">' + badgeText + '</div>';
      strip.appendChild(div);
    });
  }).catch(() => {});
}

function loadImages() {
  fetch('/api/images').then(r => r.json()).then(files => {
    files.forEach(f => {
      if (f.name === 'correction-preview.png') refreshImage('preview', '/images/' + f.name);
      if (f.name.startsWith('compare-')) refreshImage('compare', '/images/' + f.name);
    });

    const scopeFiles = files.filter(f => f.name.startsWith('scope-'));
    const scopesRow = document.getElementById('scopes-row');
    scopesRow.innerHTML = '';
    scopeFiles.forEach(f => {
      const card = document.createElement('div');
      card.className = 'preview-card';
      const label = f.name.replace('scope-', '').replace('.png', '');
      card.innerHTML = '<h3>' + label + '</h3><img src="/images/' + f.name + '?t=' + Date.now() + '" alt="' + label + '" style="max-width:400px;">';
      scopesRow.appendChild(card);
    });
  }).catch(() => {});
}

const evtSource = new EventSource('/events');
evtSource.onmessage = function(e) {
  if (e.data === 'connected') { addLog('Connected to preview server'); return; }
  try {
    const data = JSON.parse(e.data);
    addLog('Updated: ' + data.file);

    if (data.file === 'correction-preview.png') refreshImage('preview', '/images/' + data.file);
    if (data.file && data.file.startsWith('compare-')) refreshImage('compare', '/images/' + data.file);
    if (data.file && data.file.startsWith('scope-')) loadImages();
    if (data.file === 'timeline.json') loadTimeline();
  } catch {}
};
evtSource.onerror = function() {
  document.getElementById('status-text').textContent = 'Reconnecting...';
  document.querySelector('.dot').style.background = '#ff9800';
};
evtSource.onopen = function() {
  document.getElementById('status-text').textContent = 'Connected';
  document.querySelector('.dot').style.background = '#4caf50';
};

loadTimeline();
loadImages();
</script>
</body>
</html>`;

// ─── Request handler ──────────────────────────────────────────────────────

function handleRequest(tmpDir: string, req: IncomingMessage, res: ServerResponse) {
	const url = req.url || "/";

	if (url === "/events") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"Access-Control-Allow-Origin": "*",
		});
		res.write("data: connected\n\n");
		sseClients.push(res);
		req.on("close", () => {
			sseClients = sseClients.filter((c) => c !== res);
		});
		return;
	}

	if (url === "/api/timeline") {
		const timelinePath = resolve(tmpDir, "timeline.json");
		if (existsSync(timelinePath)) {
			readFile(timelinePath, "utf-8").then((content) => {
				res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
				res.end(content);
			}).catch(() => {
				res.writeHead(500);
				res.end("{}");
			});
		} else {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ clips: [], groups: {} }));
		}
		return;
	}

	if (url === "/api/images") {
		try {
			const files = readdirSync(tmpDir)
				.filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
				.map((f) => {
					const stat = statSync(resolve(tmpDir, f));
					return { name: f, mtime: stat.mtimeMs };
				})
				.sort((a, b) => b.mtime - a.mtime);
			res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
			res.end(JSON.stringify(files));
		} catch {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("[]");
		}
		return;
	}

	if (url.startsWith("/images/")) {
		const filename = decodeURIComponent(url.replace("/images/", "").split("?")[0]);
		const filePath = resolve(tmpDir, filename);

		if (!filePath.startsWith(tmpDir) || !existsSync(filePath)) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}

		const ext = extname(filename).toLowerCase();
		const mimeTypes: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
		};
		const contentType = mimeTypes[ext] || "application/octet-stream";
		res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
		createReadStream(filePath).pipe(res);
		return;
	}

	res.writeHead(200, { "Content-Type": "text/html" });
	res.end(HTML_PAGE);
}

// ─── SSE broadcast ────────────────────────────────────────────────────────

function broadcastUpdate(file: string) {
	const data = JSON.stringify({ type: "update", file, time: Date.now() });
	for (const client of sseClients) {
		try {
			client.write(`data: ${data}\n\n`);
		} catch {
			// Client disconnected
		}
	}
}

// ─── Tool ─────────────────────────────────────────────────────────────────

const Parameters = Type.Object({
	action: Type.String({ description: '"start" to launch the server, "stop" to shut it down, "status" to check if running.' }),
	timeline_dir: Type.String({ description: "Working directory for the timeline (where .color-grader-tmp lives)." }),
	port: Type.Optional(Type.Number({ description: "Port number. Default: 3847." })),
});

export default (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "preview_server",
		label: "Preview Server",
		description:
			"Start or stop a local web preview server that shows color grading progress in real time. " +
			"Open localhost:<port> in your browser to see clip thumbnails, before/after comparisons, " +
			"and grading status. The page auto-refreshes when new preview images are generated.",
		parameters: Parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const action = params.action;

			if (action === "status") {
				if (activeServer) {
					return { content: [{ type: "text", text: `Preview server is running at http://localhost:${activePort}` }], details: undefined };
				}
				return { content: [{ type: "text", text: "Preview server is not running." }], details: undefined };
			}

			if (action === "stop") {
				if (!activeServer) {
					return { content: [{ type: "text", text: "Preview server is not running." }], details: undefined };
				}
				for (const client of sseClients) {
					try { client.end(); } catch {}
				}
				sseClients = [];
				if (activeWatcher) {
					activeWatcher.close();
					activeWatcher = null;
				}
				activeServer.close();
				activeServer = null;
				activeTmpDir = "";
				const port = activePort;
				activePort = 0;
				return { content: [{ type: "text", text: `Preview server stopped (was on port ${port}).` }], details: undefined };
			}

			if (action === "start") {
				if (activeServer) {
					return { content: [{ type: "text", text: `Preview server is already running at http://localhost:${activePort}` }], details: undefined };
				}

				const dir = resolve(params.timeline_dir);
				const tmpDir = resolve(dir, ".color-grader-tmp");
				const port = params.port ?? 3847;

				const server = createServer((req, res) => handleRequest(tmpDir, req, res));

				let watcher: FSWatcher | null = null;
				if (existsSync(tmpDir)) {
					try {
						watcher = watch(tmpDir, { recursive: false }, (eventType, filename) => {
							if (filename) {
								broadcastUpdate(filename);
							}
						});
					} catch {
						// Watcher failed, server still works
					}
				}

				return new Promise((resolvePromise) => {
					server.on("error", (err: any) => {
						if (err.code === "EADDRINUSE") {
							resolvePromise({ content: [{ type: "text", text: `Error: Port ${port} is already in use. Try a different port.` }], details: undefined });
						} else {
							resolvePromise({ content: [{ type: "text", text: `Error: Server error: ${err.message}` }], details: undefined });
						}
					});

					server.listen(port, "127.0.0.1", () => {
						activeServer = server;
						activeWatcher = watcher;
						activeTmpDir = tmpDir;
						activePort = port;

						resolvePromise({
							content: [{ type: "text", text: [
								"═══ PREVIEW SERVER STARTED ═══",
								`URL: http://localhost:${port}`,
								`Watching: ${tmpDir}`,
								"",
								"Open this URL in your browser to watch grading progress.",
								"The page auto-refreshes when preview images are updated.",
								"",
								'Use preview_server(action: "stop") to shut down.',
							].join("\n") }],
							details: undefined,
						});
					});
				});
			}

			return { content: [{ type: "text", text: `Error: Unknown action: "${action}". Use "start", "stop", or "status".` }], details: undefined };
		},
	});
};

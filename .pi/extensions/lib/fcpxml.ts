// ─── Interfaces ────────────────────────────────────────────────────────────

export interface FcpxmlAsset {
	id: string;
	src: string;
}

export interface FcpxmlClipRef {
	assetId: string;
	name: string;
	offset: number;
	duration: number;
	start: number;
}

export interface FcpxmlParseResult {
	version: string;
	projectName: string;
	assets: Map<string, FcpxmlAsset>;
	clips: FcpxmlClipRef[];
	warnings: string[];
}

// ─── Time parsing ─────────────────────────────────────────────────────────

export function parseRationalTime(rational: string): number {
	if (!rational) return 0;
	// FCPXML uses rational time: "300/1s", "150/30s", "10s", "0s"
	const stripped = rational.replace(/s$/, "");
	if (stripped.includes("/")) {
		const [num, den] = stripped.split("/").map(Number);
		if (den === 0) return 0;
		return num / den;
	}
	return parseFloat(stripped) || 0;
}

export function secondsToTimecode(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─── Path resolution ──────────────────────────────────────────────────────

export function resolveFileUrl(fileUrl: string): string {
	if (fileUrl.startsWith("file://")) {
		let path = fileUrl.replace(/^file:\/\/(localhost)?/, "");
		path = decodeURIComponent(path);
		// Normalize macOS NFD unicode to NFC
		path = path.normalize("NFC");
		return path;
	}
	return fileUrl;
}

function pathToFileUrl(filePath: string): string {
	const encoded = filePath.split("/").map((seg) => encodeURIComponent(seg)).join("/");
	return `file://${encoded}`;
}

// ─── FCPXML Parsing ───────────────────────────────────────────────────────

function extractAttribute(tag: string, attr: string): string {
	const pattern = new RegExp(`${attr}="([^"]*)"`, "i");
	const match = tag.match(pattern);
	return match ? match[1] : "";
}

export function parseFcpxml(xmlContent: string): FcpxmlParseResult {
	const warnings: string[] = [];

	// Extract version
	const versionMatch = xmlContent.match(/<fcpxml[^>]*version="([^"]+)"/);
	const version = versionMatch ? versionMatch[1] : "unknown";

	// Extract project name
	const projectMatch = xmlContent.match(/<project[^>]*name="([^"]+)"/);
	const projectName = projectMatch ? projectMatch[1] : "Untitled";

	// Extract assets
	const assets = new Map<string, FcpxmlAsset>();

	// Match <asset ...> tags (self-closing or with body)
	const assetPattern = /<asset\s[^>]*?id="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/asset>)/g;
	let assetMatch: RegExpExecArray | null;
	while ((assetMatch = assetPattern.exec(xmlContent)) !== null) {
		const fullTag = assetMatch[0];
		const id = assetMatch[1];
		let src = extractAttribute(fullTag, "src");

		// Fallback: check for <media-rep> child with src
		if (!src) {
			const mediaRepMatch = fullTag.match(/<media-rep[^>]*src="([^"]*)"/);
			if (mediaRepMatch) {
				src = mediaRepMatch[1];
			}
		}

		if (src) {
			assets.set(id, { id, src: resolveFileUrl(src) });
		}
	}

	// Extract clips from <spine> elements
	const clips: FcpxmlClipRef[] = [];

	// Find all <spine> blocks
	const spinePattern = /<spine[^>]*>([\s\S]*?)<\/spine>/g;
	let spineMatch: RegExpExecArray | null;
	while ((spineMatch = spinePattern.exec(xmlContent)) !== null) {
		const spineContent = spineMatch[1];

		// Match <asset-clip> and <clip> tags inside spine
		const clipPattern = /<(?:asset-clip|clip)\s[^>]*?(?:\/>|>[\s\S]*?<\/(?:asset-clip|clip)>)/g;
		let clipMatch: RegExpExecArray | null;
		while ((clipMatch = clipPattern.exec(spineContent)) !== null) {
			const tag = clipMatch[0];
			const ref = extractAttribute(tag, "ref");
			const name = extractAttribute(tag, "name");
			const offset = extractAttribute(tag, "offset");
			const duration = extractAttribute(tag, "duration");
			const start = extractAttribute(tag, "start");

			if (!ref) {
				warnings.push(`Skipping clip without ref attribute: ${tag.substring(0, 80)}`);
				continue;
			}

			clips.push({
				assetId: ref,
				name: name || "",
				offset: parseRationalTime(offset),
				duration: parseRationalTime(duration),
				start: parseRationalTime(start),
			});
		}

		// Warn about compound/multicam clips
		const compoundPattern = /<(?:mc-clip|compound-clip|ref-clip)\s/g;
		if (compoundPattern.test(spineContent)) {
			warnings.push("Timeline contains compound/multicam clips which are not fully supported. They will be skipped.");
		}
	}

	return { version, projectName, assets, clips, warnings };
}

// ─── FCPXML Generation ────────────────────────────────────────────────────

export function generateFcpxml(options: {
	projectName: string;
	clips: Array<{
		filePath: string;
		durationSeconds: number;
		name: string;
	}>;
}): string {
	const { projectName, clips } = options;

	// Build resources
	const resources: string[] = [];
	resources.push(`    <format id="r0" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080"/>`);

	let timelineOffset = 0;

	const assetEntries: string[] = [];
	const spineEntries: string[] = [];

	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i];
		const assetId = `r${i + 1}`;
		const fileUrl = pathToFileUrl(clip.filePath);
		const durationRational = `${Math.round(clip.durationSeconds * 30000)}/30000s`;
		const offsetRational = `${Math.round(timelineOffset * 30000)}/30000s`;

		assetEntries.push(
			`    <asset id="${assetId}" src="${fileUrl}" start="0s" duration="${durationRational}" hasVideo="1" hasAudio="1" format="r0"/>`,
		);

		const clipName = clip.name || `Clip ${i + 1}`;
		spineEntries.push(
			`            <asset-clip ref="${assetId}" offset="${offsetRational}" name="${escapeXml(clipName)}" duration="${durationRational}" format="r0"/>`,
		);

		timelineOffset += clip.durationSeconds;
	}

	const totalDuration = `${Math.round(timelineOffset * 30000)}/30000s`;

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
${resources.join("\n")}
${assetEntries.join("\n")}
  </resources>
  <library>
    <event name="${escapeXml(projectName)}">
      <project name="${escapeXml(projectName)}">
        <sequence format="r0" duration="${totalDuration}" tcStart="0s" tcFormat="NDF">
          <spine>
${spineEntries.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

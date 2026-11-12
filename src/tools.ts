// The agent's tools (tvctl and web search) as Realtime function tools. tvctl runs with argv, never a
// shell; results are condensed to a few short lines for the voice model.
import { execFile } from "node:child_process";
import { log } from "./log.ts";
import { webSearch } from "./web.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type TvctlRun = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export function execTvctl(binary: string): TvctlRun {
	return (args) =>
		new Promise((resolve) => {
			execFile(binary, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				resolve({ ok: error === null, stdout, stderr: stderr || (error?.message ?? "") });
			});
		});
}

function clock(seconds: unknown): string | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function obj_(value: Json | undefined): Record<string, Json> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function brief(value: Json | undefined): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

/** One short line describing tvctl's JSON output. */
export function condense(output: string): string {
	let data: Json;
	try {
		data = JSON.parse(output) as Json;
	} catch {
		return output.trim().slice(0, 400);
	}
	const top = obj_(data);
	if (top === undefined) return brief(data).slice(0, 400);
	const parts: string[] = [];
	const player = obj_(top.player);
	if (player !== undefined) {
		const title = typeof player.title === "string" ? `"${player.title}"` : "";
		const by = typeof player.author === "string" ? ` by ${player.author}` : "";
		parts.push(`${brief(top.service) || "player"}: ${title}${by}`.trim());
		const episode = obj_(player.episode);
		if (episode !== undefined) parts.push(`episode ${brief(episode.season ?? "")}-${brief(episode.number ?? "")} ${brief(episode.title ?? "")}`.trim());
		const at = clock(player.current_time);
		const total = clock(player.duration);
		if (player.state !== undefined) parts.push(`${brief(player.state)}${at ? ` ${at}${total ? `/${total}` : ""}` : ""}`);
		if (player.volume !== undefined) parts.push(`volume ${brief(player.volume)}${player.muted === true ? " (muted)" : ""}`);
		const subtitles = obj_(player.subtitles);
		parts.push(`subtitles ${subtitles ? brief(subtitles.language ?? subtitles.id ?? subtitles.name ?? "on") : "off"}`);
		if (player.playback_rate !== undefined && player.playback_rate !== 1) parts.push(`speed ${brief(player.playback_rate)}`);
		if (player.ad_showing === true) parts.push(`ad showing${player.ad_remaining !== undefined ? ` (${brief(player.ad_remaining)} s left)` : ""}`);
		const next = obj_(player.next_episode);
		if (next !== undefined) parts.push(`next: ${brief(next.title ?? next)}`);
		if (player.warning !== undefined) parts.push(`warning: ${brief(player.warning)}`);
		if (player.pending !== undefined) parts.push(`pending: ${brief(player.pending)}`);
	}
	const window = obj_(top.window);
	if (window !== undefined && window.fullscreen === true) parts.push("fullscreen");
	if (top.warning !== undefined) parts.push(`warning: ${brief(top.warning)}`);
	if (top.pending !== undefined) parts.push(`pending: ${brief(top.pending)}`);
	if (parts.length === 0) return brief(top).slice(0, 400);
	return parts.join("; ").slice(0, 480);
}

/** Search results as one line each: kind, title, details, url. */
export function condenseSearch(output: string): string {
	const data = JSON.parse(output) as { results?: Record<string, Json>[] };
	const results = data.results ?? [];
	if (results.length === 0) return "no results";
	return results
		.map((r, i) => {
			const details = [r.by, r.channel, r.duration, r.published, r.live === true ? "LIVE now" : undefined]
				.filter((v) => typeof v === "string" && v !== "")
				.join(", ");
			return `${i + 1}. [${brief(r.kind)}] ${brief(r.title)}${details ? ` (${details})` : ""} ${brief(r.url)}`;
		})
		.join("\n");
}

/** Runs tvctl; starts the server and retries once when it is not running. */
async function call(run: TvctlRun, args: string[], format: (stdout: string) => string = condense): Promise<string> {
	const started = performance.now();
	let result = await run(args);
	if (!result.ok && /server is not running/.test(result.stderr)) {
		await run(["server", "up"]);
		result = await run(args);
	}
	log("tvctl", `${args.join(" ")} -> ${result.ok ? "ok" : "error"} ${(performance.now() - started).toFixed(0)} ms`);
	if (!result.ok) throw new Error(result.stderr.replace(/^error:\s*/, "").trim().slice(0, 400));
	return format(result.stdout);
}

type Schema = Record<string, unknown>;
type Args = Record<string, unknown>;

/** A Realtime function tool and its implementation. */
export type Tool = {
	name: string;
	description: string;
	parameters: Schema;
	run: (args: Args) => Promise<string>;
};

const string = (description?: string): Schema => (description ? { type: "string", description } : { type: "string" });
const choice = (values: (string | boolean)[], description?: string): Schema =>
	typeof values[0] === "boolean" ? { type: "boolean", ...(description ? { description } : {}) } : { type: "string", enum: values, ...(description ? { description } : {}) };
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});
const s = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export function createTools(run: TvctlRun, webModel: string): Tool[] {
	const tvctl = (args: string[]) => call(run, args);
	return [
		{
			name: "search_media",
			description:
				"Search a service for something to play; returns titles with URLs for play. Spotify kind: track, album, artist, playlist, episode or show (omit for a mix; artist plays their top songs). primevideo searches amazon.com; jp_store=true searches amazon.co.jp (Japanese account). A Netflix or Prime title URL plays like its Play button (a series continues its current episode).",
			parameters: object(
				{
					service: choice(["youtube", "spotify", "netflix", "primevideo", "crunchyroll"]),
					query: string(),
					kind: choice(["track", "album", "artist", "playlist", "episode", "show"]),
					jp_store: choice([true, false]),
				},
				["service", "query"],
			),
			run: (a) => {
				const argv = ["search", String(a.service), String(a.query), "--limit", "5"];
				if (s(a.kind) && a.service === "spotify") argv.push("--kind", String(a.kind));
				if (a.jp_store === true && a.service === "primevideo") argv.push("--site", "jp");
				return call(run, argv, condenseSearch);
			},
		},
		{
			name: "play",
			description: "Open a URL in the player (fullscreen by default) and start it. Use only URLs from search results or the user, never invented ones.",
			parameters: object(
				{
					url: string(),
					start: string("Start position, e.g. 90 or 1:30"),
					subtitles: string("Subtitle language, e.g. ja"),
					windowed: choice([true, false]),
				},
				["url"],
			),
			run: (a) => {
				const argv = ["open", String(a.url)];
				if (s(a.start)) argv.push("--start", String(a.start));
				if (s(a.subtitles)) argv.push("--subtitles", String(a.subtitles));
				if (a.windowed === true) argv.push("--windowed");
				return tvctl(argv);
			},
		},
		{
			name: "playback",
			description: "Play, pause, toggle, next/previous item or episode, or close the player.",
			parameters: object({ action: choice(["play", "pause", "toggle", "next", "prev", "close"]) }, ["action"]),
			run: (a) => tvctl([String(a.action)]),
		},
		{
			name: "seek",
			description: "Seek. Absolute: '1:30' or '90'. Relative: '+30' (forward) or '-10' (back), in seconds; '+5m' also works.",
			parameters: object({ position: string() }, ["position"]),
			run: (a) => {
				const p = String(a.position).trim();
				if (p.startsWith("+")) return tvctl(["forward", p.slice(1)]);
				if (p.startsWith("-")) return tvctl(["back", p.slice(1)]);
				return tvctl(["seek", p]);
			},
		},
		{
			name: "volume",
			description: "Set the player volume (0-100), or mute / unmute.",
			parameters: object({ level: { type: "number" }, mute: choice(["mute", "unmute"]) }),
			run: async (a) => {
				if (s(a.mute)) return tvctl([String(a.mute)]);
				if (typeof a.level !== "number") throw new Error("give level or mute");
				return tvctl(["volume", String(Math.round(Math.min(100, Math.max(0, a.level))))]);
			},
		},
		{
			name: "subtitles",
			description: "Subtitles: a language code ('ja', 'en'; auto-translated if missing), 'on', 'off', or 'list'.",
			parameters: object({ value: string() }, ["value"]),
			run: (a) => tvctl(["subtitles", String(a.value)]),
		},
		{
			name: "audio_track",
			description: "Audio track (dubbing) by language code, or 'list'.",
			parameters: object({ value: string() }, ["value"]),
			run: (a) => tvctl(["audio", String(a.value)]),
		},
		{
			name: "speed",
			description: "Playback speed, e.g. 1, 1.25, 1.5.",
			parameters: object({ rate: { type: "number" } }, ["rate"]),
			run: (a) => tvctl(["speed", String(a.rate)]),
		},
		{
			name: "quality",
			description: "Video quality; values are in status (available qualities), e.g. hd1080.",
			parameters: object({ value: string() }, ["value"]),
			run: (a) => tvctl(["quality", String(a.value)]),
		},
		{
			name: "window",
			description:
				"Move or resize the player window. layout: left, right, top, bottom, top-left, top-right, bottom-left, bottom-right, center, maximize. size: e.g. 1280x720.",
			parameters: object({
				layout: choice(["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right", "center", "maximize"]),
				size: string(),
			}),
			run: (a) => {
				const argv = ["window"];
				if (s(a.layout)) argv.push("--layout", String(a.layout));
				if (s(a.size)) argv.push("--size", String(a.size));
				return tvctl(argv);
			},
		},
		{
			name: "fullscreen",
			description: "Fullscreen on, off, or toggle.",
			parameters: object({ mode: choice(["on", "off", "toggle"]) }, ["mode"]),
			run: (a) => tvctl(a.mode === "toggle" ? ["fullscreen"] : ["fullscreen", String(a.mode)]),
		},
		{
			name: "status",
			description: "What is playing now: service, title, state, position, volume, subtitles.",
			parameters: object({}),
			run: () => tvctl(["status"]),
		},
		{
			name: "web_search",
			description:
				"Search the web: facts, news, schedules, or which title/song/channel the user means before search_media. Not for finding playable URLs (use search_media).",
			parameters: object({ query: string() }, ["query"]),
			run: (a) => webSearch(String(a.query), webModel),
		},
	];
}

/** Runs a tool call; errors become the tool's output so the model can say what went wrong. */
export async function runTool(tools: Tool[], name: string, argsJson: string): Promise<string> {
	const tool = tools.find((t) => t.name === name);
	if (tool === undefined) return `error: unknown tool ${name}`;
	try {
		const args = (argsJson ? JSON.parse(argsJson) : {}) as Args;
		return await tool.run(args);
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

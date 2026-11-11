// tvctl as typed tools. Commands run with argv (never a shell); results are condensed to a short line,
// so each tool result fits one OptChat node without a summarizing call.
import { execFile } from "node:child_process";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { log } from "./log.ts";

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

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

export function createTvctlExtension(run: TvctlRun) {
	const tvctl = async (args: string[]) => text(await call(run, args));
	const tools = [
		defineTool({
			name: "search_media",
			description:
				"Search YouTube or Spotify for something to play; returns titles with URLs for play. Spotify kind: track, album, artist, playlist, episode or show (omit for a mix; artist plays their top songs).",
			parameters: obj({
				service: oneOf(["youtube", "spotify"]),
				query: str(),
				kind: opt(oneOf(["track", "album", "artist", "playlist", "episode", "show"])),
			}),
			execute: async (args) => {
				const argv = ["search", args.service, args.query, "--limit", "6"];
				if (args.kind && args.service === "spotify") argv.push("--kind", args.kind);
				return text(await call(run, argv, condenseSearch));
			},
		}),
		defineTool({
			name: "play",
			description:
				"Open a URL in the player (fullscreen by default) and start it. Use only URLs from search results or the user, never invented ones.",
			parameters: obj({
				url: str(),
				start: opt(str({ description: "Start position, e.g. 90 or 1:30" })),
				subtitles: opt(str({ description: "Subtitle language, e.g. ja" })),
				windowed: opt(oneOf([true, false])),
			}),
			execute: (args) => {
				const argv = ["open", args.url];
				if (args.start) argv.push("--start", args.start);
				if (args.subtitles) argv.push("--subtitles", args.subtitles);
				if (args.windowed === true) argv.push("--windowed");
				return tvctl(argv);
			},
		}),
		defineTool({
			name: "playback",
			description: "Play, pause, toggle, next/previous item or episode, or close the player.",
			parameters: obj({ action: oneOf(["play", "pause", "toggle", "next", "prev", "close"]) }),
			execute: (args) => tvctl([args.action]),
		}),
		defineTool({
			name: "seek",
			description: "Seek. Absolute: '1:30' or '90'. Relative: '+30' (forward) or '-10' (back), in seconds; '+5m' also works.",
			parameters: obj({ position: str() }),
			execute: (args) => {
				const p = args.position.trim();
				if (p.startsWith("+")) return tvctl(["forward", p.slice(1)]);
				if (p.startsWith("-")) return tvctl(["back", p.slice(1)]);
				return tvctl(["seek", p]);
			},
		}),
		defineTool({
			name: "volume",
			description: "Set the player volume (0-100), or mute / unmute.",
			parameters: obj({ level: opt(num()), mute: opt(oneOf(["mute", "unmute"])) }),
			execute: async (args) => {
				if (args.mute !== undefined) return tvctl([args.mute]);
				if (args.level === undefined) throw new Error("give level or mute");
				return tvctl(["volume", String(Math.round(Math.min(100, Math.max(0, args.level))))]);
			},
		}),
		defineTool({
			name: "subtitles",
			description: "Subtitles: a language code ('ja', 'en'; auto-translated if missing), 'on', 'off', or 'list'.",
			parameters: obj({ value: str() }),
			execute: (args) => tvctl(["subtitles", args.value]),
		}),
		defineTool({
			name: "audio_track",
			description: "Audio track (dubbing) by language code, or 'list'.",
			parameters: obj({ value: str() }),
			execute: (args) => tvctl(["audio", args.value]),
		}),
		defineTool({
			name: "speed",
			description: "Playback speed, e.g. 1, 1.25, 1.5.",
			parameters: obj({ rate: num() }),
			execute: (args) => tvctl(["speed", String(args.rate)]),
		}),
		defineTool({
			name: "quality",
			description: "Video quality; values are in status (available qualities), e.g. hd1080.",
			parameters: obj({ value: str() }),
			execute: (args) => tvctl(["quality", args.value]),
		}),
		defineTool({
			name: "window",
			description:
				"Move or resize the player window. layout: left, right, top, bottom, top-left, top-right, bottom-left, bottom-right, center, maximize. size: e.g. 1280x720.",
			parameters: obj({
				layout: opt(oneOf(["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right", "center", "maximize"])),
				size: opt(str()),
			}),
			execute: (args) => {
				const argv = ["window"];
				if (args.layout) argv.push("--layout", args.layout);
				if (args.size) argv.push("--size", args.size);
				return tvctl(argv);
			},
		}),
		defineTool({
			name: "fullscreen",
			description: "Fullscreen on, off, or toggle.",
			parameters: obj({ mode: oneOf(["on", "off", "toggle"]) }),
			execute: (args) => tvctl(args.mode === "toggle" ? ["fullscreen"] : ["fullscreen", args.mode]),
		}),
		defineTool({
			name: "status",
			description: "What is playing now: service, title, state, position, volume, subtitles.",
			parameters: obj({}),
			execute: () => tvctl(["status"]),
		}),
	];
	return defineExtension({ name: "tvctl", tools });
}

// Measures how fast candidate models pick the right tool for typical voice commands.
// Usage: node scripts/bench-models.ts [provider/model[:reasoning] ...]
// OPENAI_API_KEY is used for `openai`; OAuth providers read ~/.pi/agent/auth.json read-only
// (a token that needs a refresh fails instead of rotating pi's refresh token).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Credential, CredentialStore, Tool } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { num, obj, opt, str, oneOf } from "@earendil-works/pi-schema";

const authPath = join(homedir(), ".pi/agent/auth.json");
const readOnlyPiCredentials: CredentialStore = {
	async read(providerId) {
		const all = JSON.parse(await readFile(authPath, "utf8")) as Record<string, Credential>;
		return all[providerId];
	},
	async list() {
		const all = JSON.parse(await readFile(authPath, "utf8")) as Record<string, Credential>;
		return Object.entries(all).map(([providerId, c]) => ({ providerId, type: c.type }));
	},
	async modify(providerId) {
		throw new Error(`read-only credentials: ${providerId} needs a refresh; run pi once to refresh it`);
	},
	async delete() {
		throw new Error("read-only credentials");
	},
};

const tools: Tool[] = [
	{
		name: "playback",
		description: "Control the player: play, pause, toggle, next, prev or close.",
		parameters: obj({ action: oneOf(["play", "pause", "toggle", "next", "prev", "close"]) }),
	},
	{
		name: "seek",
		description: "Seek. position: absolute like '1:30' or '90', relative like '+30' or '-10' (seconds).",
		parameters: obj({ position: str() }),
	},
	{
		name: "volume",
		description: "Set the player volume 0-100, or mute/unmute.",
		parameters: obj({ level: opt(num()), mute: opt(oneOf(["mute", "unmute"])) }),
	},
	{
		name: "subtitles",
		description: "Subtitles: a language code like 'ja' or 'en', or 'on' / 'off'.",
		parameters: obj({ value: str() }),
	},
	{
		name: "search_media",
		description: "Search a service for titles, artists or videos. Returns results with URLs to pass to play.",
		parameters: obj({
			service: oneOf(["youtube", "spotify", "netflix", "primevideo", "crunchyroll"]),
			query: str(),
		}),
	},
	{
		name: "play",
		description: "Open a URL from search_media results in the player.",
		parameters: obj({ url: str() }),
	},
];

const systemPrompt = [
	"You are a TV remote agent. The user speaks Japanese through a microphone; transcripts may contain recognition errors.",
	"Act immediately with the tools. Never guess URLs: search first, then play a result URL.",
	"Reply in Japanese, one short sentence, only after acting.",
].join("\n");

const cases: { say: string; expect: (name: string, args: Record<string, unknown>) => boolean }[] = [
	{ say: "一時停止して", expect: (n, a) => n === "playback" && a.action === "pause" },
	{ say: "30秒戻して", expect: (n, a) => n === "seek" && String(a.position).replace(/\s/g, "") === "-30" },
	{ say: "宇多田ヒカルを Spotifyで再生して。", expect: (n, a) => n === "search_media" && a.service === "spotify" && /宇多田/.test(String(a.query)) },
	{ say: "音量を半分にして", expect: (n, a) => n === "volume" && a.level === 50 },
	{ say: "字幕を日本語にして", expect: (n, a) => n === "subtitles" && a.value === "ja" },
];

const defaults = [
	"openai/gpt-6-luna:minimal",
	"openai/gpt-5.4-nano:minimal",
	"anthropic/claude-haiku-5-5",
	"openai-codex/gpt-6-luna:minimal",
];

const models = builtinModels({ credentials: readOnlyPiCredentials });
const specs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaults;
const rounds = Number(process.env.ROUNDS ?? 2);

for (const spec of specs) {
	const [ref, reasoning] = spec.split(":");
	const slash = ref.indexOf("/");
	const model = models.getModel(ref.slice(0, slash), ref.slice(slash + 1));
	if (model === undefined) {
		console.log(`${spec}: unknown model`);
		continue;
	}
	const times: number[] = [];
	let correct = 0;
	let total = 0;
	let errors = 0;
	for (let round = 0; round < rounds; round++) {
		for (const c of cases) {
			const context: Context = {
				systemPrompt,
				messages: [{ role: "user", content: c.say, timestamp: Date.now() }],
				tools,
			};
			const started = performance.now();
			let firstTool: number | undefined;
			let call: { name: string; arguments: Record<string, unknown> } | undefined;
			try {
				const stream = models.streamSimple(model, context, reasoning ? { reasoning: reasoning as "minimal" } : {});
				for await (const event of stream) {
					if (event.type === "toolcall_end" && call === undefined) {
						firstTool = performance.now() - started;
						call = { name: event.toolCall.name, arguments: event.toolCall.arguments };
					}
					if (event.type === "error") throw new Error(event.error.errorMessage);
				}
			} catch (error) {
				errors++;
				console.log(`  ${spec} "${c.say}": error ${(error as Error).message.slice(0, 200)}`);
				continue;
			}
			total++;
			const ok = call !== undefined && c.expect(call.name, call.arguments);
			if (ok) correct++;
			if (firstTool !== undefined) times.push(firstTool);
			console.log(
				`  ${spec} r${round} "${c.say}": ${firstTool?.toFixed(0) ?? "-"} ms ${call ? `${call.name}(${JSON.stringify(call.arguments)})` : "no tool"} ${ok ? "ok" : "WRONG"}`,
			);
		}
	}
	times.sort((a, b) => a - b);
	const median = times.length ? times[Math.floor(times.length / 2)] : NaN;
	console.log(`${spec}: median ${median.toFixed(0)} ms to tool call, ${correct}/${total} correct, ${errors} errors`);
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export type Config = {
	/** The OpenAI Realtime conversation (OPENAI_API_KEY). */
	realtime: {
		model: string;
		/** alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar */
		voice: string;
		/** semantic_vad eagerness: low (lets you pause), medium, high, auto. */
		eagerness: string;
		/** near_field (headset, lavalier), far_field (laptop or room mic), or off. */
		noiseReduction: string;
		/** Transcribes what you say, for the log and memory. */
		transcribeModel: string;
		language: string;
	};
	audio: {
		/** Cancel the agent's own voice from the microphone (lets you talk over it). */
		echoCancellation: boolean;
		/** Log the microphone level every 500 ms (per channel). */
		levels: boolean;
	};
	speech: {
		/** `tvctl duck` level (percent) for the player while the agent speaks; absent: leave duck alone. */
		duckLevel?: number;
	};
	/** OpenAI model for the web_search tool (Responses API web search). */
	webSearchModel: string;
	memory: {
		/** How much of the recent conversation (characters) each new session starts with. */
		recentChars: number;
	};
	paths: {
		/** The conversation log (JSON lines), the agent's memory across sessions. */
		memory: string;
		tvctl: string;
		voice: string;
	};
	/** Your own instructions, added to the session instructions. */
	instructions?: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const defaultConfigPath = join(homedir(), ".config/tvctl-agent/config.toml");

function expand(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

type Table = Record<string, unknown>;

function table(value: unknown, name: string): Table {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`config: [${name}] must be a table`);
	return value as Table;
}

function get<T>(t: Table, key: string, type: "string" | "number" | "boolean", fallback: T): T {
	const value = t[key];
	if (value === undefined) return fallback;
	if (typeof value !== type) throw new Error(`config: ${key} must be a ${type}`);
	return value as T;
}

/** Unknown keys (including those of older versions) are ignored. */
export function parseConfig(text: string): Config {
	const root = parse(text) as Table;
	const realtime = table(root.realtime, "realtime");
	const speech = table(root.speech, "speech");
	const audio = table(root.audio, "audio");
	const memory = table(root.memory, "memory");
	const paths = table(root.paths, "paths");
	const eagerness = get(realtime, "eagerness", "string", "auto");
	if (!["low", "medium", "high", "auto"].includes(eagerness)) throw new Error(`config: unknown eagerness ${eagerness}`);
	const noiseReduction = get(realtime, "noise_reduction", "string", "near_field");
	if (!["near_field", "far_field", "off"].includes(noiseReduction)) throw new Error(`config: unknown noise_reduction ${noiseReduction}`);
	return {
		realtime: {
			model: get(realtime, "model", "string", "gpt-realtime-2.1"),
			voice: get(realtime, "voice", "string", "marin"),
			eagerness,
			noiseReduction,
			transcribeModel: get(realtime, "transcribe_model", "string", "gpt-4o-mini-transcribe"),
			language: get(realtime, "language", "string", "ja"),
		},
		audio: {
			echoCancellation: get(audio, "echo_cancellation", "boolean", true),
			levels: get(audio, "levels", "boolean", false),
		},
		speech: {
			duckLevel: get<number | undefined>(speech, "duck_level", "number", 10),
		},
		webSearchModel: get(table(root.model, "model"), "web_search", "string", "gpt-5.4-mini"),
		memory: {
			recentChars: get(memory, "recent_chars", "number", 6000),
		},
		paths: {
			memory: expand(get(paths, "memory", "string", "~/Library/Application Support/tvctl-agent/conversation.jsonl")),
			tvctl: expand(get(paths, "tvctl", "string", "tvctl")),
			voice: expand(get(paths, "voice", "string", join(repoRoot, "voice/.build/release/tvctl-voice"))),
		},
		instructions: get<string | undefined>(root, "instructions", "string", undefined),
	};
}

export async function loadConfig(path: string): Promise<Config> {
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return parseConfig(text);
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export type Config = {
	audio: {
		/** Input device name or UID; absent: the system default input. */
		device?: string;
		/** Test only: read this audio file in real time instead of a device. */
		file?: string;
		locale: string;
		/** Silence after speech that ends an utterance. */
		endSilenceMs: number;
		/** Fixed speech threshold (dBFS); absent: adaptive, `marginDb` above the noise floor. */
		thresholdDb?: number;
		marginDb: number;
		/** Recognizer: openai (Apple's transcript as a second opinion), or apple only. */
		engine: "openai" | "apple";
		openaiModel: string;
		/** gpt-live-transcribe delay: minimal, low, medium, high, xhigh (more delay, more accuracy). */
		openaiDelay: string;
	};
	speech: {
		/** Speak the agent's answers. */
		enabled: boolean;
		/** AVSpeechSynthesisVoice identifier (`tvctl-voice voices`); absent: the locale's default voice. */
		voice?: string;
		/** 0.0-1.0; absent: the system default. */
		rate?: number;
		/** `tvctl duck` level (percent) for the player while the agent speaks; absent: leave duck alone. */
		duckLevel?: number;
		/** openai: a realtime voice model reads the answer; system: macOS speech synthesis. */
		engine: "openai" | "system";
		openaiModel: string;
		openaiVoice: string;
	};
	model: {
		/** provider/modelId */
		main: string;
		thinking: "off" | "minimal" | "low" | "medium" | "high";
		/** Model for OptChat compactions. */
		compactor: string;
		compactorThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
		/** OpenAI model for web_search (Responses API web search). */
		webSearch: string;
	};
	paths: {
		storage: string;
		tvctl: string;
		voice: string;
		/** pi's credential file, shared with its file lock (OAuth tokens are refreshed in place). */
		piAuth: string;
	};
	/** OptChat memory (the OptChat spec, https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449); sizes in bytes. */
	memory: {
		enabled: boolean;
		viewMax: number;
		viewMin: number;
		cviewMax: number;
		cviewMin: number;
		/** Longest wait for the last messages' summaries before a turn. */
		waitMs: number;
	};
	/** Your own instructions, appended to the system prompt. */
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

export function parseConfig(text: string): Config {
	const root = parse(text) as Table;
	const audio = table(root.audio, "audio");
	const speech = table(root.speech, "speech");
	const model = table(root.model, "model");
	const paths = table(root.paths, "paths");
	const memory = table(root.memory, "memory");
	const compactorThinking = get(model, "compactor_thinking", "string", "low");
	if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(compactorThinking)) {
		throw new Error(`config: unknown thinking level ${compactorThinking}`);
	}
	const audioEngine = get(audio, "engine", "string", "openai");
	if (!["openai", "apple"].includes(audioEngine)) throw new Error(`config: audio.engine must be openai or apple`);
	const speechEngine = get(speech, "engine", "string", "openai");
	if (!["openai", "system"].includes(speechEngine)) throw new Error(`config: speech.engine must be openai or system`);
	const thinking = get(model, "thinking", "string", "off");
	if (!["off", "minimal", "low", "medium", "high"].includes(thinking)) throw new Error(`config: unknown thinking level ${thinking}`);
	return {
		audio: {
			device: get<string | undefined>(audio, "device", "string", undefined),
			file: get<string | undefined>(audio, "file", "string", undefined),
			locale: get(audio, "locale", "string", "ja-JP"),
			endSilenceMs: get(audio, "end_silence_ms", "number", 350),
			thresholdDb: get<number | undefined>(audio, "threshold_db", "number", undefined),
			marginDb: get(audio, "margin_db", "number", 15),
			engine: audioEngine as Config["audio"]["engine"],
			openaiModel: get(audio, "openai_model", "string", "gpt-live-transcribe"),
			openaiDelay: get(audio, "openai_delay", "string", "medium"),
		},
		speech: {
			enabled: get(speech, "enabled", "boolean", true),
			voice: get<string | undefined>(speech, "voice", "string", undefined),
			rate: get<number | undefined>(speech, "rate", "number", undefined),
			duckLevel: get<number | undefined>(speech, "duck_level", "number", 20),
			engine: speechEngine as Config["speech"]["engine"],
			openaiModel: get(speech, "openai_model", "string", "gpt-realtime-2.1-mini"),
			openaiVoice: get(speech, "openai_voice", "string", "marin"),
		},
		model: {
			main: get(model, "main", "string", "anthropic/claude-haiku-5-5"),
			thinking: thinking as Config["model"]["thinking"],
			compactor: get(model, "compactor", "string", "anthropic/claude-haiku-5-5"),
			compactorThinking: compactorThinking as Config["model"]["compactorThinking"],
			webSearch: get(model, "web_search", "string", "gpt-5.4-mini"),
		},
		paths: {
			storage: expand(get(paths, "storage", "string", "~/Library/Application Support/tvctl-agent/agent.sqlite")),
			tvctl: expand(get(paths, "tvctl", "string", "tvctl")),
			voice: expand(get(paths, "voice", "string", join(repoRoot, "voice/.build/release/tvctl-voice"))),
			piAuth: expand(get(paths, "pi_auth", "string", "~/.pi/agent/auth.json")),
		},
		memory: {
			enabled: get(memory, "enabled", "boolean", true),
			viewMax: get(memory, "view_max", "number", 128_000),
			viewMin: get(memory, "view_min", "number", 64_000),
			cviewMax: get(memory, "compaction_view_max", "number", 32_000),
			cviewMin: get(memory, "compaction_view_min", "number", 16_000),
			waitMs: get(memory, "wait_ms", "number", 10_000),
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

export function splitModelRef(ref: string): { provider: string; modelId: string } {
	const slash = ref.indexOf("/");
	if (slash <= 0) throw new Error(`model must be provider/modelId: ${ref}`);
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

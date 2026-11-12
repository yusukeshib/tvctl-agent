// Runs the tvctl-voice helper: it detects utterances and streams their audio, which OpenAI transcribes;
// answers are spoken by an OpenAI realtime voice and played by the helper.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { CloudSpeaker, Transcriber } from "./openai-voice.ts";

export type VoiceEvent = { type: string; t: number; [key: string]: unknown };

export type Utterance = {
	text: string;
	/** Helper clock (ms) at speech_start and speech_end. */
	startedAt: number;
	endedAt: number;
};

/** Transcripts a cloud recognizer reports for noise or silence. */
const HALLUCINATIONS = [/^ご視聴ありがとうございました[。.]?$/, /^(はい|うん|あ)[。.]?$/];

export function isSpeech(text: string): boolean {
	const t = text.trim();
	return t !== "" && !HALLUCINATIONS.some((h) => h.test(t));
}

export class Voice {
	private child: ChildProcess | undefined;
	private stopped = false;
	private nextId = 0;
	private startedAt = 0;
	private readonly spoken = new Map<string, () => void>();
	private readonly transcriber: Transcriber;
	private readonly speaker: CloudSpeaker;
	private readonly config: Config;
	private readonly onUtterance: (utterance: Utterance) => void;

	constructor(config: Config, onUtterance: (utterance: Utterance) => void) {
		this.config = config;
		this.onUtterance = onUtterance;
		this.transcriber = new Transcriber({
			model: config.audio.model,
			language: config.audio.language,
			delay: config.audio.delay,
			prompt:
				"Spoken commands to a TV remote, mostly Japanese: play, pause, volume, seek, subtitles; titles, artists and channels on YouTube, Spotify, Netflix, Prime Video and Crunchyroll.",
			keywords: ["YouTube", "Spotify", "Netflix", "Prime Video", "Crunchyroll", "ネトフリ", "プライムビデオ", "クランチロール"],
		});
		this.speaker = new CloudSpeaker({
			model: config.speech.model,
			voice: config.speech.voice,
			instructions:
				"You are a text-to-speech voice. Read the user's text aloud exactly as written, in its language, naturally, warmly and briskly. Never add, drop, answer or change words.",
		});
	}

	start(): void {
		const { audio, paths } = this.config;
		const args = ["listen", "--end-silence-ms", String(audio.endSilenceMs)];
		if (audio.device !== undefined) args.push("--device", audio.device);
		if (audio.file !== undefined) args.push("--file", audio.file);
		if (audio.thresholdDb !== undefined) args.push("--threshold-db", String(audio.thresholdDb));
		else args.push("--margin-db", String(audio.marginDb));
		if (this.config.speech.enabled) this.speaker.warm();
		const child = spawn(paths.voice, args, { stdio: ["pipe", "pipe", "inherit"] });
		this.child = child;
		createInterface({ input: child.stdout! }).on("line", (line) => this.handle(line));
		child.on("exit", (code, signal) => {
			for (const done of this.spoken.values()) done();
			this.spoken.clear();
			if (this.stopped) return;
			log("voice", `helper exited (${code ?? signal}); restarting in 2 s`);
			setTimeout(() => this.start(), 2000);
		});
		child.on("error", (error) => log("voice", `helper failed to start: ${error.message}`));
	}

	private handle(line: string): void {
		let event: VoiceEvent;
		try {
			event = JSON.parse(line) as VoiceEvent;
		} catch {
			log("voice", `bad line: ${line}`);
			return;
		}
		switch (event.type) {
			case "audio":
				this.transcriber.append(String(event.pcm));
				return;
			case "level":
				return;
			case "spoken": {
				const done = this.spoken.get(String(event.id));
				this.spoken.delete(String(event.id));
				done?.();
				return;
			}
			case "speech_start":
				// Not a reason to stop speaking: any noise starts an utterance (barge-in needs echo cancellation).
				this.startedAt = event.t;
				this.transcriber.begin();
				break;
			case "speech_end": {
				const startedAt = this.startedAt;
				void this.transcriber.commit(5000).then((text) => {
					if (text !== undefined && isSpeech(text)) this.onUtterance({ text: text.trim(), startedAt, endedAt: event.t });
					else log("voice", `no speech: ${JSON.stringify(text ?? null)}`);
				});
				break;
			}
			default:
				break;
		}
		log("voice", line);
	}

	private send(command: object): void {
		this.child?.stdin?.write(`${JSON.stringify(command)}\n`);
	}

	/** Resolves when the text has been spoken (or speaking was stopped or failed). */
	async speak(text: string): Promise<void> {
		if (!this.config.speech.enabled || text.trim() === "") return;
		const id = String(++this.nextId);
		const spoken = new Promise<void>((resolve) => this.spoken.set(id, resolve));
		const started = performance.now();
		let first = true;
		const ok = await this.speaker.speak(text, (pcm) => {
			if (first) log("tts", `first audio ${(performance.now() - started).toFixed(0)} ms`);
			first = false;
			this.send({ type: "pcm", id, data: pcm });
		});
		if (!ok) log("tts", `speech ${first ? "failed" : "cut short"}: ${text}`);
		this.send({ type: "pcm_end", id });
		return spoken;
	}

	stopSpeaking(): void {
		this.speaker.cancel();
		this.send({ type: "stop_speaking" });
	}

	stop(): void {
		this.stopped = true;
		this.child?.kill();
	}
}

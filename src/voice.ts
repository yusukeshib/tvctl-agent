// Runs the tvctl-voice helper: utterances in, speech out.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { CloudSpeaker, Transcriber } from "./openai-voice.ts";

export type VoiceEvent = { type: string; t: number; [key: string]: unknown };

export type Utterance = {
	text: string;
	/** What the other recognizer heard, when it differs. */
	alternative?: string;
	/** Helper clock (ms) when speech started and when the transcript was final. */
	startedAt: number;
	finalAt: number;
};

/** Assembles transcripts into utterances: only text heard between speech_start and finalized counts. */
export class UtteranceAssembler {
	private open: { id: number; startedAt: number; parts: string[] } | undefined;
	/** Finalized with no text yet: the transcript can arrive just after `finalized`. */
	private closing: { startedAt: number; finalizedAt: number } | undefined;

	/** True while waiting for a late transcript; call `expire()` after `lateMs`. */
	get waiting(): boolean {
		return this.closing !== undefined;
	}

	expire(): void {
		this.closing = undefined;
	}

	/** Returns a finished utterance, or undefined. */
	push(event: VoiceEvent): Utterance | undefined {
		switch (event.type) {
			case "speech_start":
				this.closing = undefined;
				// A new start while one is open (no finalized yet) continues the same utterance.
				if (this.open === undefined) this.open = { id: Number(event.utterance), startedAt: event.t, parts: [] };
				else this.open.id = Number(event.utterance);
				return undefined;
			case "final": {
				const text = String(event.text ?? "").trim();
				if (this.open === undefined && this.closing !== undefined && text !== "") {
					const { startedAt } = this.closing;
					this.closing = undefined;
					return { text, startedAt, finalAt: event.t };
				}
				if (this.open === undefined) {
					if (text !== "") log("voice", `dropped transcript outside speech: ${text}`);
					return undefined;
				}
				if (text !== "") this.open.parts.push(text);
				return undefined;
			}
			case "finalized": {
				if (this.open === undefined || Number(event.utterance) !== this.open.id) return undefined;
				const { startedAt, parts } = this.open;
				this.open = undefined;
				const text = parts.join(" ").trim();
				if (text === "") {
					this.closing = { startedAt, finalizedAt: event.t };
					return undefined;
				}
				return { text, startedAt, finalAt: event.t };
			}
			default:
				return undefined;
		}
	}
}

/** Transcripts that recognizers report as speech when there is none. */
const HALLUCINATIONS = [/^ご視聴ありがとうございました[。.]?$/, /^(はい|うん|あ)[。.]?$/];

/**
 * Joins the two recognizers for one helper utterance (speech_start..speech_end): the cloud transcript
 * (committed at speech_end) and Apple's finals (until `finalized`, plus a grace for late ones).
 */
export class SegmentJoiner {
	private readonly segments = new Map<number, { startedAt: number; apple: string[]; cloud?: Promise<string | undefined>; appleDone: boolean }>();
	private latest: number | undefined;
	private readonly graceMs: number;
	private readonly emit: (utterance: Utterance) => void;

	constructor(graceMs: number, emit: (utterance: Utterance) => void) {
		this.graceMs = graceMs;
		this.emit = emit;
	}

	start(id: number, t: number): void {
		this.segments.set(id, { startedAt: t, apple: [], appleDone: false });
		this.latest = id;
	}

	apple(text: string): void {
		const segment = this.latest === undefined ? undefined : this.segments.get(this.latest);
		if (segment !== undefined && text.trim() !== "") segment.apple.push(text.trim());
	}

	cloud(id: number, transcript: Promise<string | undefined>): void {
		const segment = this.segments.get(id);
		if (segment !== undefined) segment.cloud = transcript;
	}

	finalized(id: number, t: number): void {
		const segment = this.segments.get(id);
		if (segment === undefined) return;
		setTimeout(() => {
			segment.appleDone = true;
			void this.settle(id, t);
		}, this.graceMs);
	}

	private async settle(id: number, t: number): Promise<void> {
		const segment = this.segments.get(id);
		if (segment === undefined || !segment.appleDone) return;
		this.segments.delete(id);
		const cloud = ((await segment.cloud) ?? "").trim();
		const apple = segment.apple.join(" ").trim();
		const real = (s: string) => s !== "" && !HALLUCINATIONS.some((h) => h.test(s));
		const text = real(cloud) ? cloud : apple;
		if (!real(text)) {
			if (cloud || apple) log("voice", `dropped: cloud "${cloud}", apple "${apple}"`);
			return;
		}
		const alternative = real(cloud) && real(apple) && apple.replace(/[\s。、.,?？!！]/g, "") !== cloud.replace(/[\s。、.,?？!！]/g, "") ? apple : undefined;
		this.emit({ text, ...(alternative ? { alternative } : {}), startedAt: segment.startedAt, finalAt: t });
	}
}

export class Voice {
	private child: ChildProcess | undefined;
	private stopped = false;
	private nextId = 0;
	private readonly spoken = new Map<string, () => void>();
	private readonly assembler = new UtteranceAssembler();
	private readonly transcriber: Transcriber | undefined;
	private readonly joiner: SegmentJoiner | undefined;
	private readonly cloudSpeaker: CloudSpeaker | undefined;

	private readonly config: Config;
	private readonly onUtterance: (utterance: Utterance) => void;

	constructor(config: Config, onUtterance: (utterance: Utterance) => void) {
		this.config = config;
		this.onUtterance = onUtterance;
		const { audio, speech } = config;
		if (audio.engine !== "apple") {
			this.transcriber = new Transcriber({
				model: audio.openaiModel,
				language: audio.locale.split("-")[0],
				delay: audio.openaiDelay,
				prompt:
					"Spoken commands to a TV remote, mostly Japanese: play, pause, volume, seek, subtitles; titles, artists and channels on YouTube, Spotify, Netflix, Prime Video and Crunchyroll.",
				keywords: ["YouTube", "Spotify", "Netflix", "Prime Video", "Crunchyroll", "ネトフリ", "プライムビデオ", "クランチロール"],
			});
			this.joiner = new SegmentJoiner(300, onUtterance);
		}
		if (speech.engine === "openai") {
			this.cloudSpeaker = new CloudSpeaker({
				model: speech.openaiModel,
				voice: speech.openaiVoice,
				instructions:
					"You are a text-to-speech voice. Read the user's text aloud exactly as written, in its language, naturally, warmly and briskly. Never add, drop, answer or change words.",
			});
		}
	}

	start(): void {
		const { audio, speech, paths } = this.config;
		const args = ["listen", "--locale", audio.locale, "--end-silence-ms", String(audio.endSilenceMs)];
		if (audio.device !== undefined) args.push("--device", audio.device);
		if (audio.file !== undefined) args.push("--file", audio.file);
		if (audio.thresholdDb !== undefined) args.push("--threshold-db", String(audio.thresholdDb));
		else args.push("--margin-db", String(audio.marginDb));
		if (speech.voice !== undefined) args.push("--voice", speech.voice);
		if (speech.rate !== undefined) args.push("--rate", String(speech.rate));
		if (this.transcriber !== undefined) args.push("--stream-audio");
		this.cloudSpeaker?.warm();
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
		if (this.transcriber !== undefined && this.joiner !== undefined) {
			this.handleJoined(event, line);
			return;
		}
		switch (event.type) {
			case "partial":
			case "level":
				break;
			case "spoken": {
				const done = this.spoken.get(String(event.id));
				this.spoken.delete(String(event.id));
				done?.();
				break;
			}
			case "speech_start":
				// The user talks over the agent: stop speaking.
				if (this.spoken.size > 0) this.stopSpeaking();
				log("voice", line);
				break;
			default:
				log("voice", line);
		}
		const utterance = this.assembler.push(event);
		if (utterance !== undefined) this.onUtterance(utterance);
		else if (event.type === "finalized" && this.assembler.waiting) setTimeout(() => this.assembler.expire(), 400);
	}

	/** Cloud (+ Apple) recognition: the helper streams each utterance's audio. */
	private handleJoined(event: VoiceEvent, line: string): void {
		const transcriber = this.transcriber!;
		const joiner = this.joiner!;
		switch (event.type) {
			case "audio":
				transcriber.append(String(event.pcm));
				return;
			case "partial":
			case "level":
				return;
			case "speech_start":
				if (this.spoken.size > 0) this.stopSpeaking();
				transcriber.begin();
				joiner.start(Number(event.utterance), event.t);
				break;
			case "speech_end":
				joiner.cloud(Number(event.utterance), transcriber.commit(5000));
				break;
			case "final":
				joiner.apple(String(event.text ?? ""));
				break;
			case "finalized":
				joiner.finalized(Number(event.utterance), event.t);
				break;
			case "spoken": {
				const done = this.spoken.get(String(event.id));
				this.spoken.delete(String(event.id));
				done?.();
				return;
			}
			default:
				break;
		}
		log("voice", line);
	}

	private send(command: object): void {
		this.child?.stdin?.write(`${JSON.stringify(command)}\n`);
	}

	/** Resolves when the text has been spoken (or speaking was stopped). */
	async speak(text: string): Promise<void> {
		if (!this.config.speech.enabled || text.trim() === "") return;
		const id = String(++this.nextId);
		const spoken = new Promise<void>((resolve) => this.spoken.set(id, resolve));
		if (this.cloudSpeaker !== undefined) {
			const started = performance.now();
			let first = true;
			const ok = await this.cloudSpeaker.speak(text, (pcm) => {
				if (first) log("tts", `first audio ${(performance.now() - started).toFixed(0)} ms`);
				first = false;
				this.send({ type: "pcm", id, data: pcm });
			});
			if (ok || !first) {
				this.send({ type: "pcm_end", id });
				return spoken;
			}
			// Nothing came: the system voice says it instead.
			log("tts", "cloud speech failed; using the system voice");
		}
		this.send({ type: "speak", id, text });
		return spoken;
	}

	stopSpeaking(): void {
		this.cloudSpeaker?.cancel();
		this.send({ type: "stop_speaking" });
	}

	stop(): void {
		this.stopped = true;
		this.child?.kill();
	}
}

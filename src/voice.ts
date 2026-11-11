// Runs the tvctl-voice helper: utterances in, speech out.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

export type VoiceEvent = { type: string; t: number; [key: string]: unknown };

export type Utterance = {
	text: string;
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

export class Voice {
	private child: ChildProcess | undefined;
	private stopped = false;
	private nextId = 0;
	private readonly spoken = new Map<string, () => void>();
	private readonly assembler = new UtteranceAssembler();

	private readonly config: Config;
	private readonly onUtterance: (utterance: Utterance) => void;

	constructor(config: Config, onUtterance: (utterance: Utterance) => void) {
		this.config = config;
		this.onUtterance = onUtterance;
	}

	start(): void {
		const { audio, speech, paths } = this.config;
		const args = ["listen", "--locale", audio.locale, "--end-silence-ms", String(audio.endSilenceMs)];
		if (audio.device !== undefined) args.push("--device", audio.device);
		if (audio.thresholdDb !== undefined) args.push("--threshold-db", String(audio.thresholdDb));
		else args.push("--margin-db", String(audio.marginDb));
		if (speech.voice !== undefined) args.push("--voice", speech.voice);
		if (speech.rate !== undefined) args.push("--rate", String(speech.rate));
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

	private send(command: object): void {
		this.child?.stdin?.write(`${JSON.stringify(command)}\n`);
	}

	/** Resolves when the text has been spoken (or speaking was stopped). */
	speak(text: string): Promise<void> {
		if (!this.config.speech.enabled || text.trim() === "") return Promise.resolve();
		const id = String(++this.nextId);
		return new Promise((resolve) => {
			this.spoken.set(id, resolve);
			this.send({ type: "speak", id, text });
		});
	}

	stopSpeaking(): void {
		this.send({ type: "stop_speaking" });
	}

	stop(): void {
		this.stopped = true;
		this.child?.kill();
	}
}

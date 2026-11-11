// OpenAI voice over the Realtime API: streaming transcription (gpt-live-transcribe) of each utterance the
// helper detects, and speech (gpt-realtime-2.1-mini reading a text verbatim) streamed back as PCM.
import { execFileSync } from "node:child_process";
import { log } from "./log.ts";

const URL_BASE = "wss://api.openai.com/v1/realtime";

/** OPENAI_API_KEY from the environment, or from the user's login shell (launchd starts without it). */
export function openaiKey(): string | undefined {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	try {
		const shell = process.env.SHELL || "/bin/zsh";
		const key = execFileSync(shell, ["-lic", 'printf %s "$OPENAI_API_KEY"'], { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		if (key) process.env.OPENAI_API_KEY = key;
		return key || undefined;
	} catch {
		return undefined;
	}
}

type Event = { type: string; [key: string]: unknown };

/** One Realtime WebSocket, opened on demand and again after it closes (sessions last at most 60 minutes). */
class Socket {
	private ws: WebSocket | undefined;
	private opening: Promise<WebSocket> | undefined;
	private openedAt = 0;
	private readonly url: string;
	private readonly setup: Event;
	private readonly onEvent: (event: Event) => void;
	private readonly onClose: () => void;

	constructor(url: string, setup: Event, onEvent: (event: Event) => void, onClose: () => void) {
		this.url = url;
		this.setup = setup;
		this.onEvent = onEvent;
		this.onClose = onClose;
	}

	/** Reconnects ahead of the 60-minute limit when idle. */
	fresh(): void {
		if (this.ws && Date.now() - this.openedAt > 50 * 60_000) this.ws.close();
	}

	open(): Promise<WebSocket> {
		if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
		if (this.opening) return this.opening;
		const key = openaiKey();
		if (!key) return Promise.reject(new Error("OPENAI_API_KEY is not set"));
		this.opening = new Promise<WebSocket>((resolve, reject) => {
			const ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${key}` } } as never);
			ws.onopen = () => {
				ws.send(JSON.stringify(this.setup));
				this.ws = ws;
				this.openedAt = Date.now();
				this.opening = undefined;
				resolve(ws);
			};
			ws.onerror = (e) => {
				this.opening = undefined;
				reject(new Error(`realtime connection failed: ${String((e as ErrorEvent).message ?? "error")}`));
			};
			ws.onmessage = (m) => this.onEvent(JSON.parse(String(m.data)) as Event);
			ws.onclose = () => {
				if (this.ws === ws) this.ws = undefined;
				this.onClose();
			};
		});
		return this.opening;
	}

	async send(event: Event): Promise<void> {
		(await this.open()).send(JSON.stringify(event));
	}
}

export type TranscriberOptions = { model: string; language: string; delay: string; prompt: string; keywords: string[] };

/** Transcribes utterances: audio is appended as it arrives and committed when the utterance ends. */
export class Transcriber {
	private readonly socket: Socket;
	/** Commits waiting for their item id, in order. */
	private readonly committing: ((itemId: string | undefined) => void)[] = [];
	private readonly results = new Map<string, (text: string | undefined) => void>();
	/** Chunks of the utterance being sent, in order, so the socket sees them in sequence. */
	private chain: Promise<void> = Promise.resolve();

	constructor(options: TranscriberOptions) {
		this.socket = new Socket(
			`${URL_BASE}?intent=transcription`,
			{
				type: "session.update",
				session: {
					type: "transcription",
					audio: {
						input: {
							format: { type: "audio/pcm", rate: 24000 },
							transcription: {
								model: options.model,
								languages: [options.language],
								delay: options.delay,
								prompt: options.prompt,
								keywords: options.keywords,
							},
							turn_detection: null,
						},
					},
				},
			},
			(event) => this.handle(event),
			() => {
				for (const done of this.committing.splice(0)) done(undefined);
				for (const done of this.results.values()) done(undefined);
				this.results.clear();
			},
		);
	}

	private handle(event: Event): void {
		switch (event.type) {
			case "input_audio_buffer.committed":
				this.committing.shift()?.(String(event.item_id));
				break;
			case "conversation.item.input_audio_transcription.completed": {
				const done = this.results.get(String(event.item_id));
				this.results.delete(String(event.item_id));
				done?.(String(event.transcript ?? ""));
				break;
			}
			case "conversation.item.input_audio_transcription.failed": {
				const done = this.results.get(String(event.item_id));
				this.results.delete(String(event.item_id));
				done?.(undefined);
				break;
			}
			case "error": {
				const error = event.error as { message?: string; code?: string } | undefined;
				log("stt", `error: ${error?.code ?? ""} ${error?.message ?? ""}`);
				// A commit of too little audio fails without a committed event.
				if (error?.code === "input_audio_buffer_commit_empty") this.committing.shift()?.(undefined);
				break;
			}
			default:
				break;
		}
	}

	private enqueue(step: () => Promise<void>): Promise<void> {
		this.chain = this.chain.then(step).catch((error: unknown) => log("stt", (error as Error).message));
		return this.chain;
	}

	begin(): void {
		this.socket.fresh();
		void this.enqueue(() => this.socket.send({ type: "input_audio_buffer.clear" }));
	}

	append(pcmBase64: string): void {
		void this.enqueue(() => this.socket.send({ type: "input_audio_buffer.append", audio: pcmBase64 }));
	}

	/** Ends the utterance; resolves with its transcript, or undefined on failure or after `timeoutMs`. */
	commit(timeoutMs: number): Promise<string | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (text: string | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(text);
			};
			const timer = setTimeout(() => finish(undefined), timeoutMs);
			void this.enqueue(async () => {
				this.committing.push((itemId) => {
					if (itemId === undefined) finish(undefined);
					else this.results.set(itemId, finish);
				});
				await this.socket.send({ type: "input_audio_buffer.commit" });
			});
		});
	}
}

export type SpeakerOptions = { model: string; voice: string; instructions: string };

/** Speaks texts verbatim with a realtime voice model, one at a time, streaming PCM16 24 kHz chunks. */
export class CloudSpeaker {
	private readonly socket: Socket;
	private current: { onChunk: (pcm: string) => void; done: (ok: boolean) => void; responseId?: string } | undefined;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: SpeakerOptions) {
		this.socket = new Socket(
			`${URL_BASE}?model=${encodeURIComponent(options.model)}`,
			{
				type: "session.update",
				session: {
					type: "realtime",
					output_modalities: ["audio"],
					audio: { output: { format: { type: "audio/pcm", rate: 24000 }, voice: options.voice } },
					instructions: options.instructions,
				},
			},
			(event) => this.handle(event),
			() => this.current?.done(false),
		);
	}

	/** Opens the connection ahead of the first answer. */
	warm(): void {
		this.socket.open().catch((error: unknown) => log("tts", (error as Error).message));
	}

	private handle(event: Event): void {
		const current = this.current;
		if (current === undefined) return;
		switch (event.type) {
			case "response.created":
				current.responseId = String((event.response as { id?: string }).id);
				break;
			case "response.output_audio.delta":
				current.onChunk(String(event.delta));
				break;
			case "response.done": {
				const status = (event.response as { status?: string }).status;
				current.done(status === "completed");
				break;
			}
			case "error":
				log("tts", `error: ${JSON.stringify(event.error)}`);
				current.done(false);
				break;
			default:
				break;
		}
	}

	/** Streams `text` as speech; resolves true when it was spoken whole. */
	speak(text: string, onChunk: (pcm: string) => void): Promise<boolean> {
		const run = () =>
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => finish(false), 30_000);
				const finish = (ok: boolean) => {
					if (this.current?.done !== finish) return;
					clearTimeout(timer);
					this.current = undefined;
					resolve(ok);
				};
				this.current = { onChunk, done: finish };
				this.socket.fresh();
				this.socket
					.send({
						type: "response.create",
						response: {
							conversation: "none",
							input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
						},
					})
					.catch((error: unknown) => {
						log("tts", (error as Error).message);
						finish(false);
					});
			});
		const result = this.queue.then(run, run);
		this.queue = result;
		return result;
	}

	/** Stops the answer being generated. */
	cancel(): void {
		if (this.current === undefined) return;
		void this.socket.send({ type: "response.cancel" }).catch(() => {});
		this.current.done(false);
	}
}

// One OpenAI Realtime conversation (speech to speech): the model hears the microphone, decides when the
// user has finished (semantic VAD), answers with its voice, calls our tools, and stops when interrupted.
// Sessions last at most 60 minutes; we reconnect and start the new one with the recent conversation.
import { log } from "./log.ts";
import type { Memory } from "./memory.ts";
import { openaiKey } from "./openai.ts";
import { runTool, type Tool } from "./tools.ts";

type Event = { type: string; [key: string]: unknown };
type OutputItem = { type: string; id?: string; name?: string; call_id?: string; arguments?: string };

export type Speaker = {
	/** Streams speech (PCM16 24 kHz mono) for one assistant item. */
	audio(itemId: string, pcm: string): void;
	/** No more audio for the item. */
	end(itemId: string): void;
	/** Stop speaking now; `stopped` is called back with what was heard. */
	stop(): void;
};

export type RealtimeOptions = {
	model: string;
	voice: string;
	eagerness: string;
	noiseReduction: string;
	transcribeModel: string;
	language: string;
	/** Session instructions, built when a session starts (they include the recent conversation). */
	instructions: () => string;
	tools: Tool[];
	memory: Memory;
	/** Text only (tests): no audio in or out. */
	text?: boolean;
};

export class Realtime {
	private readonly options: RealtimeOptions;
	private readonly speaker: Speaker | undefined;
	private ws: WebSocket | undefined;
	private openedAt = 0;
	private lastActivity = 0;
	private closing = false;
	private busy = 0;
	/** Assistant items whose audio was cut off: further deltas are dropped. */
	private readonly cut = new Set<string>();
	private playing: { itemId: string; contentIndex: number } | undefined;
	private speechStartedAt = 0;
	private readonly timer: NodeJS.Timeout;
	/** Text mode: resolves when a response finishes without tool calls. */
	private onIdle: (() => void) | undefined;

	constructor(options: RealtimeOptions, speaker?: Speaker) {
		this.options = options;
		this.speaker = speaker;
		// Renew the session ahead of the 60-minute limit, at a quiet moment.
		this.timer = setInterval(() => {
			if (this.ws && Date.now() - this.openedAt > 50 * 60_000 && this.busy === 0 && Date.now() - this.lastActivity > 15_000) {
				log("realtime", "renewing the session");
				this.ws.close();
			}
		}, 10_000);
	}

	connect(): Promise<void> {
		const key = openaiKey();
		if (!key) return Promise.reject(new Error("OPENAI_API_KEY is not set"));
		return new Promise((resolve, reject) => {
			const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.options.model)}`;
			const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } } as never);
			ws.onopen = () => {
				this.ws = ws;
				this.openedAt = Date.now();
				this.send(this.sessionUpdate());
				log("realtime", `connected (${this.options.model})`);
				resolve();
			};
			ws.onerror = (e) => {
				if (this.ws !== ws) reject(new Error(`realtime connection failed: ${String((e as ErrorEvent).message ?? "error")}`));
			};
			ws.onmessage = (m) => this.handle(JSON.parse(String(m.data)) as Event);
			ws.onclose = (e) => {
				if (this.ws !== ws) return;
				this.ws = undefined;
				this.playing = undefined;
				this.speaker?.stop();
				if (this.closing) return;
				log("realtime", `closed (${e.code} ${e.reason}); reconnecting`);
				this.reconnect(1000);
			};
		});
	}

	private reconnect(delayMs: number): void {
		setTimeout(() => {
			this.connect().catch((error: unknown) => {
				log("realtime", (error as Error).message);
				this.reconnect(Math.min(delayMs * 2, 30_000));
			});
		}, delayMs);
	}

	close(): void {
		this.closing = true;
		clearInterval(this.timer);
		this.ws?.close();
	}

	/** Microphone audio, PCM16 24 kHz mono, base64. Dropped while disconnected. */
	appendAudio(pcm: string): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "input_audio_buffer.append", audio: pcm });
	}

	/** The speaker stopped (interrupted): drop the unheard part of the answer from the conversation. */
	stopped(itemId: string, playedMs: number): void {
		this.cut.add(itemId);
		if (this.playing?.itemId !== itemId) return;
		const contentIndex = this.playing.contentIndex;
		this.playing = undefined;
		this.send({ type: "conversation.item.truncate", item_id: itemId, content_index: contentIndex, audio_end_ms: Math.max(0, playedMs) });
		log("realtime", `interrupted after ${playedMs} ms`);
	}

	/** The speaker finished the item: nothing left to interrupt. */
	spoken(itemId: string): void {
		if (this.playing?.itemId === itemId) this.playing = undefined;
	}

	/** Text mode: one user message; resolves when the reply (after any tool calls) is done. */
	say(text: string): Promise<void> {
		return new Promise((resolve) => {
			this.onIdle = resolve;
			this.options.memory.add("user", text);
			this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
			this.send({ type: "response.create" });
		});
	}

	private send(event: Event): void {
		this.ws?.send(JSON.stringify(event));
	}

	private sessionUpdate(): Event {
		const o = this.options;
		const tools = o.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
		const session: Record<string, unknown> = {
			type: "realtime",
			model: o.model,
			instructions: o.instructions(),
			tools,
			tool_choice: "auto",
		};
		if (o.text) {
			session.output_modalities = ["text"];
			session.audio = { input: { turn_detection: null } };
		} else {
			session.output_modalities = ["audio"];
			session.audio = {
				input: {
					format: { type: "audio/pcm", rate: 24000 },
					noise_reduction: o.noiseReduction === "off" ? null : { type: o.noiseReduction },
					transcription: { model: o.transcribeModel, language: o.language },
					turn_detection: { type: "semantic_vad", eagerness: o.eagerness, create_response: true, interrupt_response: true },
				},
				output: { format: { type: "audio/pcm", rate: 24000 }, voice: o.voice },
			};
		}
		return { type: "session.update", session };
	}

	private handle(event: Event): void {
		switch (event.type) {
			case "input_audio_buffer.speech_started":
				this.lastActivity = Date.now();
				this.speechStartedAt = performance.now();
				// The user talks over the answer: stop at once (the server cancels the response).
				if (this.playing) this.speaker?.stop();
				break;
			case "input_audio_buffer.speech_stopped":
				this.lastActivity = Date.now();
				break;
			case "conversation.item.input_audio_transcription.completed": {
				const text = String(event.transcript ?? "").trim();
				log("heard", text);
				this.options.memory.add("user", text);
				break;
			}
			case "response.created":
				this.busy++;
				break;
			case "response.output_audio.delta": {
				const itemId = String(event.item_id);
				if (this.cut.has(itemId)) break;
				if (this.playing?.itemId !== itemId) {
					this.playing = { itemId, contentIndex: Number(event.content_index ?? 0) };
					if (this.speechStartedAt > 0) log("realtime", `first audio ${(performance.now() - this.speechStartedAt).toFixed(0)} ms after speech start`);
					this.speechStartedAt = 0;
				}
				this.speaker?.audio(itemId, String(event.delta));
				break;
			}
			case "response.output_audio.done": {
				const itemId = String(event.item_id);
				if (!this.cut.has(itemId)) this.speaker?.end(itemId);
				break;
			}
			case "response.output_audio_transcript.done":
			case "response.output_text.done": {
				const text = String(event.transcript ?? event.text ?? "").trim();
				log("answer", text);
				this.options.memory.add("assistant", text);
				break;
			}
			case "response.done":
				this.busy = Math.max(0, this.busy - 1);
				this.lastActivity = Date.now();
				void this.finish(event.response as { status?: string; output?: OutputItem[]; status_details?: unknown });
				break;
			case "error":
				log("realtime", `error: ${JSON.stringify(event.error)}`);
				break;
			default:
				break;
		}
	}

	/** Runs the response's tool calls, then lets the model continue with their results. */
	private async finish(response: { status?: string; output?: OutputItem[]; status_details?: unknown }): Promise<void> {
		if (response.status === "failed") log("realtime", `response failed: ${JSON.stringify(response.status_details)}`);
		const calls = (response.output ?? []).filter((item) => item.type === "function_call");
		if (calls.length === 0) {
			if (response.status !== "cancelled") this.onIdle?.();
			return;
		}
		this.busy++;
		try {
			for (const call of calls) {
				this.options.memory.add("tool", `${call.name} ${call.arguments ?? ""}`);
				const output = await runTool(this.options.tools, String(call.name), String(call.arguments ?? ""));
				this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output } });
			}
		} finally {
			this.busy--;
		}
		this.send({ type: "response.create" });
	}
}

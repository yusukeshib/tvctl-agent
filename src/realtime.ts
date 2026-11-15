// One OpenAI Realtime conversation (speech to speech): the model hears the microphone, the server detects
// when the user has finished (semantic VAD), we decide from the transcript whether the turn is meant for
// the agent, and the model answers with its voice, calls our tools, and stops when interrupted.
// Sessions last at most 60 minutes; we reconnect and start the new one with the recent conversation.
import { Diagnostics } from "./diagnostics.ts";
import type { Memory } from "./memory.ts";
import { openaiKey } from "./openai.ts";
import { runTool, type Tool } from "./tools.ts";
import { judgeUtterance } from "./utterance.ts";

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
	/** Session instructions, built when a session starts or the notes change (they include the recent conversation). */
	instructions: () => string;
	tools: Tool[];
	memory: Memory;
	/** Text only (tests): no audio in or out. */
	text?: boolean;
	/** The logs (readable lines and the trace). */
	diagnostics?: Diagnostics;
	/** What the player shows now (one line), told to the model before it answers a turn when it changed. */
	playerState?: () => Promise<string>;
};

/** An assistant answer on its way to memory: written once its text and how much of it was heard are known. */
type Answer = { text?: string; bytes: number; audioDone: boolean; playedMs?: number; spoken?: boolean };

/**
 * Responses are scheduled one at a time: `phase` is idle, preparing (looking up the player state),
 * responding (from our response.create until response.done or its error), or tools (running calls).
 * A user turn that arrives while not idle sets `pending` and is answered when the phase returns to idle.
 */
type Phase = "idle" | "preparing" | "responding" | "tools";

export class Realtime {
	private readonly options: RealtimeOptions;
	private readonly speaker: Speaker | undefined;
	private readonly diag: Diagnostics;
	private ws: WebSocket | undefined;
	/** Connection number; async work of an older connection must not touch the new one. */
	private session = 0;
	private openedAt = 0;
	private lastActivity = 0;
	private closing = false;
	private phase: Phase = "idle";
	private pending = false;
	/** Assistant items whose audio was cut off: further deltas are not played. */
	private readonly cut = new Set<string>();
	private playing: { itemId: string; contentIndex: number } | undefined;
	/** The player state last told to the model this session. */
	private toldState = "";
	private answers = new Map<string, Answer>();
	private readonly timer: NodeJS.Timeout;
	/** Text mode: resolves when a response finishes without tool calls. */
	private onIdle: (() => void) | undefined;

	constructor(options: RealtimeOptions, speaker?: Speaker) {
		this.options = options;
		this.speaker = speaker;
		this.diag = options.diagnostics ?? new Diagnostics(undefined);
		// Renew the session ahead of the 60-minute limit, at a quiet moment.
		this.timer = setInterval(() => {
			if (this.ws && Date.now() - this.openedAt > 50 * 60_000 && this.phase === "idle" && Date.now() - this.lastActivity > 15_000) {
				this.diag.note("session", `#${this.session} renewing (age ${Math.round((Date.now() - this.openedAt) / 60_000)} min)`);
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
				this.startSession();
				const update = this.sessionUpdate();
				this.diag.connected(this.session, this.options.model, String((update.session as { instructions: string }).instructions));
				this.send(update);
				resolve();
			};
			ws.onerror = (e) => {
				if (this.ws !== ws) reject(new Error(`realtime connection failed: ${String((e as ErrorEvent).message ?? "error")}`));
			};
			ws.onmessage = (m) => {
				if (this.ws === ws) this.handle(JSON.parse(String(m.data)) as Event);
			};
			ws.onclose = (e) => {
				if (this.ws !== ws) return;
				this.ws = undefined;
				this.playing = undefined;
				this.speaker?.stop();
				this.diag.closed(e.code, e.reason, !this.closing);
				if (this.closing) return;
				this.reconnect(1000);
			};
		});
	}

	/** A new conversation: nothing of the old one's scheduling carries over. */
	private startSession(): void {
		this.session++;
		this.phase = "idle";
		this.pending = false;
		this.toldState = "";
		this.answers = new Map();
	}

	private reconnect(delayMs: number): void {
		setTimeout(() => {
			this.connect().catch((error: unknown) => {
				this.diag.note("session", `reconnect failed: ${(error as Error).message}; retrying in ${Math.min(delayMs * 2, 30_000) / 1000} s`);
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
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.diag.inputAudio(pcm);
		this.send({ type: "input_audio_buffer.append", audio: pcm });
	}

	/** The speaker stopped (interrupted): drop the unheard part of the answer from the conversation. */
	stopped(itemId: string, playedMs: number): void {
		this.cut.add(itemId);
		this.diag.interrupted(itemId, playedMs);
		const answer = this.answer(itemId);
		if (answer.playedMs === undefined && !answer.spoken) answer.playedMs = playedMs;
		this.remember(itemId);
		if (this.playing?.itemId !== itemId) return;
		const contentIndex = this.playing.contentIndex;
		this.playing = undefined;
		this.send({ type: "conversation.item.truncate", item_id: itemId, content_index: contentIndex, audio_end_ms: Math.max(0, playedMs) });
	}

	/** The speaker finished the item: nothing left to interrupt. */
	spoken(itemId: string): void {
		const answer = this.answer(itemId);
		if (answer.playedMs === undefined) answer.spoken = true;
		this.remember(itemId);
		if (this.playing?.itemId === itemId) this.playing = undefined;
	}

	/** Text mode: one user message; resolves when the reply (after any tool calls) is done. */
	say(text: string): Promise<void> {
		return new Promise((resolve) => {
			this.onIdle = resolve;
			this.options.memory.add("user", text);
			this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
			this.request();
		});
	}

	private answer(itemId: string): Answer {
		let answer = this.answers.get(itemId);
		if (answer === undefined) {
			answer = { bytes: 0, audioDone: false };
			this.answers.set(itemId, answer);
		}
		return answer;
	}

	/** Writes an answer to memory as far as it was heard, once its text, full length and outcome are known. */
	private remember(itemId: string): void {
		const a = this.answers.get(itemId);
		if (a === undefined || a.text === undefined) return;
		let ratio: number;
		if (this.options.text || this.speaker === undefined || a.spoken) ratio = 1;
		else if (a.playedMs !== undefined && a.audioDone) ratio = a.bytes > 0 ? Math.min(1, a.playedMs / (a.bytes / 48)) : 0;
		else return;
		this.answers.delete(itemId);
		this.options.memory.add("assistant", heardPart(a.text, ratio));
	}

	/** Answers the latest turn now, or as soon as the current response or tool run finishes. */
	private request(): void {
		if (this.phase !== "idle") {
			this.pending = true;
			return;
		}
		void this.respond();
	}

	/** Tells the model what the player shows if that changed, then asks for a response. */
	private async respond(): Promise<void> {
		const session = this.session;
		this.phase = "preparing";
		if (this.options.playerState) {
			const state = await this.options.playerState().catch((error: unknown) => `unknown (${(error as Error).message})`);
			if (session !== this.session) return;
			if (state !== this.toldState) {
				this.toldState = state;
				this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: `Player now: ${state}` }] } });
			}
		}
		// Every turn received until now is in the conversation this response answers.
		this.pending = false;
		this.phase = "responding";
		this.send({ type: "response.create" });
	}

	/** Back to idle: answer a turn that arrived meanwhile. */
	private idle(): void {
		this.phase = "idle";
		if (this.pending) this.request();
	}

	private send(event: Event): void {
		if (this.ws === undefined) return;
		this.diag.client(event);
		this.ws.send(JSON.stringify(event));
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
					// We create responses ourselves once the transcript shows the turn is meant for us (utterance.ts).
					turn_detection: { type: "semantic_vad", eagerness: o.eagerness, create_response: false, interrupt_response: true },
				},
				output: { format: { type: "audio/pcm", rate: 24000 }, voice: o.voice },
			};
		}
		return { type: "session.update", session };
	}

	private handle(event: Event): void {
		this.diag.server(event);
		switch (event.type) {
			case "input_audio_buffer.speech_started":
				this.lastActivity = Date.now();
				// The user talks over the answer: stop at once (the server cancels the response).
				if (this.playing) this.speaker?.stop();
				break;
			case "input_audio_buffer.speech_stopped":
				this.lastActivity = Date.now();
				break;
			case "conversation.item.input_audio_transcription.completed": {
				const text = String(event.transcript ?? "");
				const itemId = String(event.item_id);
				const verdict = judgeUtterance(text, this.options.language);
				if (!verdict.answer) {
					this.diag.note("ignored", `${itemId}: "${text.trim()}" (${verdict.reason})`, { item_id: itemId, transcript: text, reason: verdict.reason });
					// Out of the conversation too, so noise cannot steer later answers.
					this.send({ type: "conversation.item.delete", item_id: itemId });
					break;
				}
				this.options.memory.add("user", text);
				this.request();
				break;
			}
			case "response.output_audio.delta": {
				const itemId = String(event.item_id);
				// Counted even after an interruption: the full length tells how much of the text was heard.
				this.answer(itemId).bytes += Math.floor((String(event.delta).length * 3) / 4);
				if (this.cut.has(itemId)) break;
				if (this.playing?.itemId !== itemId) this.playing = { itemId, contentIndex: Number(event.content_index ?? 0) };
				this.speaker?.audio(itemId, String(event.delta));
				break;
			}
			case "response.output_audio.done": {
				const itemId = String(event.item_id);
				this.answer(itemId).audioDone = true;
				if (!this.cut.has(itemId)) this.speaker?.end(itemId);
				this.remember(itemId);
				break;
			}
			case "response.output_audio_transcript.done":
			case "response.output_text.done": {
				const itemId = String(event.item_id);
				this.answer(itemId).text = String(event.transcript ?? event.text ?? "");
				this.remember(itemId);
				break;
			}
			case "response.done": {
				this.lastActivity = Date.now();
				const response = event.response as { status?: string; output?: OutputItem[] };
				// A cancelled response may never send output_audio.done: its audio is complete now.
				for (const item of response.output ?? []) {
					if (item.id === undefined || !this.answers.has(item.id)) continue;
					this.answer(item.id).audioDone = true;
					this.remember(item.id);
				}
				void this.finish(response);
				break;
			}
			case "error":
				// A rejected response.create never gets a response.done.
				if (this.phase === "responding" && String((event.error as { code?: string } | undefined)?.code ?? "").includes("response")) this.idle();
				break;
			default:
				break;
		}
	}

	/** Runs the response's tool calls, then lets the model continue with their results. */
	private async finish(response: { status?: string; output?: OutputItem[] }): Promise<void> {
		const session = this.session;
		const calls = (response.output ?? []).filter((item) => item.type === "function_call");
		if (calls.length === 0) {
			if (response.status !== "cancelled") this.onIdle?.();
			this.idle();
			return;
		}
		this.phase = "tools";
		let refresh = false;
		for (const call of calls) {
			this.options.memory.add("tool", `${call.name} ${call.arguments ?? ""}`);
			const started = performance.now();
			const output = await runTool(this.options.tools, String(call.name), String(call.arguments ?? ""));
			if (session !== this.session) return;
			this.diag.tool(String(call.name), String(call.arguments ?? ""), output, performance.now() - started);
			if (!output.startsWith("error:") && this.options.tools.find((t) => t.name === call.name)?.changesInstructions) refresh = true;
			this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output } });
		}
		// Saved or deleted notes take effect in this session, not only after the next renewal.
		if (refresh) this.send({ type: "session.update", session: { type: "realtime", instructions: this.options.instructions() } });
		// The continuation goes through the same path as a turn: fresh player state, pending turns included.
		this.phase = "idle";
		void this.respond();
	}
}

/** The heard part of an answer, marked when it was cut off. */
export function heardPart(text: string, ratio: number): string {
	const value = text.trim();
	if (ratio >= 0.98) return value;
	const kept = value.slice(0, Math.ceil(value.length * Math.max(0, ratio))).trim();
	return kept === "" ? "" : `${kept}…（ここで遮られた）`;
}

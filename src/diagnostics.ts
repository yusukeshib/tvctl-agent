// Watches one Realtime conversation for the logs: readable lines (agent.log) for each turn, answer, tool
// run, interruption and session, and the full trace (trace.ts). It only observes; it never changes what
// is sent or played.
import { log as defaultLog } from "./log.ts";
import { AudioRing, type Trace } from "./trace.ts";

type Event = { type: string; [key: string]: unknown };
type Log = (scope: string, message: string) => void;

type Item = { id: string; type: string; role?: string; text: string; truncatedMs?: number };
type Usage = {
	input_tokens?: number;
	output_tokens?: number;
	input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens?: number };
	output_token_details?: { text_tokens?: number; audio_tokens?: number };
};
type Response = { id?: string; status?: string; status_details?: unknown; usage?: Usage; output?: { id?: string; type?: string }[] };

/** Server events too frequent or redundant for the trace (the matching `.done` events carry the content). */
const skipped = new Set([
	"response.output_audio.delta",
	"response.output_audio_transcript.delta",
	"response.output_text.delta",
	"response.function_call_arguments.delta",
	"conversation.item.input_audio_transcription.delta",
]);

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function itemText(item: Record<string, unknown>): string {
	if (item.type === "function_call") return `${String(item.name)}(${String(item.arguments ?? "")})`;
	if (item.type === "function_call_output") return String(item.output ?? "");
	const content = Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : [];
	return content
		.map((c) => String(c.transcript ?? c.text ?? ""))
		.join(" ")
		.trim();
}

/** "1234 (text 200, audio 1034, cached 900)" */
export function tokens(total: number | undefined, details: Record<string, number | undefined> | undefined): string {
	const parts = Object.entries(details ?? {})
		.filter(([key, value]) => typeof value === "number" && !key.includes("details"))
		.map(([key, value]) => `${key.replace(/_tokens$/, "")} ${value}`);
	return `${total ?? "?"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

export class Diagnostics {
	private readonly trace: Trace | undefined;
	private readonly log: Log;
	private session = 0;
	/** The conversation as the server reported it this session, in order. */
	private items = new Map<string, Item>();
	private readonly mic = new AudioRing();
	private speechStart = new Map<string, number>();
	/** Wall clock of the latest end of user speech, for the answer latency. */
	private speechEndedAt = 0;
	private responseStartedAt = new Map<string, number>();
	/** Assistant audio per item: bytes received (and the audio itself when saving audio). */
	private spoken = new Map<string, { bytes: number; chunks: Buffer[]; saved: boolean }>();
	private audioSentBytes = 0;

	constructor(trace: Trace | undefined, log: Log = defaultLog) {
		this.trace = trace;
		this.log = log;
	}

	/** Something about the run itself (start, configuration, errors). */
	note(scope: string, message: string, data: Record<string, unknown> = {}): void {
		this.log(scope, message);
		this.trace?.write("agent", { type: `agent.${scope}`, message, ...data });
	}

	/** A new Realtime session: its conversation starts empty (apart from the instructions). */
	connected(session: number, model: string, instructions: string): void {
		this.session = session;
		if (this.trace) this.trace.session = session;
		this.items = new Map();
		this.speechStart = new Map();
		this.responseStartedAt = new Map();
		this.spoken = new Map();
		this.mic.reset();
		this.audioSentBytes = 0;
		const recent = /The conversation so far[^\n]*\n([\s\S]*?)\n(?:\n|$)/.exec(instructions)?.[1] ?? "";
		const entries = recent === "" ? 0 : recent.split("\n").length;
		this.note("session", `#${session} connected (${model}); instructions ${instructions.length} chars, ${entries} remembered entries`, {
			model,
			instructions_chars: instructions.length,
			remembered_entries: entries,
		});
	}

	closed(code: number, reason: string, reconnecting: boolean): void {
		this.note("session", `#${this.session} closed (${code}${reason ? ` ${reason}` : ""})${reconnecting ? "; reconnecting, the new session starts from the log" : ""}`, {
			code,
			reason,
			items: this.items.size,
			audio_sent_ms: Math.round(this.audioSentBytes / 48),
		});
	}

	/** An event we sent. Microphone audio is counted, not traced. */
	client(event: Event): void {
		if (event.type === "input_audio_buffer.append") return;
		this.trace?.write("client", event);
	}

	/** Microphone audio sent to the session (PCM16 24 kHz, base64). */
	inputAudio(pcm: string): void {
		const bytes = Buffer.from(pcm, "base64");
		this.audioSentBytes += bytes.length;
		if (this.trace?.audio) this.mic.push(bytes);
	}

	/** The speaker stopped an answer early. */
	interrupted(itemId: string, playedMs: number): void {
		const total = Math.round((this.spoken.get(itemId)?.bytes ?? 0) / 48);
		const text = this.items.get(itemId)?.text ?? "";
		this.note("interrupt", `${itemId}: heard ${seconds(playedMs)} of ${seconds(total)}${text ? ` of "${clip(text, 80)}"` : ""}`, {
			item_id: itemId,
			played_ms: playedMs,
			total_ms: total,
		});
	}

	tool(name: string, args: string, output: string, ms: number): void {
		const failed = output.startsWith("error:");
		this.log("tool", `${name} ${args || "{}"} -> ${failed ? "FAILED" : "ok"} ${ms.toFixed(0)} ms: ${clip(output.replace(/\n/g, " | "), 300)}`);
		this.trace?.write("agent", { type: "agent.tool", name, arguments: args, output, ms: Math.round(ms), failed });
	}

	/** An event from the server. */
	server(event: Event): void {
		if (!skipped.has(event.type)) this.trace?.write("server", event);
		switch (event.type) {
			case "session.created":
				this.log("session", `#${this.session} created ${String((event.session as { id?: string })?.id ?? "")}`);
				break;
			case "conversation.item.added":
			case "conversation.item.created": {
				const item = event.item as Record<string, unknown>;
				const id = String(item.id);
				this.items.set(id, { id, type: String(item.type), role: item.role as string | undefined, text: itemText(item) });
				break;
			}
			case "conversation.item.done": {
				const item = event.item as Record<string, unknown>;
				const known = this.items.get(String(item.id));
				const text = itemText(item);
				if (known && text) known.text = text;
				break;
			}
			case "conversation.item.truncated": {
				const known = this.items.get(String(event.item_id));
				if (known) known.truncatedMs = Number(event.audio_end_ms);
				break;
			}
			case "conversation.item.deleted":
				this.items.delete(String(event.item_id));
				this.log("context", `item ${String(event.item_id)} deleted`);
				break;
			case "input_audio_buffer.speech_started": {
				const id = String(event.item_id);
				this.speechStart.set(id, Number(event.audio_start_ms));
				this.log("turn", `speech started at ${seconds(Number(event.audio_start_ms))} (${id})`);
				break;
			}
			case "input_audio_buffer.speech_stopped": {
				const id = String(event.item_id);
				const end = Number(event.audio_end_ms);
				const start = this.speechStart.get(id) ?? end;
				this.speechEndedAt = performance.now();
				let file: string | undefined;
				if (this.trace?.audio) file = this.trace.wav(`s${this.session}-${id}-user`, this.mic.slice(start, end));
				this.log("turn", `speech ${seconds(start)}–${seconds(end)} (${seconds(end - start)}, ${id})${file ? ` -> ${file}` : ""}`);
				if (file) this.trace?.write("agent", { type: "agent.audio", item_id: id, role: "user", file, start_ms: start, end_ms: end });
				break;
			}
			case "conversation.item.input_audio_transcription.completed": {
				const id = String(event.item_id);
				const text = String(event.transcript ?? "").trim();
				const known = this.items.get(id);
				if (known) known.text = text;
				this.log("heard", `${id}: ${text.replace(/\s*\n+\s*/g, " / ") || "(nothing)"}`);
				break;
			}
			case "conversation.item.input_audio_transcription.failed":
				this.log("heard", `${String(event.item_id)}: transcription failed: ${JSON.stringify(event.error)}`);
				break;
			case "response.created": {
				const response = event.response as Response;
				const id = String(response.id);
				this.responseStartedAt.set(id, performance.now());
				const items = [...this.items.values()];
				const count = (role: string) => items.filter((i) => (i.role ?? i.type) === role).length;
				this.log(
					"response",
					`${id} started; context ${items.length} items (user ${count("user")}, assistant ${count("assistant")}, calls ${count("function_call")}, results ${count("function_call_output")})`,
				);
				this.trace?.write("agent", {
					type: "agent.context",
					response_id: id,
					items: items.map((i) => ({ id: i.id, role: i.role ?? i.type, text: clip(i.text, 120), ...(i.truncatedMs !== undefined ? { truncated_ms: i.truncatedMs } : {}) })),
				});
				break;
			}
			case "response.output_audio.delta": {
				const id = String(event.item_id);
				let audio = this.spoken.get(id);
				if (audio === undefined) {
					audio = { bytes: 0, chunks: [], saved: false };
					this.spoken.set(id, audio);
					const latency = this.speechEndedAt > 0 ? `${(performance.now() - this.speechEndedAt).toFixed(0)} ms after the end of speech` : "without user speech";
					this.log("response", `first audio of ${id} ${latency}`);
					this.speechEndedAt = 0;
				}
				const bytes = Buffer.from(String(event.delta), "base64");
				audio.bytes += bytes.length;
				if (this.trace?.audio) audio.chunks.push(bytes);
				break;
			}
			case "response.output_audio.done":
				this.saveSpoken(String(event.item_id));
				break;
			case "response.output_audio_transcript.done":
			case "response.output_text.done": {
				const id = String(event.item_id);
				const text = String(event.transcript ?? event.text ?? "").trim();
				const known = this.items.get(id);
				if (known) known.text = text;
				this.log("answer", `${id}: ${text.replace(/\s*\n+\s*/g, " / ")}`);
				break;
			}
			case "response.function_call_arguments.done":
				this.log("call", `${String(event.name)} ${String(event.arguments ?? "")} (${String(event.call_id)})`);
				break;
			case "response.done": {
				const response = event.response as Response;
				const id = String(response.id);
				for (const item of response.output ?? []) if (item.id) this.saveSpoken(item.id);
				const started = this.responseStartedAt.get(id);
				this.responseStartedAt.delete(id);
				const took = started !== undefined ? ` in ${seconds(performance.now() - started)}` : "";
				const details = response.status === "completed" || response.status_details === undefined ? "" : ` ${JSON.stringify(response.status_details)}`;
				const usage = response.usage;
				const used = usage ? `; tokens in ${tokens(usage.input_tokens, usage.input_token_details)}, out ${tokens(usage.output_tokens, usage.output_token_details)}` : "";
				this.log("response", `${id} ${String(response.status)}${details}${took}${used}`);
				break;
			}
			case "error":
				this.log("realtime", `error: ${JSON.stringify(event.error)}`);
				break;
			default:
				break;
		}
	}

	private saveSpoken(itemId: string): void {
		const audio = this.spoken.get(itemId);
		if (!audio || audio.saved || !this.trace?.audio || audio.chunks.length === 0) return;
		audio.saved = true;
		const file = this.trace.wav(`s${this.session}-${itemId}-assistant`, Buffer.concat(audio.chunks));
		audio.chunks = [];
		if (file) this.trace.write("agent", { type: "agent.audio", item_id: itemId, role: "assistant", file, ms: Math.round(audio.bytes / 48) });
	}
}

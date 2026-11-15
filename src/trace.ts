// The trace: every Realtime event in both directions (audio payloads left out), the agent's own events
// (tool runs, interruptions, sessions), and optionally the audio of each turn, one directory per run.
//   <dir>/<run>/events.jsonl   one JSON object per line: { t, s (session), src, type, ... }
//   <dir>/<run>/audio/*.wav    what the model heard (user turns) and what it said, when audio = true
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TraceOptions = {
	/** Parent directory of the run directories. */
	dir: string;
	/** Also save the audio of each user turn and each spoken answer (WAV). */
	audio: boolean;
	/** Run directories older than this are deleted at start. */
	keepDays: number;
};

export class Trace {
	readonly dir: string;
	readonly audio: boolean;
	/** The current Realtime session number (0 before the first). */
	session = 0;
	private readonly file: string;

	constructor(options: TraceOptions, now = new Date()) {
		mkdirSync(options.dir, { recursive: true });
		prune(options.dir, options.keepDays, now);
		const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
		this.dir = join(options.dir, `${stamp}-${process.pid}`);
		mkdirSync(this.dir, { recursive: true });
		this.file = join(this.dir, "events.jsonl");
		this.audio = options.audio;
	}

	/** Appends one event; `src` is server, client (what we sent) or agent. */
	write(src: "server" | "client" | "agent", event: Record<string, unknown>): void {
		const line = JSON.stringify({ t: new Date().toISOString(), s: this.session, src, ...(redact(event) as Record<string, unknown>) });
		try {
			appendFileSync(this.file, `${line}\n`);
		} catch {
			// A full disk must not stop the conversation.
		}
	}

	/** Saves PCM16 24 kHz mono as audio/<name>.wav; returns the path relative to the run directory. */
	wav(name: string, pcm: Buffer): string | undefined {
		const relative = join("audio", `${name.replace(/[^\w.-]/g, "_")}.wav`);
		try {
			mkdirSync(join(this.dir, "audio"), { recursive: true });
			writeFileSync(join(this.dir, relative), wavFile(pcm));
			return relative;
		} catch {
			return undefined;
		}
	}
}

/** Replaces base64 audio (long `audio` or `delta` strings) with its size. */
export function redact(value: unknown, key = ""): unknown {
	if (typeof value === "string") {
		return (key === "audio" || key === "delta") && value.length > 200 ? `<${Math.floor((value.length * 3) / 4)} bytes>` : value;
	}
	if (Array.isArray(value)) return value.map((v) => redact(v));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
	}
	return value;
}

/** A WAV file of PCM16 mono samples. */
export function wavFile(pcm: Buffer, rate = 24000): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** Deletes run directories last modified more than `keepDays` ago. */
export function prune(dir: string, keepDays: number, now = new Date()): void {
	const limit = now.getTime() - keepDays * 86_400_000;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (stat.isDirectory() && stat.mtimeMs < limit) rmSync(path, { recursive: true, force: true });
		} catch {
			// Gone already.
		}
	}
}

/** The last `seconds` of the microphone stream, addressed by milliseconds since the session started. */
export class AudioRing {
	private chunks: { start: number; data: Buffer }[] = [];
	private total = 0;
	private readonly keepBytes: number;

	constructor(seconds = 120) {
		this.keepBytes = seconds * 48_000;
	}

	reset(): void {
		this.chunks = [];
		this.total = 0;
	}

	push(data: Buffer): void {
		this.chunks.push({ start: this.total, data });
		this.total += data.length;
		while (this.chunks.length > 0 && this.chunks[0].start + this.chunks[0].data.length < this.total - this.keepBytes) this.chunks.shift();
	}

	/** Milliseconds of audio pushed since the last reset. */
	get ms(): number {
		return this.total / 48;
	}

	/** PCM between two session times (ms), as far as it is still kept. */
	slice(startMs: number, endMs: number): Buffer {
		const from = Math.max(0, Math.floor(startMs * 24)) * 2;
		const to = Math.max(from, Math.floor(endMs * 24) * 2);
		const parts: Buffer[] = [];
		for (const { start, data } of this.chunks) {
			const end = start + data.length;
			if (end <= from || start >= to) continue;
			parts.push(data.subarray(Math.max(0, from - start), Math.min(data.length, to - start)));
		}
		return Buffer.concat(parts);
	}
}

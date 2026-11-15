import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { Diagnostics, tokens } from "../src/diagnostics.ts";
import { AudioRing, prune, redact, Trace, wavFile } from "../src/trace.ts";

const events = (trace: Trace) =>
	readFileSync(join(trace.dir, "events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

test("redact replaces base64 audio with its size", () => {
	const audio = "A".repeat(400);
	assert.deepEqual(redact({ type: "x", audio, item: { content: [{ delta: audio, text: "hi" }] } }), {
		type: "x",
		audio: "<300 bytes>",
		item: { content: [{ delta: "<300 bytes>", text: "hi" }] },
	});
	assert.deepEqual(redact({ delta: "短い" }), { delta: "短い" });
});

test("wavFile writes a PCM16 mono header", () => {
	const wav = wavFile(Buffer.alloc(480), 24000);
	assert.equal(wav.length, 44 + 480);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.readUInt32LE(24), 24000);
	assert.equal(wav.readUInt32LE(40), 480);
});

test("AudioRing slices by session milliseconds and forgets old audio", () => {
	const ring = new AudioRing(1);
	for (let i = 0; i < 30; i++) ring.push(Buffer.alloc(4800, i)); // 100 ms each
	assert.equal(ring.ms, 3000);
	const part = ring.slice(2850, 2950);
	assert.equal(part.length, 4800);
	assert.equal(part[0], 28);
	assert.equal(part[4799], 29);
	assert.equal(ring.slice(0, 500).length, 0);
});

test("prune deletes old run directories only", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-"));
	mkdirSync(join(dir, "old"));
	mkdirSync(join(dir, "new"));
	const old = new Date(Date.now() - 20 * 86_400_000);
	utimesSync(join(dir, "old"), old, old);
	prune(dir, 14);
	assert.deepEqual(readdirSync(dir), ["new"]);
});

test("tokens formats usage details", () => {
	assert.equal(tokens(120, { text_tokens: 20, audio_tokens: 100, cached_tokens: 64 }), "120 (text 20, audio 100, cached 64)");
	assert.equal(tokens(undefined, undefined), "?");
});

test("diagnostics trace a turn and log readable lines", () => {
	const trace = new Trace({ dir: mkdtempSync(join(tmpdir(), "trace-")), audio: true, keepDays: 14 });
	const lines: string[] = [];
	const d = new Diagnostics(trace, (scope, message) => lines.push(`[${scope}] ${message}`));
	d.connected(1, "m", "Hi\n\nThe conversation so far (from earlier sessions, UTC times):\na\nb\n");
	d.client({ type: "session.update", session: { instructions: "Hi" } });
	d.inputAudio(Buffer.alloc(48_000).toString("base64")); // 1 s
	d.client({ type: "input_audio_buffer.append", audio: "x" });
	d.server({ type: "input_audio_buffer.speech_started", audio_start_ms: 100, item_id: "u1" });
	d.server({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 900, item_id: "u1" });
	d.server({ type: "conversation.item.added", item: { id: "u1", type: "message", role: "user", content: [{ type: "input_audio", transcript: null }] } });
	d.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "一時停止して" });
	d.server({ type: "response.created", response: { id: "r1" } });
	d.server({ type: "conversation.item.added", item: { id: "a1", type: "message", role: "assistant", content: [] } });
	d.server({ type: "response.output_audio.delta", item_id: "a1", delta: Buffer.alloc(24_000).toString("base64") });
	d.server({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "止めたよ" });
	d.interrupted("a1", 200);
	d.server({ type: "response.done", response: { id: "r1", status: "cancelled", status_details: { reason: "turn_detected" }, output: [{ id: "a1" }], usage: { input_tokens: 10, output_tokens: 5 } } });
	d.tool("status", "{}", "error: no player", 12);

	assert.match(lines[0], /#1 connected \(m\); instructions \d+ chars, 2 remembered entries/);
	assert.ok(lines.includes("[heard] u1: 一時停止して"));
	assert.ok(lines.some((l) => /\[response\] r1 started; context 1 items \(user 1, assistant 0/.test(l)));
	assert.ok(lines.includes('[interrupt] a1: heard 0.2 s of 0.5 s of "止めたよ"'));
	assert.ok(lines.some((l) => /\[response\] r1 cancelled \{"reason":"turn_detected"\} in .*tokens in 10, out 5/.test(l)));
	assert.ok(lines.some((l) => l.startsWith("[tool] status {} -> FAILED 12 ms")));

	const traced = events(trace);
	const types = traced.map((e) => e.type);
	assert.ok(!types.includes("input_audio_buffer.append"));
	assert.ok(!types.includes("response.output_audio.delta"));
	assert.ok(types.includes("agent.context"));
	assert.ok(traced.every((e) => e.s === 1));
	const files = readdirSync(join(trace.dir, "audio")).sort();
	assert.deepEqual(files, ["s1-a1-assistant.wav", "s1-u1-user.wav"]);
	// 100–900 ms of the microphone: 800 ms of PCM16 24 kHz.
	assert.equal(readFileSync(join(trace.dir, "audio", "s1-u1-user.wav")).length, 44 + 800 * 48);
});

test("log config defaults", () => {
	const config = parseConfig("[log]\naudio = true\n");
	assert.equal(config.log.trace, true);
	assert.equal(config.log.audio, true);
	assert.equal(config.log.keepDays, 14);
	assert.match(config.log.dir, /Library\/Logs\/tvctl-agent\/traces$/);
});

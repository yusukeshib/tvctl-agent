import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildInstructions } from "../src/instructions.ts";
import { Memory } from "../src/memory.ts";
import { Notes } from "../src/notes.ts";
import { heardPart, Realtime } from "../src/realtime.ts";
import { createTools, playerState, runTool } from "../src/tools.ts";
import { judgeUtterance } from "../src/utterance.ts";

test("judgeUtterance drops noise and fillers, keeps requests", () => {
	for (const noise of ["안녕하세요.", "Başlı.", "beginner", "ええ。", "お。", "うん", "  ", "Agrađe."]) {
		assert.equal(judgeUtterance(noise, "ja").answer, false, noise);
	}
	for (const request of ["次の曲。", "ちょっと、YouTube止めて。", "これ何なん?", "play some lo-fi music", "止"]) {
		assert.equal(judgeUtterance(request, "ja").answer, true, request);
	}
	assert.equal(judgeUtterance("beginner", "en").answer, true);
});

test("heardPart keeps what was heard of an interrupted answer", () => {
	assert.equal(heardPart("止めたよ。", 1), "止めたよ。");
	assert.equal(heardPart("あいうえおかきくけこ", 0.3), "あいう…（ここで遮られた）");
	assert.equal(heardPart("あいうえお", 0), "");
});

test("notes are kept, numbered, deduplicated and removable", async () => {
	const notes = new Notes(join(mkdtempSync(join(tmpdir(), "notes-")), "notes.txt"));
	const tools = createTools(async () => ({ ok: true, stdout: "{}", stderr: "" }), "m", notes);
	assert.equal(await runTool(tools, "remember", '{"note":"返事は最小限にする"}'), "1. 返事は最小限にする");
	await runTool(tools, "remember", '{"note":"返事は最小限にする"}');
	assert.equal(await runTool(tools, "remember", '{"note":"ドラマは字幕付き"}'), "1. 返事は最小限にする\n2. ドラマは字幕付き");
	assert.equal(await runTool(tools, "forget", '{"number":1}'), "1. ドラマは字幕付き");
	assert.equal(await runTool(tools, "forget", '{"number":5}'), "error: no note 5");
	assert.match(buildInstructions("", undefined, notes.list()), /The user's notes \(always follow them\):\n1\. ドラマは字幕付き/);
});

test("playerState leaves out the position", async () => {
	const status = JSON.stringify({ service: "spotify", player: { title: "結び", state: "playing", current_time: 12, duration: 200, volume: 50, subtitles: null } });
	assert.equal(await playerState(async () => ({ ok: true, stdout: status, stderr: "" })), 'spotify: "結び"; playing; volume 50; subtitles off');
	assert.equal(await playerState(async () => ({ ok: false, stdout: "", stderr: "error: no player is open" })), "no player is open");
});

/** A Realtime session on a fake socket: returns what it sent. */
function session(state: () => string) {
	const dir = mkdtempSync(join(tmpdir(), "rt-"));
	const memory = new Memory(join(dir, "conversation.jsonl"));
	const sent: Record<string, unknown>[] = [];
	const rt = new Realtime(
		{
			model: "m",
			voice: "v",
			eagerness: "auto",
			noiseReduction: "near_field",
			transcribeModel: "t",
			language: "ja",
			instructions: () => "",
			tools: [],
			memory,
			playerState: async () => state(),
		},
		{ audio() {}, end() {}, stop() {} },
	);
	const internal = rt as unknown as { ws: unknown; handle(e: Record<string, unknown>): void };
	internal.ws = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data) as Record<string, unknown>), close() {} };
	const memoryLines = () =>
		readFileSync(join(dir, "conversation.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as { role: string; text: string }).text);
	return { rt, sent, handle: (e: Record<string, unknown>) => internal.handle(e), memoryLines };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a meant turn gets the player state (when changed) and a response; noise gets nothing", async () => {
	let state = 'spotify: "結び"; playing';
	const s = session(() => state);
	s.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "u0", transcript: "안녕하세요." });
	await tick();
	assert.equal(s.sent.length, 0);

	s.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "次の曲。" });
	await tick();
	assert.deepEqual(
		s.sent.map((e) => e.type),
		["conversation.item.create", "response.create"],
	);
	assert.equal(((s.sent[0].item as { content: { text: string }[] }).content[0]).text, 'Player now: spotify: "結び"; playing');

	// Same state: no repeat. A turn while a response runs waits for it.
	s.sent.length = 0;
	s.handle({ type: "response.created", response: { id: "r1" } });
	s.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "やっぱり止めて" });
	await tick();
	assert.equal(s.sent.length, 0);
	s.handle({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
	await tick();
	await tick();
	assert.deepEqual(s.sent.map((e) => e.type), ["response.create"]);

	state = "no player is open";
	s.sent.length = 0;
	s.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "u3", transcript: "何か流して" });
	await tick();
	assert.deepEqual(s.sent.map((e) => e.type), ["conversation.item.create", "response.create"]);
	assert.deepEqual(s.memoryLines(), ["次の曲。", "やっぱり止めて", "何か流して"]);
	s.rt.close();
});

test("an interrupted answer is remembered only as far as it was heard", async () => {
	const s = session(() => "x");
	const audio = Buffer.alloc(48_000).toString("base64"); // 1 s
	s.handle({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: audio });
	s.handle({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "あいうえおかきくけこ" });
	s.rt.stopped("a1", 300);
	s.handle({ type: "response.output_audio.delta", item_id: "a2", content_index: 0, delta: audio });
	s.rt.spoken("a2");
	s.handle({ type: "response.output_audio_transcript.done", item_id: "a2", transcript: "止めたよ。" });
	assert.deepEqual(s.memoryLines(), ["あいう…（ここで遮られた）", "止めたよ。"]);
	s.rt.close();
});

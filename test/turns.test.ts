import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildInstructions } from "../src/instructions.ts";
import { Memory } from "../src/memory.ts";
import { Notes } from "../src/notes.ts";
import { heardPart, Realtime } from "../src/realtime.ts";
import { createTools, playerState, runTool, type Tool } from "../src/tools.ts";
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

type Sent = Record<string, unknown>;

/** A Realtime session on a fake socket: returns what it sent. */
function session(state: () => Promise<string> | string, tools: Tool[] = [], instructions = () => "") {
	const dir = mkdtempSync(join(tmpdir(), "rt-"));
	const memory = new Memory(join(dir, "conversation.jsonl"));
	const sent: Sent[] = [];
	const rt = new Realtime(
		{
			model: "m",
			voice: "v",
			eagerness: "auto",
			noiseReduction: "near_field",
			transcribeModel: "t",
			language: "ja",
			instructions,
			tools,
			memory,
			playerState: async () => state(),
		},
		{ audio() {}, end() {}, stop() {} },
	);
	const internal = rt as unknown as { ws: unknown; handle(e: Sent): void; startSession(): void };
	internal.ws = { readyState: WebSocket.OPEN, send: (data: string) => sent.push(JSON.parse(data) as Sent), close() {} };
	const memoryLines = () =>
		readFileSync(join(dir, "conversation.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as { role: string; text: string }).text);
	const types = () => sent.map((e) => String(e.type));
	return { rt, sent, types, handle: (e: Sent) => internal.handle(e), newSession: () => internal.startSession(), memoryLines };
}

const tick = async (n = 3) => {
	for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};
const turn = (id: string, transcript: string) => ({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });

test("noise is deleted from the conversation and gets no response", async () => {
	const s = session(() => "x");
	s.handle(turn("u0", "안녕하세요."));
	await tick();
	assert.deepEqual(s.sent, [{ type: "conversation.item.delete", item_id: "u0" }]);
	s.rt.close();
});

test("a meant turn gets the player state (when changed) and one response; turns meanwhile are queued once", async () => {
	let state = 'spotify: "結び"; playing';
	const s = session(() => state);
	s.handle(turn("u1", "次の曲。"));
	// Arrives while the player state is looked up: the coming response includes it.
	s.handle(turn("u2", "やっぱり止めて"));
	await tick();
	assert.deepEqual(s.types(), ["conversation.item.create", "response.create"]);
	assert.equal((s.sent[0].item as { content: { text: string }[] }).content[0].text, 'Player now: spotify: "結び"; playing');
	s.handle({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
	await tick();
	assert.deepEqual(s.types(), ["conversation.item.create", "response.create"]);

	// A turn during a response waits for it; the same state is not repeated.
	s.sent.length = 0;
	s.handle(turn("u3", "音量下げて"));
	await tick();
	s.handle({ type: "response.created", response: { id: "r2" } });
	s.handle(turn("u4", "もうちょっと"));
	await tick();
	assert.deepEqual(s.types(), ["response.create"]);
	s.handle({ type: "response.done", response: { id: "r2", status: "completed", output: [] } });
	await tick();
	assert.deepEqual(s.types(), ["response.create", "response.create"]);

	state = "no player is open";
	s.sent.length = 0;
	s.handle({ type: "response.done", response: { id: "r3", status: "completed", output: [] } });
	s.handle(turn("u5", "何か流して"));
	await tick();
	assert.deepEqual(s.types(), ["conversation.item.create", "response.create"]);
	assert.deepEqual(s.memoryLines(), ["次の曲。", "やっぱり止めて", "音量下げて", "もうちょっと", "何か流して"]);
	s.rt.close();
});

test("tool results continue through a fresh player state, refresh changed instructions, and absorb queued turns", async () => {
	let state = "paused";
	let notes = "none";
	const tool: Tool = {
		name: "remember",
		description: "",
		parameters: {},
		changesInstructions: true,
		run: async () => {
			notes = "1. 返事は最小限";
			state = "playing";
			return notes;
		},
	};
	const s = session(() => state, [tool], () => `notes: ${notes}`);
	s.handle(turn("u1", "返事は最小限にして"));
	await tick();
	s.handle({ type: "response.created", response: { id: "r1" } });
	s.sent.length = 0;
	s.handle({ type: "response.done", response: { id: "r1", status: "completed", output: [{ type: "function_call", name: "remember", call_id: "c1", arguments: "{}" }] } });
	s.handle(turn("u2", "あと字幕も")); // during the tool run
	await tick(6);
	assert.deepEqual(s.types(), ["conversation.item.create", "session.update", "conversation.item.create", "response.create"]);
	assert.equal((s.sent[1].session as { instructions: string }).instructions, "notes: 1. 返事は最小限");
	assert.equal((s.sent[2].item as { content: { text: string }[] }).content[0].text, "Player now: playing");
	s.handle({ type: "response.done", response: { id: "r2", status: "completed", output: [] } });
	await tick();
	assert.equal(s.types().filter((t) => t === "response.create").length, 1);
	s.rt.close();
});

test("a new session starts idle even if the old one dropped mid-response", async () => {
	const s = session(() => "x");
	s.handle(turn("u1", "次の曲"));
	await tick();
	s.newSession(); // the socket closed before response.done
	s.sent.length = 0;
	s.handle(turn("u2", "止めて"));
	await tick();
	assert.deepEqual(s.types(), ["conversation.item.create", "response.create"]);
	s.rt.close();
});

test("an interrupted answer is remembered only as far as it was heard, counting audio that arrived later", async () => {
	const s = session(() => "x");
	const half = Buffer.alloc(24_000).toString("base64"); // 0.5 s
	s.handle({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: half });
	s.rt.stopped("a1", 300);
	// Not played, but it makes the answer 1 s long.
	s.handle({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: half });
	s.handle({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "あいうえおかきくけこ" });
	s.handle({ type: "response.done", response: { id: "r1", status: "cancelled", output: [{ type: "message", id: "a1" }] } });
	s.handle({ type: "response.output_audio.delta", item_id: "a2", content_index: 0, delta: half });
	s.handle({ type: "response.output_audio.done", item_id: "a2" });
	s.rt.spoken("a2");
	s.handle({ type: "response.output_audio_transcript.done", item_id: "a2", transcript: "止めたよ。" });
	assert.deepEqual(s.memoryLines(), ["あいう…（ここで遮られた）", "止めたよ。"]);
	s.rt.close();
});

test("notes read errors other than a missing file are not treated as no notes", () => {
	const dir = mkdtempSync(join(tmpdir(), "notes-"));
	const notes = new Notes(dir); // a directory: reading fails with EISDIR
	assert.throws(() => notes.add("x"));
	assert.deepEqual(new Notes(join(dir, "missing.txt")).list(), []);
});

test("script heuristics apply to Japanese only", () => {
	assert.equal(judgeUtterance("안녕하세요, 볼륨 낮춰 줘", "ko").answer, true);
	assert.equal(judgeUtterance("안녕하세요.", "ja").answer, false);
});

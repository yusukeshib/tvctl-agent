import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { condense, condenseSearch } from "../src/tvctl.ts";
import { UtteranceAssembler, type VoiceEvent } from "../src/voice.ts";

const ev = (type: string, t: number, fields: Record<string, unknown> = {}): VoiceEvent => ({ type, t, ...fields });

test("an utterance is the finals between speech_start and its finalized", () => {
	const a = new UtteranceAssembler();
	assert.equal(a.push(ev("speech_start", 0, { utterance: 1 })), undefined);
	assert.equal(a.push(ev("final", 900, { text: "30秒" })), undefined);
	assert.equal(a.push(ev("final", 1000, { text: "戻して。" })), undefined);
	assert.deepEqual(a.push(ev("finalized", 1100, { utterance: 1 })), { text: "30秒 戻して。", startedAt: 0, finalAt: 1100 });
});

test("a transcript arriving just after finalized still completes the utterance", () => {
	const a = new UtteranceAssembler();
	a.push(ev("speech_start", 0, { utterance: 1 }));
	assert.equal(a.push(ev("finalized", 900, { utterance: 1 })), undefined);
	assert.equal(a.waiting, true);
	assert.equal(a.push(ev("final", 901, { text: "どういうこと？" }))?.text, "どういうこと？");
	assert.equal(a.waiting, false);
});

test("transcripts heard without speech (a muted mic) are dropped", () => {
	const a = new UtteranceAssembler();
	assert.equal(a.push(ev("final", 500, { text: "あ" })), undefined);
	a.push(ev("speech_start", 600, { utterance: 1 }));
	assert.equal(a.push(ev("finalized", 900, { utterance: 1 })), undefined);
});

test("a stale finalized does not end a newer utterance", () => {
	const a = new UtteranceAssembler();
	a.push(ev("speech_start", 0, { utterance: 1 }));
	a.push(ev("speech_start", 400, { utterance: 2 }));
	a.push(ev("final", 500, { text: "止めて" }));
	assert.equal(a.push(ev("finalized", 600, { utterance: 1 })), undefined);
	assert.equal(a.push(ev("finalized", 700, { utterance: 2 }))?.text, "止めて");
});

test("condense summarizes tvctl status", () => {
	const line = condense(
		JSON.stringify({
			service: "youtube",
			player: { title: "Me at the zoo", author: "jawed", state: "paused", current_time: 5.2, duration: 19, volume: 30, muted: false, subtitles: null, playback_rate: 1 },
			window: { fullscreen: true },
		}),
	);
	assert.equal(line, 'youtube: "Me at the zoo" by jawed; paused 0:05/0:19; volume 30; subtitles off; fullscreen');
});

test("condenseSearch lists results one per line", () => {
	const out = condenseSearch(
		JSON.stringify({
			results: [
				{ kind: "video", title: "News", url: "https://y/1", channel: "NTV", live: true, duration: null },
				{ kind: "track", title: "First Love", url: "https://s/2", by: "Hikaru Utada" },
			],
		}),
	);
	assert.equal(out, "1. [video] News (NTV, LIVE now) https://y/1\n2. [track] First Love (Hikaru Utada) https://s/2");
	assert.equal(condenseSearch('{"results":[]}'), "no results");
});

test("config defaults and overrides", () => {
	const empty = parseConfig("");
	assert.equal(empty.model.main, "anthropic/claude-haiku-5-5");
	assert.equal(empty.audio.endSilenceMs, 350);
	const custom = parseConfig('[audio]\ndevice = "USB Mic"\n[model]\nmain = "openai/gpt-6-luna"\nthinking = "minimal"\n');
	assert.equal(custom.audio.device, "USB Mic");
	assert.equal(custom.model.thinking, "minimal");
	assert.throws(() => parseConfig('[model]\nthinking = "huge"\n'));
});

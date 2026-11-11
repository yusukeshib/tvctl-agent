import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { condense, condenseSearch } from "../src/tvctl.ts";
import { isSpeech } from "../src/voice.ts";

test("cloud transcripts of silence are not speech", () => {
	assert.equal(isSpeech("ご視聴ありがとうございました。"), false);
	assert.equal(isSpeech(" "), false);
	assert.equal(isSpeech("止めて"), true);
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

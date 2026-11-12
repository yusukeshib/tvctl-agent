import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { formatRecent } from "../src/memory.ts";
import { condense, condenseSearch, createTools, runTool } from "../src/tools.ts";

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
	assert.equal(empty.realtime.model, "gpt-realtime-2.1");
	assert.equal(empty.speech.duckLevel, 10);
	// Keys of older versions are ignored.
	const custom = parseConfig('[realtime]\nvoice = "cedar"\neagerness = "low"\n[audio]\nend_silence_ms = 350\n');
	assert.equal(custom.realtime.voice, "cedar");
	assert.equal(custom.realtime.eagerness, "low");
	assert.throws(() => parseConfig('[realtime]\neagerness = "huge"\n'));
});

test("formatRecent keeps the latest entries within the budget", () => {
	const lines = [1, 2, 3].map((i) => JSON.stringify({ date: `2026-11-12T01:0${i}:00.000Z`, role: "user", text: `t${i}` }));
	assert.equal(formatRecent([...lines, ""], 1000), "2026-11-12 01:01 user: t1\n2026-11-12 01:02 user: t2\n2026-11-12 01:03 user: t3");
	assert.equal(formatRecent(lines, 30), "2026-11-12 01:03 user: t3");
});

test("tools map to tvctl argv and report errors", async () => {
	const calls: string[][] = [];
	const tools = createTools(async (args) => {
		calls.push(args);
		return args[0] === "open" ? { ok: false, stdout: "", stderr: "error: not logged in" } : { ok: true, stdout: '{"results":[]}', stderr: "" };
	}, "m");
	assert.equal(await runTool(tools, "search_media", '{"service":"spotify","query":"宇多田ヒカル","kind":"album"}'), "no results");
	assert.deepEqual(calls[0], ["search", "spotify", "宇多田ヒカル", "--limit", "5", "--kind", "album"]);
	await runTool(tools, "seek", '{"position":"+5m"}');
	assert.deepEqual(calls[1], ["forward", "5m"]);
	assert.equal(await runTool(tools, "play", '{"url":"https://x"}'), "error: not logged in");
	assert.equal(await runTool(tools, "nope", "{}"), "error: unknown tool nope");
});

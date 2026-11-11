import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message, Models, SystemMessage } from "@earendil-works/pi-ai";
import { zoom } from "../src/optchat/extension.ts";
import { foldSystem, lastWholeBlock, markView, OptChat, viewBlocks } from "../src/optchat/index.ts";
import { clip, itemsOf } from "../src/optchat/log.ts";

const ts = 1_700_000_000_000;

function chat() {
	const dir = mkdtempSync(join(tmpdir(), "optchat-"));
	return new OptChat({
		path: join(dir, "optchat.sqlite"),
		models: {} as Models,
		compactor: { api: "anthropic-messages" } as never,
		reasoning: "low",
		limits: { viewMax: 128_000, viewMin: 64_000, cviewMax: 32_000, cviewMin: 16_000 },
	});
}

test("log items: user words, replies, tool calls and results; no thoughts", () => {
	const messages = [
		{ role: "user", content: "止めて", timestamp: ts },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "secret" },
				{ type: "toolCall", id: "1", name: "playback", arguments: { action: "pause" } },
			],
			timestamp: ts,
		},
		{ role: "toolResult", toolCallId: "1", toolName: "playback", content: [{ type: "text", text: "paused" }], isError: false, timestamp: ts },
		{ role: "assistant", content: [{ type: "text", text: "一時停止しました" }], timestamp: ts },
	] as unknown as Message[];
	assert.deepEqual(
		messages.flatMap(itemsOf).map((m) => `${m.kind}: ${m.text}`),
		["user: 止めて", 'tool: playback {"action":"pause"}', "echo: paused", "remo: 一時停止しました"],
	);
	assert.equal(clip("x".repeat(40_000)).length < 30_100, true);
});

test("short messages are their own nodes; short pairs join; the view renders and zooms", () => {
	const c = chat();
	c.ingest([{ role: "user", content: "止めて", timestamp: ts } as Message], 1);
	c.ingest([{ role: "assistant", content: [{ type: "text", text: "一時停止しました" }], timestamp: ts } as unknown as Message], 2);
	assert.equal(c.summarized(), true);
	assert.deepEqual(c.viewLines(), ["0+1|user: 止めて", "1+1|remo: 一時停止しました"]);
	assert.equal(c.store.node([1, 0]), "user: 止めて\nremo: 一時停止しました");
	assert.equal(zoom(c, "0", 2), "0+1|user: 止めて\n1+1|remo: 一時停止しました");
	assert.match(zoom(c, "1", 1), /^1 remo:\n一時停止しました$/);
	assert.match(zoom(c, "1", 2), /Bad line/);
	assert.match(zoom(c, "Name", 1), /no subagents/);
	assert.equal(c.cursor, 2);
});

test("a long message waits for its compaction and shows a placeholder", () => {
	const c = chat();
	c.ingest([{ role: "user", content: "あ".repeat(400), timestamp: ts } as Message], 1);
	assert.equal(c.summarized(), false);
	assert.match(c.viewLines()[0], /^0\+1\|\(not summarized yet: zoom it\)$/);
});

test("turn messages: one folded system message, then the view before the run's first message", () => {
	const c = chat();
	c.ingest([{ role: "user", content: "前のメッセージ", timestamp: ts } as Message], 1);
	const tool = (name: string) => ({ name, description: name, parameters: {} });
	const messages = [
		{ role: "system", content: "", sections: { a: "A" }, toolsAdded: [tool("x"), tool("y")], timestamp: ts },
		{ role: "user", content: "前のメッセージ", timestamp: ts },
		{ role: "system", content: "", toolsRemoved: [{ name: "x" }, { name: "y" }], toolsAdded: [tool("x"), tool("y"), tool("zoom")], sections: { a: null, b: "B" }, timestamp: ts },
		{ role: "user", content: "今の命令", timestamp: ts },
	] as unknown as Message[];
	const out = c.turnMessages(messages, 1, new Date(ts));
	assert.equal(out.length, 2);
	const system = out[0] as SystemMessage;
	assert.deepEqual(system.sections, { b: "B" });
	assert.deepEqual(system.toolsAdded?.map((t) => t.name), ["x", "y", "zoom"]);
	const content = (out[1] as { content: { text: string }[] }).content.map((b) => b.text);
	assert.equal(content[0], "<chat>");
	assert.equal(content[1], "0+1|user: 前のメッセージ");
	assert.equal(content[2], "</chat>");
	assert.match(content[3], /^Now: /);
	assert.equal(content[4], "今の命令");
	assert.deepEqual(foldSystem([]).content, "");
});

test("cache mark goes on the last whole 4-line view block, replacing the redundant tools mark", () => {
	const lines = Array.from({ length: 10 }, (_, i) => `${i}+1|user: ${i}`);
	const blocks = viewBlocks(lines);
	assert.equal(lastWholeBlock(blocks), 2);
	const payload = {
		system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }],
		tools: [{ name: "t", cache_control: { type: "ephemeral", ttl: "1h" } }],
		messages: [
			{
				role: "user",
				content: [...blocks, { type: "text", text: "go", cache_control: { type: "ephemeral", ttl: "1h" } }],
			},
		],
	};
	payload.system.push({ type: "text", text: "s2", cache_control: { type: "ephemeral", ttl: "1h" } });
	const { prefix } = markView(payload);
	assert.ok(prefix);
	assert.equal(payload.tools[0].cache_control, undefined);
	assert.deepEqual((payload.messages[0].content[2] as { cache_control?: unknown }).cache_control, { type: "ephemeral", ttl: "1h" });
	assert.equal(lastWholeBlock(viewBlocks(lines.slice(0, 3))), -1);
});

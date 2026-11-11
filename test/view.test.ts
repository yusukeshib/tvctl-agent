import assert from "node:assert/strict";
import { test } from "node:test";
import { line, type NodeRef, pushView, shrink, type ViewState } from "../src/optchat/view.ts";

test("push example from the spec", () => {
	assert.deepEqual(pushView(9), [
		[2, 0],
		[2, 1],
		[1, 4],
	]);
});

test("due-ordered batches pick exactly push's merges (budget = push length)", () => {
	const state: ViewState = { nodes: [], shrinking: false };
	for (let t = 0; t <= 4000; t++) {
		state.nodes.push([0, t]);
		const budget = pushView(t).length;
		shrink(state, t + 1, () => true, () => 1, { max: budget, min: budget });
		assert.deepEqual(state.nodes, pushView(t), `t=${t}`);
	}
});

test("sawtooth: merges only past max, down to min, and only built parents", () => {
	const state: ViewState = { nodes: [], shrinking: false };
	const sizes: number[] = [];
	for (let t = 0; t < 400; t++) {
		state.nodes.push([0, t]);
		shrink(state, t + 1, () => true, () => 10, { max: 1000, min: 500 });
		sizes.push(state.nodes.length * 10);
	}
	assert.ok(Math.max(...sizes) <= 1000);
	assert.ok(sizes.some((s) => s <= 500));
	// Nothing built: no merges, the batch stays pending.
	const stuck: ViewState = { nodes: Array.from({ length: 20 }, (_, i): NodeRef => [0, i]), shrinking: false };
	assert.equal(shrink(stuck, 20, () => false, () => 10, { max: 100, min: 50 }), false);
	assert.equal(stuck.shrinking, true);
});

test("view lines", () => {
	assert.equal(line([3, 5], "a\nb"), "40+8|a b");
	assert.equal(line([0, 7], undefined), "7+1|(not summarized yet: zoom it)");
});

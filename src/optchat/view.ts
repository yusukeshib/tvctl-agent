// The view (spec §3): a list of tree nodes covering the whole chat, oldest first, merged in batches
// (a sawtooth between `min` and `max` bytes) in the order of Taelin's rollback push.

/** A tree node: level l covers the 2^l messages from i·2^l on. */
export type NodeRef = readonly [l: number, i: number];

export const LIMIT = 512;
export const PLACEHOLDER = "(not summarized yet: zoom it)";

export const start = ([l, i]: NodeRef) => i * 2 ** l;
export const count = ([l]: NodeRef) => 2 ** l;
export const last = (n: NodeRef) => start(n) + count(n) - 1;
export const key = ([l, i]: NodeRef) => `${l}:${i}`;

export const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** One view line: `id+n|text`, newlines as spaces. */
export function line(n: NodeRef, text: string | undefined): string {
	return `${start(n)}+${count(n)}|${(text ?? PLACEHOLDER).replace(/\r?\n/g, " ")}`;
}

export type ViewState = {
	nodes: NodeRef[];
	/** A batch is under way: keep merging at each new message until at most `min`. */
	shrinking: boolean;
};

export type NodeText = (n: NodeRef) => string | undefined;

/** Bytes of a node's view line, with its newline. */
export const lineSize = (text: NodeText) => (n: NodeRef) => bytes(line(n, text(n))) + 1;

export function size(view: readonly NodeRef[], measure: (n: NodeRef) => number): number {
	let total = 0;
	for (const n of view) total += measure(n);
	return total;
}

/** Appends message i's line. */
export function append(state: ViewState, i: number): void {
	state.nodes.push([0, i]);
}

/**
 * Merges the most due sibling pairs whose parent is built until the view is at most `min` bytes, once it
 * passed `max` (or when `force`). due = (T - last) / 2^l, ties to the oldest pair. Returns whether it merged.
 */
export function shrink(
	state: ViewState,
	total: number,
	built: (n: NodeRef) => boolean,
	measure: (n: NodeRef) => number,
	limits: { max: number; min: number },
	force = false,
): boolean {
	let current = size(state.nodes, measure);
	if (current > limits.max || force) state.shrinking = true;
	if (!state.shrinking) return false;
	let merged = false;
	while (current > limits.min) {
		let best = -1;
		let bestDue = -Infinity;
		for (let k = 0; k + 1 < state.nodes.length; k++) {
			const [l, i] = state.nodes[k];
			const [l2, i2] = state.nodes[k + 1];
			if (l !== l2 || i % 2 !== 0 || i2 !== i + 1) continue;
			const parent: NodeRef = [l + 1, i / 2];
			if (!built(parent)) continue;
			const due = (total - last(parent)) / 2 ** l;
			if (due > bestDue) {
				bestDue = due;
				best = k;
			}
		}
		if (best < 0) return merged;
		const [l, i] = state.nodes[best];
		const parent: NodeRef = [l + 1, i / 2];
		current += measure(parent) - measure(state.nodes[best]) - measure(state.nodes[best + 1]);
		state.nodes.splice(best, 2, parent);
		merged = true;
	}
	state.shrinking = false;
	return merged;
}

/** Taelin's push (spec §3.1), newest first; returns the states as view nodes, oldest first. */
export function pushView(t: number): NodeRef[] {
	type List = { keep: number; state: number; older: List | null } | null;
	const push = (s: number, list: List): List => {
		if (list === null) return { keep: 0, state: s, older: null };
		if (list.keep === 0) return { keep: 1, state: list.state, older: list.older };
		return { keep: 0, state: s, older: push(list.state, list.older) };
	};
	let list: List = null;
	for (let s = 0; s <= t; s++) list = push(s, list);
	const starts: number[] = [];
	for (let x = list; x !== null; x = x.older) starts.push(x.state);
	starts.reverse();
	const out: NodeRef[] = [];
	for (let k = 0; k < starts.length; k++) {
		const n = (k + 1 < starts.length ? starts[k + 1] : t + 1) - starts[k];
		const l = Math.log2(n);
		out.push([l, starts[k] / n]);
	}
	return out;
}

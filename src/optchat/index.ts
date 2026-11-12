// OptChat (the OptChat spec, https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one chat that never ends. The log and the tree live in the Store; this
// class ingests the conversation's messages, builds tree nodes in the background (compactions), keeps the
// chat view and the compaction view, and gives each turn [system] [view] [message].
import { createHash } from "node:crypto";
import type { Api, AssistantMessage, Message, Model, Models, SystemMessage, TextContent } from "@earendil-works/pi-ai";
import { log } from "../log.ts";
import { itemsOf } from "./log.ts";
import { leafTask, mergeTask, optchatPrompt, tooLong } from "./prompt.ts";
import { Store } from "./store.ts";
import {
	append,
	bytes,
	count,
	key,
	LIMIT,
	last,
	line,
	lineSize,
	type NodeRef,
	shrink,
	start,
	type ViewState,
} from "./view.ts";

export type Limits = { viewMax: number; viewMin: number; cviewMax: number; cviewMin: number };

export type OptChatOptions = {
	path: string;
	models: Models;
	compactor: Model<Api>;
	reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	limits: Limits;
	concurrency?: number;
};

const LINES_PER_BLOCK = 4;
const CHAT_OPEN = "<chat>";
const CHAT_CLOSE = "</chat>";

type Block = TextContent;

/** The view as text blocks of 4 lines, between `<chat>` and `</chat>` blocks (spec §3.3). */
export function viewBlocks(lines: readonly string[]): Block[] {
	const blocks: Block[] = [{ type: "text", text: CHAT_OPEN }];
	for (let k = 0; k < lines.length; k += LINES_PER_BLOCK) {
		blocks.push({ type: "text", text: lines.slice(k, k + LINES_PER_BLOCK).join("\n") });
	}
	blocks.push({ type: "text", text: CHAT_CLOSE });
	return blocks;
}

/** Index of the last whole 4-line view block in `content`, or -1. */
export function lastWholeBlock(content: readonly { type?: string; text?: string }[]): number {
	const close = content.findIndex((b) => b.type === "text" && b.text === CHAT_CLOSE);
	for (let k = close - 1; k > 0; k--) {
		const text = content[k].text ?? "";
		if (text === CHAT_OPEN) return -1;
		if (text.split("\n").length === LINES_PER_BLOCK) return k;
	}
	return -1;
}

/** Puts a cache mark on the last whole view block of an Anthropic Messages payload's first user message. */
export function markView(payload: unknown): { payload: unknown; prefix?: string } {
	const body = payload as { messages?: { role: string; content: unknown }[]; system?: unknown; tools?: unknown };
	const first = body.messages?.find((m) => m.role === "user");
	if (first === undefined || !Array.isArray(first.content)) return { payload };
	const content = first.content as { type?: string; text?: string; cache_control?: unknown }[];
	const k = lastWholeBlock(content);
	if (k < 0) return { payload };
	const json = JSON.stringify(payload);
	let marks = json.split('"cache_control"').length - 1;
	// Anthropic allows 4 marks. A mark on the tools is redundant with one on the system prompt after them:
	// give it to the view.
	const tools = (body.tools ?? []) as { cache_control?: unknown }[];
	const system = Array.isArray(body.system) ? (body.system as { cache_control?: unknown }[]) : [];
	if (marks >= 4 && system.some((b) => b.cache_control !== undefined)) {
		for (const tool of tools) {
			if (tool.cache_control !== undefined) {
				delete tool.cache_control;
				marks--;
			}
		}
	}
	// Marks must keep the lifetime of the provider's own (a subscription marks with 1 hour).
	const ttl = /"ttl":"1h"/.test(json) ? { ttl: "1h" } : {};
	if (marks < 4 && content[k].cache_control === undefined) content[k].cache_control = { type: "ephemeral", ...ttl };
	const prefix = createHash("sha256")
		.update(JSON.stringify([body.system, body.tools, content.slice(0, k + 1)]))
		.digest("hex");
	return { payload, prefix };
}

/**
 * Replays system messages into one leading message: later ones add instructions, replace or remove
 * sections by name, and add or remove tools (pi-ai `SystemMessage`).
 */
export function foldSystem(messages: readonly SystemMessage[]): SystemMessage {
	const text = (c: SystemMessage["content"]) => (typeof c === "string" ? c : c.map((b) => b.text).join(""));
	const parts: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, NonNullable<SystemMessage["toolsAdded"]>[number]>();
	for (const m of messages) {
		const t = text(m.content);
		if (t !== "") parts.push(t);
		for (const [name, value] of Object.entries(m.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const ref of m.toolsRemoved ?? []) tools.delete(ref.name);
		for (const tool of m.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return {
		role: "system",
		content: parts.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.size > 0 ? { toolsAdded: [...tools.values()] } : {}),
		timestamp: messages[0]?.timestamp ?? 0,
	};
}

function headBytes(text: string, n: number): string {
	return Buffer.from(text).subarray(0, n).toString("utf8").replace(/\uFFFD+$/, "");
}

export class OptChat {
	readonly store: Store;
	private readonly options: OptChatOptions;
	private readonly view: ViewState;
	private readonly cview: ViewState;
	/** Unbuilt leaves, oldest first. */
	private pendingLeaves: number[] = [];
	/** Merges whose halves are built. */
	private readyMerges: NodeRef[] = [];
	private readonly inFlight = new Set<string>();
	private readonly failed = new Set<string>();
	private readonly waiters = new Set<() => void>();
	/** Prefixes being written to the cache: later calls on the same prefix wait until the response starts. */
	private readonly writers = new Map<string, Promise<void>>();
	private system: SystemMessage[];

	constructor(options: OptChatOptions) {
		this.options = options;
		this.store = new Store(options.path);
		this.view = this.store.view("view") ?? { nodes: [], shrinking: false };
		this.cview = this.store.view("cview") ?? { nodes: [], shrinking: false };
		this.system = this.store.get<SystemMessage[]>("system") ?? [
			{ role: "system", content: optchatPrompt, timestamp: 0 },
		];
		// One scan at start; afterwards work is queued as it becomes ready.
		for (let i = 0; i < this.store.total; i++) if (!this.built([0, i])) this.pendingLeaves.push(i);
		for (let i = 0; i < this.store.total; i++) this.enqueueParents([0, i]);
	}

	get cursor(): number | undefined {
		return this.store.get<number>("cursor");
	}

	private text = (n: NodeRef) => this.store.node(n);
	private built = (n: NodeRef) => this.store.node(n) !== undefined;
	private measure = lineSize(this.text);

	/** Appends model messages (from entries up to `cursor`) to the log, and starts their compactions. */
	ingest(messages: readonly Message[], cursor: number): void {
		const items = messages.flatMap(itemsOf);
		const added = this.store.append(items, cursor);
		for (const m of added) {
			append(this.view, m.i);
			append(this.cview, m.i);
			const leaf = `${m.kind}: ${m.text}`;
			if (bytes(leaf) <= LIMIT) this.done([0, m.i], leaf);
			else this.pendingLeaves.push(m.i);
		}
		if (added.length > 0) this.reshape();
		this.kick();
	}

	/** Batches the views (spec §3.2, §4): the compaction view merges again whenever the chat view does. */
	private reshape(): void {
		const T = this.store.total;
		const merged = shrink(this.view, T, this.built, this.measure, {
			max: this.options.limits.viewMax,
			min: this.options.limits.viewMin,
		});
		if (this.cview.nodes.length === 0) this.cview.nodes = [...this.view.nodes];
		shrink(this.cview, T, this.built, this.measure, { max: this.options.limits.cviewMax, min: this.options.limits.cviewMin }, merged);
		this.store.set("view", this.view);
		this.store.set("cview", this.cview);
	}

	/** Every message before `before` is summarized (its leaf is built). */
	summarized(before = this.store.total): boolean {
		return this.pendingLeaves.every((i) => i >= before);
	}

	/** Waits until every logged message is summarized, at most `ms`. */
	async waitSummarized(ms: number): Promise<boolean> {
		const before = this.store.total;
		if (this.summarized(before)) return true;
		this.kick();
		return new Promise((resolve) => {
			const check = () => {
				if (!this.summarized(before)) return;
				this.waiters.delete(check);
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				this.waiters.delete(check);
				resolve(false);
			}, ms);
			this.waiters.add(check);
		});
	}

	/** The turn's view lines. */
	viewLines(): string[] {
		return this.view.nodes.map((n) => line(n, this.text(n)));
	}

	/**
	 * A turn's request messages (spec §6): the leading system messages, then the view and per-turn state
	 * before the run's first message, then the rest of the run. `run` counts the run's own messages at the
	 * end of `messages`.
	 */
	turnMessages(messages: readonly Message[], run: number, now: Date): Message[] {
		// The prompt and tools are the replay of every system message (later ones update sections and tools):
		// keep them all, in order, ahead of the view.
		const system = [foldSystem(messages.filter((m) => m.role === "system") as SystemMessage[])];
		if (JSON.stringify(system) !== JSON.stringify(this.system)) {
			this.system = system;
			this.store.set("system", system);
		}
		const own = messages.filter((m) => m.role !== "system").slice(-run || messages.length);
		const [first, ...rest] = own;
		// Per-turn state after the view (spec §6). It also says what this call is: without it, a short
		// message after a long view was sometimes answered with a compaction line.
		const state: Block = { type: "text", text: `Now: ${now.toString()}\nThis call is a turn: act on the user's new message below.` };
		const head: Block[] = [...viewBlocks(this.viewLines()), state];
		if (first === undefined || first.role !== "user") {
			return [...system, { role: "user", content: head, timestamp: now.getTime() }, ...own];
		}
		const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
		return [...system, { ...first, content: [...head, ...content] }, ...rest];
	}

	/** Waits while another call writes the same marked prefix to the cache. */
	async awaitWriter(prefix: string | undefined): Promise<void> {
		if (prefix === undefined) return;
		const writing = this.writers.get(prefix);
		if (writing !== undefined) await writing;
	}

	private queuedOrBusy(n: NodeRef): boolean {
		return this.inFlight.has(key(n)) || this.built(n);
	}

	/** Records a built node and queues its parent. */
	private done(n: NodeRef, text: string): void {
		this.store.putNode(n, text);
		if (n[0] === 0) this.pendingLeaves = this.pendingLeaves.filter((i) => i !== n[1]);
		this.failed.delete(key(n));
		this.enqueueParents(n);
		for (const waiter of [...this.waiters]) waiter();
	}

	private enqueueParents(n: NodeRef): void {
		let [l, i] = n;
		for (;;) {
			const sibling: NodeRef = [l, i ^ 1];
			const parent: NodeRef = [l + 1, i >> 1];
			if (!this.built([l, i]) || !this.built(sibling) || this.built(parent)) return;
			const [a, b] = i % 2 === 0 ? [[l, i] as NodeRef, sibling] : [sibling, [l, i] as NodeRef];
			const joined = `${this.text(a)}\n${this.text(b)}`;
			if (bytes(joined) > LIMIT) {
				if (!this.readyMerges.some((m) => key(m) === key(parent))) this.readyMerges.push(parent);
				return;
			}
			this.store.putNode(parent, joined);
			[l, i] = parent;
		}
	}

	/** Starts ready compactions, up to the concurrency limit; leaves first (turns wait on them). */
	kick(): void {
		const max = this.options.concurrency ?? 8;
		for (const i of this.pendingLeaves.slice(0, 8)) {
			if (this.inFlight.size >= max) return;
			const n: NodeRef = [0, i];
			if (!this.queuedOrBusy(n)) this.run(n);
		}
		for (const n of [...this.readyMerges]) {
			if (this.inFlight.size >= max) return;
			this.readyMerges = this.readyMerges.filter((m) => key(m) !== key(n));
			if (!this.queuedOrBusy(n)) this.run(n);
		}
	}

	private run(n: NodeRef): void {
		this.inFlight.add(key(n));
		const started = performance.now();
		this.build(n)
			.then((text) => {
				log("optchat", `built ${start(n)}+${count(n)} (${bytes(text)} B, ${(performance.now() - started).toFixed(0)} ms)`);
				this.done(n, text);
			})
			.catch((error: unknown) => {
				// Tried again at the next message.
				log("optchat", `compaction ${start(n)}+${count(n)} failed: ${(error as Error).message}`);
				this.failed.add(key(n));
				if (n[0] > 0) this.readyMerges.push(n);
			})
			.finally(() => {
				this.inFlight.delete(key(n));
				if (!this.failed.has(key(n))) this.kick();
			});
	}

	/** The compaction view for a node: built lines up to its boundary (spec §4). */
	private contextLines(boundary: number): string[] {
		const lines: string[] = [];
		for (const m of this.cview.nodes) {
			if (last(m) > boundary || !this.built(m)) break;
			lines.push(line(m, this.text(m)));
		}
		return lines;
	}

	private async build(n: NodeRef): Promise<string> {
		const [l, i] = n;
		if (l === 0) {
			const message = this.store.message(i);
			if (message === undefined) throw new Error(`no message ${i}`);
			return this.compact(this.contextLines(i - 1), leafTask(i, message.kind, message.text));
		}
		const a: NodeRef = [l - 1, 2 * i];
		const b: NodeRef = [l - 1, 2 * i + 1];
		const task = mergeTask(
			`${start(a)}+${count(a)}`,
			`${start(b)}+${count(b)}`,
			start(n),
			last(n),
			line(a, this.text(a)),
			line(b, this.text(b)),
		);
		return this.compact(this.contextLines(last(n)), task);
	}

	/** One compaction call with the turns' system prompt and tools, retried while the line is too long. */
	private async compact(lines: string[], task: string): Promise<string> {
		const { models, compactor, reasoning } = this.options;
		const messages: Message[] = [
			...this.system,
			{ role: "user", content: [...viewBlocks(lines), { type: "text", text: task }], timestamp: Date.now() },
		];
		let best: string | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			const reply = await this.call(models, compactor, messages, reasoning);
			const u = reply.usage;
			log("optchat", `compaction tokens: input ${u.input}, cache read ${u.cacheRead}, cache write ${u.cacheWrite}, output ${u.output}`);
			if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
			const text = reply.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("")
				.trim()
				.replace(/^\d+\+\d+\|/, "");
			if (text === "") continue;
			if (best === undefined || bytes(text) < bytes(best)) best = text;
			if (bytes(text) <= LIMIT) break;
			messages.push(reply, { role: "user", content: tooLong(bytes(text), headBytes(text, LIMIT)), timestamp: Date.now() });
		}
		if (best === undefined) throw new Error("empty compaction");
		return best;
	}

	private async call(
		models: Models,
		model: Model<Api>,
		messages: Message[],
		reasoning: OptChatOptions["reasoning"],
	): Promise<AssistantMessage> {
		let release = () => {};
		const stream = models.streamSimple(model, { messages }, {
			...(reasoning === "off" ? {} : { reasoning }),
			onPayload: async (payload: unknown) => {
				if (model.api !== "anthropic-messages") return undefined;
				const marked = markView(payload);
				await this.awaitWriter(marked.prefix);
				if (marked.prefix !== undefined && !this.writers.has(marked.prefix)) {
					const prefix = marked.prefix;
					this.writers.set(
						prefix,
						new Promise<void>((resolve) => {
							release = () => {
								release = () => {};
								this.writers.delete(prefix);
								resolve();
							};
						}),
					);
				}
				return marked.payload;
			},
		});
		try {
			// The first event means the response started: the prefix is written.
			for await (const _event of stream) release();
			return await stream.result();
		} finally {
			release();
		}
	}

	close(): void {
		this.store.close();
	}
}

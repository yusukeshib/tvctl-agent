// OptChat in pi-durable: the zoom and date tools, and the generation hooks that send each turn
// [system] [view] [message] instead of the whole history (spec §6).
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, type HookApi, hook } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { log } from "../log.ts";
import type { OptChat } from "./index.ts";
import { markView } from "./index.ts";
import { line, type NodeRef } from "./view.ts";

function text(value: string) {
	return { output: [{ type: "text" as const, text: value }] };
}

/** zoom(id, n): the two lines under id+n, or message id whole when n = 1. */
export function zoom(chat: OptChat, idArg: string, n: number): string {
	if (!/^\d+$/.test(idArg.trim())) return `No agent named ${JSON.stringify(idArg)}: there are no subagents.`;
	const id = Number(idArg);
	const total = chat.store.total;
	if (id >= total) return `No message ${id}: the chat has ${total} messages (0-${total - 1}).`;
	if (n === 1) {
		const m = chat.store.message(id);
		return m === undefined ? `No message ${id}.` : `${m.i} ${m.kind}:\n${m.text}`;
	}
	const l = Math.log2(n);
	if (!Number.isInteger(l) || l < 0 || id % n !== 0) return `Bad line ${id}+${n}: n must be a power of 2 and id a multiple of n.`;
	const halves: NodeRef[] = [
		[l - 1, (id / n) * 2],
		[l - 1, (id / n) * 2 + 1],
	];
	return halves
		.filter(([hl, hi]) => hi * 2 ** hl < total)
		.map((h) => line(h, chat.store.node(h)))
		.join("\n");
}

export function createOptChatExtension(chat: OptChat) {
	const runMessages = async (api: HookApi, context: Context): Promise<number> => {
		const cursor = chat.cursor;
		let k = 0;
		let next: Parameters<HookApi["entries"]>[2];
		do {
			const page = await api.entries(
				{ ...(cursor === undefined ? {} : { minEntryId: (cursor + 1) as never }), order: "ascending" },
				200,
				next,
				context,
			);
			for (const entry of page.items) k += (entry.model ?? []).filter((m) => m.role !== "system").length;
			next = page.next;
		} while (next !== undefined);
		return k;
	};
	return defineExtension({
		name: "optchat",
		tools: [
			defineTool({
				name: "zoom",
				description:
					"Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. n is a power of 2, and id a multiple of n.",
				parameters: obj({ id: str({ description: "First message id of the line" }), n: opt(num({ description: "Messages the line covers; default 1" })) }),
				execute: async (args) => text(zoom(chat, args.id, args.n ?? 1)),
			}),
			defineTool({
				name: "date",
				description: "The date and time of message id.",
				parameters: obj({ id: num() }),
				execute: async (args) => {
					const m = chat.store.message(args.id);
					return text(m === undefined ? `No message ${args.id}.` : new Date(m.date).toString());
				},
			}),
		],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request, api, context) => {
					const run = await runMessages(api, context);
					return { messages: chat.turnMessages(request.messages as Message[], run, new Date()) };
				},
				afterResponse: (message) => {
					const u = message.usage;
					log("turn", `tokens: input ${u.input}, cache read ${u.cacheRead}, cache write ${u.cacheWrite}, output ${u.output}`);
				},
				beforeProviderRequest: async (request) => {
					if (request.model.api !== "anthropic-messages") return undefined;
					const marked = markView(request.payload);
					await chat.awaitWriter(marked.prefix);
					return { payload: marked.payload };
				},
			}),
		],
	});
}

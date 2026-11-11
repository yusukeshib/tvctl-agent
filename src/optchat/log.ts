// What OptChat logs from model messages (spec §1): the user's words, the agent's replies, tool calls and
// tool results. Thoughts are never logged. Tool output is clipped to its head and tail; any other long
// text is split over several messages.
import type { Message } from "@earendil-works/pi-ai";
import { AGENT_KIND } from "./prompt.ts";

export const CLIP = 30_000;

export type LogItem = { kind: string; text: string; date: Date };

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

export function clip(text: string, max = CLIP): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 40) / 2);
	return `${text.slice(0, half)}\n[... ${text.length - 2 * half} characters cut ...]\n${text.slice(-half)}`;
}

export function split(text: string, max = CLIP): string[] {
	if (text.length <= max) return [text];
	const parts: string[] = [];
	for (let at = 0; at < text.length; at += max) parts.push(text.slice(at, at + max));
	return parts;
}

/** Log items for one model message, in order. */
export function itemsOf(message: Message): LogItem[] {
	const date = new Date(message.timestamp ?? Date.now());
	const items: LogItem[] = [];
	const add = (kind: string, text: string) => {
		for (const part of split(text)) if (part.trim() !== "") items.push({ kind, text: part, date });
	};
	switch (message.role) {
		case "user":
			add("user", textOf(message.content));
			break;
		case "assistant": {
			let reply = "";
			const flush = () => {
				add(AGENT_KIND, reply.trim());
				reply = "";
			};
			for (const block of message.content) {
				if (block.type === "text") reply += block.text;
				else if (block.type === "toolCall") {
					flush();
					add("tool", `${block.name} ${JSON.stringify(block.arguments)}`);
				}
			}
			flush();
			break;
		}
		case "toolResult": {
			const text = clip(textOf(message.content as readonly { type: string; text?: string }[]));
			if (text.trim() !== "") items.push({ kind: "echo", text, date });
			break;
		}
		default:
			break;
	}
	return items;
}

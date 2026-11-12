// The conversation log: one JSON line per user turn, spoken reply and tool call. A new Realtime session
// (they last at most 60 minutes) starts with the most recent part of it, so the agent remembers.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Entry = { date: string; role: "user" | "assistant" | "tool"; text: string };

export class Memory {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
	}

	add(role: Entry["role"], text: string): void {
		const value = text.trim();
		if (value === "") return;
		const entry: Entry = { date: new Date().toISOString(), role, text: value.slice(0, 1000) };
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
	}

	/** The latest entries, oldest first, as lines of at most `chars` characters in total. */
	recent(chars: number): string {
		let text = "";
		try {
			text = readFileSync(this.path, "utf8");
		} catch {
			return "";
		}
		return formatRecent(text.split("\n"), chars);
	}
}

export function formatRecent(lines: string[], chars: number): string {
	const out: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === "") continue;
		let entry: Entry;
		try {
			entry = JSON.parse(lines[i]) as Entry;
		} catch {
			continue;
		}
		const line = `${entry.date.slice(0, 16).replace("T", " ")} ${entry.role}: ${entry.text}`;
		if (size + line.length > chars) break;
		out.push(line);
		size += line.length + 1;
	}
	return out.reverse().join("\n");
}

// Lasting things the user asked the agent to remember ("keep replies short", "I watch Netflix in Japanese").
// Unlike the conversation log, notes never scroll out: every session's instructions include all of them.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class Notes {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
	}

	list(): string[] {
		try {
			return readFileSync(this.path, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "");
		} catch {
			return [];
		}
	}

	add(note: string): string[] {
		const value = note.replace(/\s+/g, " ").trim().slice(0, 300);
		const notes = this.list();
		if (value !== "" && !notes.includes(value)) notes.push(value);
		this.save(notes);
		return notes;
	}

	/** Removes the note at a 1-based position. */
	remove(position: number): string[] {
		const notes = this.list();
		if (!Number.isInteger(position) || position < 1 || position > notes.length) throw new Error(`no note ${position}`);
		notes.splice(position - 1, 1);
		this.save(notes);
		return notes;
	}

	private save(notes: string[]): void {
		writeFileSync(this.path, notes.length > 0 ? `${notes.join("\n")}\n` : "");
	}
}

/** Notes as a numbered list. */
export function formatNotes(notes: string[]): string {
	return notes.length === 0 ? "(none)" : notes.map((n, i) => `${i + 1}. ${n}`).join("\n");
}

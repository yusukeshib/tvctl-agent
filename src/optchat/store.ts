// OptChat's log, tree and views (spec §1-§3) in one SQLite file. Append only: messages and nodes are
// never edited or deleted. Each write is its own transaction, so it is on disk when the call returns.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NodeRef, ViewState } from "./view.ts";

export type Kind = "user" | "tool" | "echo" | "work" | "note" | string;

export type LogMessage = { i: number; kind: Kind; text: string; size: number; date: string };

export class Store {
	private readonly db: DatabaseSync;
	private readonly nodes = new Map<string, string>();
	private messageCount: number;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			CREATE TABLE IF NOT EXISTS messages (i INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
				size INTEGER NOT NULL, date TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS nodes (l INTEGER NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL,
				size INTEGER NOT NULL, PRIMARY KEY (l, i));
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
		for (const row of this.db.prepare("SELECT l, i, text FROM nodes").all() as { l: number; i: number; text: string }[]) {
			this.nodes.set(`${row.l}:${row.i}`, row.text);
		}
		this.messageCount = Number((this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
	}

	/** Number of messages in the chat (T). */
	get total(): number {
		return this.messageCount;
	}

	/** Appends messages and saves the ingest cursor in one transaction. */
	append(items: readonly { kind: Kind; text: string; date: Date }[], cursor?: number): LogMessage[] {
		const insert = this.db.prepare("INSERT INTO messages (i, kind, text, size, date) VALUES (?, ?, ?, ?, ?)");
		const out: LogMessage[] = [];
		this.db.exec("BEGIN");
		try {
			for (const item of items) {
				const message: LogMessage = {
					i: this.messageCount + out.length,
					kind: item.kind,
					text: item.text,
					size: Buffer.byteLength(item.text),
					date: item.date.toISOString(),
				};
				insert.run(message.i, message.kind, message.text, message.size, message.date);
				out.push(message);
			}
			if (cursor !== undefined) this.set("cursor", cursor);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		this.messageCount += out.length;
		return out;
	}

	message(i: number): LogMessage | undefined {
		return this.db.prepare("SELECT i, kind, text, size, date FROM messages WHERE i = ?").get(i) as LogMessage | undefined;
	}

	node([l, i]: NodeRef): string | undefined {
		return this.nodes.get(`${l}:${i}`);
	}

	/** Logs a node once; a node is never built again. */
	putNode([l, i]: NodeRef, text: string): void {
		if (this.nodes.has(`${l}:${i}`)) return;
		this.db.prepare("INSERT OR IGNORE INTO nodes (l, i, text, size) VALUES (?, ?, ?, ?)").run(l, i, text, Buffer.byteLength(text));
		this.nodes.set(`${l}:${i}`, text);
	}

	get<T>(name: string): T | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(name) as { value: string } | undefined;
		return row === undefined ? undefined : (JSON.parse(row.value) as T);
	}

	set(name: string, value: unknown): void {
		this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name, JSON.stringify(value));
	}

	view(name: "view" | "cview"): ViewState | undefined {
		return this.get<ViewState>(name);
	}

	close(): void {
		this.db.close();
	}
}

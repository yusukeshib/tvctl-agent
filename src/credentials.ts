// pi's auth.json as a pi-ai CredentialStore, locked the way pi locks it (proper-lockfile on the resolved
// path), so an OAuth refresh here and one in pi never both use the same rotating refresh token.
import { readFile, realpath, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";

type Data = Record<string, Credential>;

export class PiAuthStore implements CredentialStore {
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private async load(path: string): Promise<Data> {
		try {
			const text = await readFile(path, "utf8");
			return text.trim() === "" ? {} : (JSON.parse(text) as Data);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return (await this.load(this.path))[providerId];
	}

	async list() {
		const data = await this.load(this.path);
		return Object.entries(data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	private async withLock<T>(fn: (data: Data) => Promise<{ result: T; next?: Data }>): Promise<T> {
		const path = await realpath(this.path);
		const deadline = Date.now() + 30_000;
		let release: (() => Promise<void>) | undefined;
		for (let attempt = 0; release === undefined; attempt++) {
			try {
				release = await lockfile.lock(path, { retries: 0, stale: 30_000 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() > deadline) throw error;
				await sleep(Math.min(10 * 2 ** attempt, 1000) * (1 + Math.random()));
			}
		}
		try {
			const { result, next } = await fn(await this.load(path));
			if (next !== undefined) await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			return result;
		} finally {
			await release();
		}
	}

	async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
		return this.withLock(async (data) => {
			const updated = await fn(data[providerId]);
			if (updated === undefined) return { result: data[providerId] };
			return { result: updated, next: { ...data, [providerId]: updated } };
		});
	}

	async delete(providerId: string) {
		await this.withLock(async (data) => {
			const { [providerId]: _removed, ...rest } = data;
			return { result: undefined, next: rest };
		});
	}
}

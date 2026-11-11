import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Conversation, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Config, splitModelRef } from "./config.ts";
import { PiAuthStore } from "./credentials.ts";
import { log } from "./log.ts";
import { createOptChatExtension } from "./optchat/extension.ts";
import { OptChat } from "./optchat/index.ts";
import { optchatPrompt } from "./optchat/prompt.ts";
import { remoteInstructions } from "./prompt.ts";
import { createTvctlExtension, execTvctl } from "./tvctl.ts";
import { createWebExtension } from "./web.ts";

const context = BACKGROUND_CONTEXT;

export type Answer = { text: string; ms: number };

export class Agent {
	private readonly harness: Harness;
	private readonly root: Conversation;
	private readonly chat: OptChat | undefined;
	private readonly waitMs: number;
	/** Utterances in flight: the log is only ingested while none is, so a running call's messages stay its own. */
	private active = 0;

	private constructor(harness: Harness, root: Conversation, chat: OptChat | undefined, waitMs: number) {
		this.harness = harness;
		this.root = root;
		this.chat = chat;
		this.waitMs = waitMs;
	}

	static async open(config: Config): Promise<Agent> {
		await mkdir(dirname(config.paths.storage), { recursive: true });
		const models = builtinModels({ credentials: new PiAuthStore(config.paths.piAuth) });
		let chat: OptChat | undefined;
		if (config.memory.enabled) {
			const ref = splitModelRef(config.model.compactor);
			const compactor = models.getModel(ref.provider, ref.modelId);
			if (compactor === undefined) throw new Error(`unknown compactor model ${config.model.compactor}`);
			chat = new OptChat({
				path: join(dirname(config.paths.storage), "optchat.sqlite"),
				models,
				compactor,
				reasoning: config.model.compactorThinking,
				limits: {
					viewMax: config.memory.viewMax,
					viewMin: config.memory.viewMin,
					cviewMax: config.memory.cviewMax,
					cviewMin: config.memory.cviewMin,
				},
			});
		}
		const registry = createRegistry();
		// One system prompt for turns and compactions: OptChat's prompt, then the user's instructions.
		const sections = [
			...(chat ? [section("optchat", () => optchatPrompt, { tag: false })] : []),
			section("remote", () => remoteInstructions, { tag: false }),
		];
		registry.install(defineExtension({ name: "remote", sections }));
		registry.install(createTvctlExtension(execTvctl(config.paths.tvctl)));
		registry.install(createWebExtension(config.model.webSearch));
		if (chat) registry.install(createOptChatExtension(chat));
		const storage = await openNodeSqliteStorage(config.paths.storage);
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				identity: { attribution: { name: "tvctl-agent", url: "https://github.com/yusukeshib/tvctl-agent" } },
				settings: { retry: { maxRetries: 2 }, afterFailedRun: "continue" },
				onReport: (report) => log("harness", `${report.kind}: ${String((report as { error?: unknown }).error ?? "")}`),
			},
			context,
		);
		const model = splitModelRef(config.model.main);
		const root = await harness.root(context);
		await root.configure(
			{
				model,
				thinkingLevel: config.model.thinking,
				instructions: config.instructions ?? null,
				maxTurns: 12,
			},
			context,
		);
		harness.resume();
		const agent = new Agent(harness, root, chat, config.memory.waitMs);
		await agent.ingest();
		return agent;
	}

	/** Logs every committed entry after OptChat's cursor (spec §1). */
	private async ingest(): Promise<void> {
		if (this.chat === undefined) return;
		const cursor = this.chat.cursor;
		let next: Parameters<Conversation["entries"]>[2];
		do {
			const page = await this.root.entries(
				{ ...(cursor === undefined ? {} : { minEntryId: (cursor + 1) as never }), order: "ascending" },
				200,
				next,
				context,
			);
			for (const entry of page.items) this.chat.ingest((entry.model ?? []) as Message[], entry.id);
			next = page.next;
		} while (next !== undefined);
	}

	/** Submits one utterance; a busy run takes it as a steer. Resolves with the answer to speak. */
	async say(text: string): Promise<Answer | undefined> {
		const started = performance.now();
		const first = this.active++ === 0;
		let settled;
		try {
			if (this.chat !== undefined && first) {
				// A new turn sees every earlier message summarized (spec §6); a steer joins the running call.
				await this.ingest();
				if (!(await this.chat.waitSummarized(this.waitMs))) log("optchat", "turn starts before every message is summarized");
			}
			const submission = await this.root.submit({ type: "input", content: text, whenBusy: "steer" }, context);
			settled = await submission.wait(context);
		} finally {
			if (--this.active === 0) await this.ingest();
		}
		const ms = performance.now() - started;
		if (settled.status !== "done" || settled.answer === undefined) {
			log("agent", `unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`);
			return undefined;
		}
		const page = await this.root.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, context);
		const message = page.items[0]?.model?.[0];
		if (message === undefined || message.role !== "assistant") return { text: "", ms };
		const answer = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		return { text: answer, ms };
	}

	async close(): Promise<void> {
		await this.harness.close(context);
		this.chat?.close();
	}
}

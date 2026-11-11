import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Conversation, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Config, splitModelRef } from "./config.ts";
import { PiAuthStore } from "./credentials.ts";
import { log } from "./log.ts";
import { remoteInstructions } from "./prompt.ts";
import { createTvctlExtension, execTvctl } from "./tvctl.ts";

const context = BACKGROUND_CONTEXT;

export type Answer = { text: string; ms: number };

export class Agent {
	private readonly harness: Harness;
	private readonly root: Conversation;

	private constructor(harness: Harness, root: Conversation) {
		this.harness = harness;
		this.root = root;
	}

	static async open(config: Config): Promise<Agent> {
		await mkdir(dirname(config.paths.storage), { recursive: true });
		const models = builtinModels({ credentials: new PiAuthStore(config.paths.piAuth) });
		const registry = createRegistry();
		const remote = defineExtension({
			name: "remote",
			sections: [section("remote", () => remoteInstructions, { tag: false })],
		});
		registry.install(remote);
		registry.install(createTvctlExtension(execTvctl(config.paths.tvctl)));
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
		return new Agent(harness, root);
	}

	/** Submits one utterance; a busy run takes it as a steer. Resolves with the answer to speak. */
	async say(text: string): Promise<Answer | undefined> {
		const started = performance.now();
		const submission = await this.root.submit({ type: "input", content: text, whenBusy: "steer" }, context);
		const settled = await submission.wait(context);
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
	}
}

#!/usr/bin/env node
// tvctl-agent: listens to the configured microphone and drives tvctl.
//   node src/main.ts [--config PATH] [--text "コマンド"]
// --text runs one command without the microphone (for testing) and exits.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent } from "./agent.ts";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { openaiKey } from "./openai-voice.ts";
import { Voice } from "./voice.ts";

// launchd starts without the shell's environment: web search and the OpenAI voice need the key.
if (openaiKey() === undefined) log("main", "OPENAI_API_KEY not found: web search and the OpenAI voice will fail");

const run = promisify(execFile);

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = flag("--config") ?? defaultConfigPath;
const config = await loadConfig(configPath);
const agent = await Agent.open(config);
log("main", `model ${config.model.main}, storage ${config.paths.storage}`);

const once = flag("--text");
if (once !== undefined) {
	const answer = await agent.say(once);
	log("main", `answer (${answer?.ms.toFixed(0) ?? "-"} ms): ${answer?.text ?? "(none)"}`);
	await agent.close();
	process.exit(0);
}

try {
	await run(config.paths.tvctl, ["server", "up"]);
	if (config.speech.enabled && config.speech.duckLevel !== undefined) {
		await run(config.paths.tvctl, ["duck", "on", "--apps", "tvctl-voice", "--level", String(config.speech.duckLevel)]);
	}
} catch (error) {
	log("main", `tvctl setup failed: ${(error as Error).message}`);
}

/** The last answer spoken: utterances steered into one run all settle with that run's answer. */
let lastSpoken = -1;
const voice: Voice = new Voice(config, (utterance) => {
	log("heard", utterance.text);
	void agent.say(utterance.text).then(async (answer) => {
		if (answer === undefined) return;
		if (answer.id <= lastSpoken) return;
		lastSpoken = answer.id;
		log("answer", `${answer.ms.toFixed(0)} ms: ${answer.text}`);
		await voice.speak(answer.text);
	}).catch((error: unknown) => log("agent", `failed: ${(error as Error).message}`));
});
voice.start();

const shutdown = async () => {
	voice.stop();
	await agent.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

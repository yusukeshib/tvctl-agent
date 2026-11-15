#!/usr/bin/env node
// tvctl-agent: a voice conversation with the TV over one OpenAI Realtime session.
//   node src/main.ts [--config PATH] [--text "コマンド"]
// --text sends one typed message (text only, no microphone; for testing) and exits.
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { Diagnostics } from "./diagnostics.ts";
import { buildInstructions } from "./instructions.ts";
import { log } from "./log.ts";
import { Memory } from "./memory.ts";
import { openaiKey } from "./openai.ts";
import { Realtime } from "./realtime.ts";
import { Notes } from "./notes.ts";
import { createTools, execTvctl, playerState } from "./tools.ts";
import { Trace } from "./trace.ts";

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const configPath = flag("--config") ?? defaultConfigPath;
const config = await loadConfig(configPath);
// The trace is optional: a storage failure (unwritable directory, full disk) must not stop the agent.
let trace: Trace | undefined;
let traceError: string | undefined;
if (config.log.trace) {
	try {
		trace = new Trace({ dir: config.log.dir, audio: config.log.audio, keepDays: config.log.keepDays });
	} catch (error) {
		traceError = (error as Error).message;
	}
}
const diagnostics = new Diagnostics(trace);
if (traceError !== undefined) diagnostics.note("main", `trace disabled: ${traceError}`);
const { realtime: rt, audio } = config;
diagnostics.note(
	"main",
	`start (config ${configPath}): ${rt.model}, voice ${rt.voice}, eagerness ${rt.eagerness}, noise reduction ${rt.noiseReduction}, echo cancellation ${audio.echoCancellation ? "on" : "off"}; trace ${trace ? `${trace.dir}${trace.audio ? " (with audio)" : ""}` : "off"}`,
	{ config: { ...config, instructions: config.instructions ?? null } },
);
process.on("uncaughtException", (error) => {
	diagnostics.note("main", `crashed: ${error.stack ?? error.message}`);
	process.exit(1);
});
process.on("unhandledRejection", (error) => {
	diagnostics.note("main", `unhandled rejection: ${(error as Error)?.stack ?? String(error)}`);
});
// launchd starts without the shell's environment: read the key from the login shell.
if (openaiKey() === undefined) diagnostics.note("main", "OPENAI_API_KEY not found");

const memory = new Memory(config.paths.memory);
const notes = new Notes(config.paths.notes);
const tvctl = execTvctl(config.paths.tvctl);
const tools = createTools(tvctl, config.webSearchModel, notes);
const options = {
	...config.realtime,
	instructions: () => buildInstructions(memory.recent(config.memory.recentChars), config.instructions, notes.list()),
	tools,
	memory,
	diagnostics,
	playerState: () => playerState(tvctl),
};

const once = flag("--text");
if (once !== undefined) {
	const realtime = new Realtime({ ...options, text: true });
	await realtime.connect();
	await realtime.say(once);
	realtime.close();
	process.exit(0);
}

const run = promisify(execFile);
try {
	await run(config.paths.tvctl, ["server", "up"]);
	if (config.speech.duckLevel !== undefined) {
		await run(config.paths.tvctl, ["duck", "on", "--apps", "tvctl-voice", "--level", String(config.speech.duckLevel)]);
	}
} catch (error) {
	diagnostics.note("main", `tvctl setup failed: ${(error as Error).message}`);
}

// The microphone's peak level, logged once a minute (a silent microphone is the usual reason for no answers).
let peak = 0;
let chunks = 0;
function meter(pcm: string): void {
	const bytes = Buffer.from(pcm, "base64");
	for (let i = 0; i + 1 < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
	chunks++;
}
setInterval(() => {
	diagnostics.note("mic", `peak ${peak > 0 ? (20 * Math.log10(peak / 32768)).toFixed(0) : "-inf"} dBFS over ${chunks} chunks`);
	peak = 0;
	chunks = 0;
}, 15_000).unref();

// The helper: echo-cancelled microphone in, speech out.
const helper = spawn(
	config.paths.voice,
	["converse", ...(config.audio.levels ? ["--levels"] : []), ...(config.audio.echoCancellation ? [] : ["--no-echo-cancellation"])],
	 { stdio: ["pipe", "pipe", "inherit"] });
const command = (event: Record<string, unknown>) => helper.stdin.write(`${JSON.stringify(event)}\n`);
const realtime = new Realtime(options, {
	audio: (id, data) => command({ type: "pcm", id, data }),
	end: (id) => command({ type: "pcm_end", id }),
	stop: () => command({ type: "stop" }),
});
createInterface({ input: helper.stdout }).on("line", (line) => {
	let event: { type: string; [key: string]: unknown };
	try {
		event = JSON.parse(line) as typeof event;
	} catch {
		return;
	}
	switch (event.type) {
		case "audio":
			meter(String(event.pcm));
			realtime.appendAudio(String(event.pcm));
			break;
		case "stopped":
			realtime.stopped(String(event.id), Number(event.played_ms));
			break;
		case "spoken":
			trace?.write("agent", { type: "agent.voice", event });
			realtime.spoken(String(event.id));
			break;
		default:
			// ready, speaking, level, device_lost, error
			log("voice", line);
			trace?.write("agent", { type: "agent.voice", event });
	}
});
helper.on("exit", (code) => {
	diagnostics.note("main", `voice helper exited (${code})`);
	process.exit(1);
});

await realtime.connect();

const shutdown = () => {
	realtime.close();
	helper.kill();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

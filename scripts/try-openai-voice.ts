// Measures OpenAI realtime transcription (gpt-live-transcribe) and realtime speech (gpt-realtime-2.1-mini).
//   node scripts/try-openai-voice.ts stt <file.pcm (s16le 24 kHz mono)>
//   node scripts/try-openai-voice.ts tts "読み上げる文" [out.pcm]
import { readFileSync, writeFileSync } from "node:fs";

const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("OPENAI_API_KEY");

function open(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } } as never);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(new Error(String((e as ErrorEvent).message ?? e)));
	});
}

const [mode, arg, out] = process.argv.slice(2);
const t0 = performance.now();
const ms = () => `${(performance.now() - t0).toFixed(0)} ms`;

if (mode === "stt") {
	const ws = await open("wss://api.openai.com/v1/realtime?intent=transcription");
	console.log("connected", ms());
	ws.send(
		JSON.stringify({
			type: "session.update",
			session: {
				type: "transcription",
				audio: {
					input: {
						format: { type: "audio/pcm", rate: 24000 },
						transcription: { model: "gpt-live-transcribe", languages: ["ja"], delay: "medium" },
						turn_detection: null,
					},
				},
			},
		}),
	);
	const pcm = readFileSync(arg);
	// Real time: 100 ms chunks every 100 ms.
	const chunk = 4800;
	let sentAt = 0;
	ws.onmessage = (m) => {
		const e = JSON.parse(String(m.data));
		if (e.type.endsWith(".delta")) process.stdout.write(`[${ms()}] ${e.delta}\n`);
		else if (e.type === "conversation.item.input_audio_transcription.completed") {
			console.log(`final ${ms()} (${(performance.now() - sentAt).toFixed(0)} ms after commit):`, e.transcript);
			ws.close();
		} else if (e.type === "error") console.log("error", JSON.stringify(e.error));
		else console.log("event", e.type, ms());
	};
	for (let at = 0; at < pcm.length; at += chunk) {
		ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(at, at + chunk).toString("base64") }));
		await new Promise((r) => setTimeout(r, 100));
	}
	sentAt = performance.now();
	ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
} else {
	const ws = await open("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini");
	console.log("connected", ms());
	ws.send(
		JSON.stringify({
			type: "session.update",
			session: {
				type: "realtime",
				output_modalities: ["audio"],
				audio: { output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" } },
				instructions:
					"You are a text-to-speech voice. Read the user's text aloud exactly as written, in its language, naturally and briskly. Never add, drop, answer or change words.",
			},
		}),
	);
	const chunks: Buffer[] = [];
	let started = 0;
	ws.onmessage = (m) => {
		const e = JSON.parse(String(m.data));
		if (e.type === "response.output_audio.delta") {
			if (chunks.length === 0) console.log("first audio", (performance.now() - started).toFixed(0), "ms after request");
			chunks.push(Buffer.from(e.delta, "base64"));
		} else if (e.type === "response.output_audio_transcript.done") console.log("spoken text:", e.transcript);
		else if (e.type === "response.done") {
			console.log("done", (performance.now() - started).toFixed(0), "ms;", (Buffer.concat(chunks).length / 48000).toFixed(1), "s audio; usage", JSON.stringify(e.response.usage));
			if (out) writeFileSync(out, Buffer.concat(chunks));
			ws.close();
		} else if (e.type === "error") console.log("error", JSON.stringify(e.error));
	};
	await new Promise((r) => setTimeout(r, 300));
	started = performance.now();
	ws.send(
		JSON.stringify({
			type: "response.create",
			response: {
				conversation: "none",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: arg }] }],
			},
		}),
	);
}

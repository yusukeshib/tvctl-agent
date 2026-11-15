// Which transcribed turns deserve an answer. The microphone also hears the TV and the room, and the
// transcriber turns noise into fragments ("안녕하세요.", "Başlı.", "beginner", "ええ。"). Answering those made
// the agent pause, seek or chatter on its own, so they are dropped before the model is asked to respond.

const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const otherScripts = /[\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Hebrew}]/u;
/** Fillers and back-channel sounds that are never a request on their own. */
const fillers = new Set(["え", "ええ", "えー", "あ", "あー", "ああ", "あの", "あのー", "う", "うー", "うん", "お", "おお", "おー", "ん", "んー", "ふーん", "へー", "ほう"]);

export type Verdict = { answer: true } | { answer: false; reason: string };

export function judgeUtterance(transcript: string, language: string): Verdict {
	const text = transcript.trim();
	const bare = text.replace(/[\s\p{P}\p{S}]/gu, "");
	if (bare === "") return { answer: false, reason: "empty" };
	if (fillers.has(bare)) return { answer: false, reason: "filler" };
	// The script heuristics are for Japanese conversations only; other languages get the filler check alone.
	if (!language.startsWith("ja")) return { answer: true };
	if (otherScripts.test(bare)) return { answer: false, reason: "another language (likely noise)" };
	if (!japanese.test(bare)) {
		// A Japanese speaker may say an English title, but a lone foreign word is usually noise.
		const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
		if (words.length < 3) return { answer: false, reason: "no Japanese (likely noise)" };
	}
	return { answer: true };
}

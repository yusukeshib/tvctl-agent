// web_search: OpenAI's hosted web search (Responses API), answered in a few lines with source URLs.
import { log } from "./log.ts";
import { openaiKey } from "./openai.ts";

type ResponsesOutput = { output?: { type: string; content?: { type: string; text?: string }[] }[]; error?: { message?: string } };

export async function webSearch(query: string, model: string): Promise<string> {
	const apiKey = openaiKey();
	if (!apiKey) throw new Error("web search needs OPENAI_API_KEY");
	const started = performance.now();
	const response = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model,
			tools: [{ type: "web_search" }],
			reasoning: { effort: "low" },
			input: `Search the web and answer briefly (at most 5 short lines), with the most relevant URLs. Query: ${query}`,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	const body = (await response.json()) as ResponsesOutput;
	log("web", `${query} -> ${response.status} ${(performance.now() - started).toFixed(0)} ms`);
	if (!response.ok) throw new Error(body.error?.message ?? `web search failed (${response.status})`);
	const answer = (body.output ?? [])
		.filter((item) => item.type === "message")
		.flatMap((item) => item.content ?? [])
		.map((c) => c.text ?? "")
		.join("")
		.trim();
	return answer || "no results";
}

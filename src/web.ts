// web_search: OpenAI's hosted web search (Responses API), answered in a few lines with source URLs.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { log } from "./log.ts";

type ResponsesOutput = { output?: { type: string; content?: { type: string; text?: string }[] }[]; error?: { message?: string } };

export async function webSearch(query: string, model: string, apiKey: string): Promise<string> {
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

export function createWebExtension(model: string) {
	return defineExtension({
		name: "web",
		tools: [
			defineTool({
				name: "web_search",
				description:
					"Search the web: facts, news, schedules, or which title/song/channel the user means before search_media. Not for finding playable URLs on YouTube/Spotify (use search_media).",
				parameters: obj({ query: str() }),
				execute: async (args) => {
					const key = process.env.OPENAI_API_KEY;
					if (!key) throw new Error("web search needs OPENAI_API_KEY");
					return { output: [{ type: "text" as const, text: await webSearch(args.query, model, key) }] };
				},
			}),
		],
	});
}

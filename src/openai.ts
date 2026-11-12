import { execFileSync } from "node:child_process";

/** OPENAI_API_KEY from the environment, or from the user's login shell (launchd starts without it). */
export function openaiKey(): string | undefined {
	if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
	try {
		const shell = process.env.SHELL || "/bin/zsh";
		const key = execFileSync(shell, ["-lic", 'printf %s "$OPENAI_API_KEY"'], { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
		if (key) process.env.OPENAI_API_KEY = key;
		return key || undefined;
	} catch {
		return undefined;
	}
}

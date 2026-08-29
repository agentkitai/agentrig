import { OpenAIChatGPTAuth } from "@agentkitai/agentrig-core";

/**
 * `agentrig login openai-chatgpt` — the experimental device-code sign-in (PLAN §2.9).
 * Prints a code and URL; the user authorizes in a browser (on any device); tokens land in the
 * store for `--provider openai-chatgpt` runs.
 */
export async function loginCommand(provider: string): Promise<void> {
  if (provider !== "openai-chatgpt") {
    console.error(`login: unknown provider "${provider}" (only openai-chatgpt supports sign-in)`);
    process.exitCode = 1;
    return;
  }

  console.error(
    "Experimental: reuses your ChatGPT subscription via the same undocumented backend Codex uses.\n" +
      "OpenAI has not sanctioned this for third-party tools; use your own account at your own risk.\n",
  );

  const auth = new OpenAIChatGPTAuth();
  try {
    const login = await auth.startDeviceLogin();
    console.error(`To sign in, open:\n  ${login.verificationUri}`);
    console.error(`and enter the code:  ${login.userCode}`);
    console.error(`\nWaiting for authorization (expires in ${Math.round(login.expiresInSec / 60)} min)…`);
    const tokens = await login.complete();
    console.error(`\nSigned in.${tokens.accountId ? ` Account: ${tokens.accountId}` : ""}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

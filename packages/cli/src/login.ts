import { OpenAIChatGPTAuth, TOKEN_ENV_VAR } from "@agentkitai/agentrig-core";

/**
 * `agentrig login openai-chatgpt` — the experimental device-code sign-in (PLAN §2.9).
 * Prints a code and URL; the user authorizes in a browser (on any device); tokens land in the
 * store for `--provider openai-chatgpt` runs.
 *
 * `--export` prints the stored bundle (JSON, one line) to stdout so it can seed
 * `AGENTRIG_OPENAI_CHATGPT_TOKEN` in a cloud environment — authorize once, reuse everywhere.
 */
export async function loginCommand(provider: string, opts: { export?: boolean } = {}): Promise<void> {
  if (provider !== "openai-chatgpt") {
    console.error(`login: unknown provider "${provider}" (only openai-chatgpt supports sign-in)`);
    process.exitCode = 1;
    return;
  }

  const auth = new OpenAIChatGPTAuth();

  try {
    if (opts.export) {
      const tokens = await auth.exportTokens();
      if (tokens === null) {
        console.error("not signed in; run `agentrig login openai-chatgpt` first");
        process.exitCode = 1;
        return;
      }
      // the bundle IS a credential — only stdout, so it can be piped/copied deliberately
      console.log(JSON.stringify(tokens));
      console.error(`\nSet this as ${TOKEN_ENV_VAR} in your environment to reuse it in cloud sessions.`);
      return;
    }

    console.error(
      "Experimental: reuses your ChatGPT subscription via the same undocumented backend Codex uses.\n" +
        "OpenAI has not sanctioned this for third-party tools; use your own account at your own risk.\n",
    );

    const login = await auth.startDeviceLogin();
    console.error(`To sign in, open:\n  ${login.verificationUri}`);
    console.error(`and enter the code:  ${login.userCode}`);
    console.error(`\nWaiting for authorization (expires in ${Math.round(login.expiresInSec / 60)} min)…`);
    const tokens = await login.complete();
    console.error(`\nSigned in.${tokens.accountId ? ` Account: ${tokens.accountId}` : ""}`);
    console.error(
      `\nFor cloud/unattended runs, seed the token once:\n` +
        `  agentrig login openai-chatgpt --export\n` +
        `then set its output as ${TOKEN_ENV_VAR} in your environment settings.`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

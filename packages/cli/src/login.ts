import { spawn } from "node:child_process";
import { OpenAIChatGPTAuth, TOKEN_ENV_VAR } from "@agentkitai/agentrig-core";

/**
 * `agentrig login openai-chatgpt` — a browser sign-in (PKCE + loopback redirect, PLAN §9 F1).
 *
 * The device-code flow this replaces could never work: `auth.openai.com` puts an interactive
 * Cloudflare challenge in front of its authorization endpoints, and the challenge targets the
 * HTTP client, so `fetch` is refused wherever it runs. Here the browser makes that request; this
 * process only serves the redirect on loopback and exchanges the code.
 *
 * `--export` prints the stored bundle (JSON, one line) to stdout so it can seed
 * `AGENTRIG_OPENAI_CHATGPT_TOKEN` in a cloud environment — authorize once, reuse everywhere.
 */

export interface LoginOptions {
  export?: boolean;
  /** Print the URL and wait, without trying to open a browser. For SSH and headless terminals. */
  noBrowser?: boolean;
  openBrowser?: (url: string) => void;
}

/** Best-effort: the URL is always printed, so a failure here costs nothing. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    // an unhandled `error` event on a ChildProcess is fatal to this process
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

export async function loginCommand(provider: string, opts: LoginOptions = {}): Promise<void> {
  if (provider !== "openai-chatgpt") {
    console.error(`login: unknown provider "${provider}" (only openai-chatgpt supports sign-in)`);
    process.exitCode = 1;
    return;
  }

  const auth = new OpenAIChatGPTAuth();

  try {
    if (opts.export === true) {
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

    const login = await auth.startLoopbackLogin();
    console.error(`Opening your browser to sign in. If it does not open, visit:\n  ${login.url}\n`);
    if (opts.noBrowser !== true) (opts.openBrowser ?? openInBrowser)(login.url);
    console.error(`Waiting for the redirect to ${login.redirectUri} …`);

    const tokens = await login.complete();
    console.error(`\nSigned in.${tokens.accountId === undefined ? "" : ` Account: ${tokens.accountId}`}`);
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

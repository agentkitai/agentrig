import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { EvaluationReceipt, EvaluationTransport } from "./evaluation-transport.js";

// Fixed preparation, never a fixture/profile-supplied script. The selected image is trusted code.
const dependencies = `set -eu
test -d /opt/agentrig-eval-deps/node_modules
cp -a /opt/agentrig-eval-deps/node_modules /workspace/node_modules
for p in core memory supervisor cli; do
  test -d /opt/agentrig-eval-deps/packages/$p/node_modules
  cp -a /opt/agentrig-eval-deps/packages/$p/node_modules /workspace/packages/$p/node_modules
done
pnpm build
git diff --exit-code --no-ext-diff --no-textconv HEAD --
git diff --cached --exit-code --no-ext-diff --no-textconv HEAD --`;

export async function prepareEvaluationDependencies(transport: EvaluationTransport, receipt: EvaluationReceipt,
  image: string, directory: string, signal: AbortSignal): Promise<void> {
  if (!receipt.id.startsWith("A")) return;
  const result = await transport.worker({ image, workspace: receipt.workspace }, ["/bin/sh", "-c", dependencies], signal, 120_000);
  await writeFile(join(directory, "dependency-preparation.json"), `${JSON.stringify({
    image, network: false, source: "/opt/agentrig-eval-deps", code: result.code,
    infrastructure: result.infrastructure,
    // Logs are bounded by the shared E3 process helper and retained as local evidence, not echoed.
    stdout: result.stdout, stderr: result.stderr,
  }, null, 2)}\n`, { flag: "wx" });
  if (result.code !== 0 || result.infrastructure)
    throw new Error("BLOCKED: A tasks require a matching offline dependency image; preparation/build/tracked-tree check failed before provider use");
}

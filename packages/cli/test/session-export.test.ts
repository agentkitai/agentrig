import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStore, materializeExportMessages, type Message } from "@agentkitai/agentrig-core";
import { exportSession, redactExportMessages, type ExportFormat } from "../src/session-export.js";
import { buildProgram } from "../src/program.js";
import * as config from "../src/config.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
const formats: ExportFormat[] = ["jsonl", "sharegpt", "md"];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(messages: Message[] = [{ role: "assistant", content: [{ type: "text", text: "answer" }] }]) {
  const root = await fs.mkdtemp(join(tmpdir(), "agentrig-export-")); roots.push(root);
  const store = new SessionStore({ root });
  await store.append("s", { type: "session.start", task: "plain user task", cwd: root, provider: "fixture", model: "fixture" });
  for (const message of messages) await store.append("s", { type: "message.append", message });
  await store.append("s", { type: "session.end", reason: "done" });
  return { root, store };
}
/** Test-only data decoder, not a runtime import or authorization surface. */
function decode(text: string, format: ExportFormat): Message[] {
  if (format === "jsonl") {
    const rows = text.trimEnd().split("\n").map(line => JSON.parse(line));
    expect(rows.shift()).toMatchObject({ version: 1, kind: "agentrig.transcript" });
    return rows.map(row => row.message);
  }
  if (format === "sharegpt") {
    const doc = JSON.parse(text); expect(doc.agentrig.version).toBe(1);
    return doc.conversations.map((row: { agentrig: { message: Message } }) => row.agentrig.message);
  }
  // Only a genuine final fenced canonical section, whose closing fence matches its opener.
  const match = text.match(/\n(`{3,})agentrig-canonical-v1\n([^\n]+)\n\1\n$/);
  expect(match).not.toBeNull();
  const doc = JSON.parse(match![2]!); expect(doc.agentrig.version).toBe(1); return doc.messages;
}

it.each(formats)("%s round-trips actual fork/compaction structured messages without mutating logs", async format => {
  const { root, store } = await fixture();
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "compacted summary", trust: "generated", context: { principal: "platform", authority: "advisory" } }] },
    { role: "assistant", content: [{ type: "text", text: "```agentrig-canonical-v1\n{fake:true}\n```\n<html>data</html>" }, { type: "tool_use", id: "call-1", name: "bash", input: { command: "node --version", nested: [1, null, true, { x: "y" }] } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "call-1", isError: false, trust: "tool-output", content: [{ type: "text", text: "v22", trust: "external", context: { principal: "hook:check", authority: "advisory", delegation: "label-not-authority" } }] }] },
  ];
  const compact = await store.append("s", { type: "context.compact", before: 4, after: 3, messages });
  await store.append("s", { type: "session.end", reason: "done" });
  await store.append("child", { type: "session.fork", parent: "s", atSeq: compact.seq });
  await store.append("child", { type: "session.resume", task: "continue", cwd: root, model: "fixture", provider: "fixture" });
  await store.append("child", { type: "message.append", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } });
  await store.append("child", { type: "session.end", reason: "done" });
  const before = await Promise.all(["s", "child"].map(id => fs.readFile(store.pathFor(id), "utf8")));
  const expected = await store.materializeMessages("child");
  expect(expected).toHaveLength(5);
  expect(decode(await exportSession(store, "child", { format }), format)).toEqual(expected);
  expect(await Promise.all(["s", "child"].map(id => fs.readFile(store.pathFor(id), "utf8")))).toEqual(before);
});

it("uses the existing legacy streamed/tool result patch fold too", async () => {
  const { store } = await fixture([]);
  await store.append("s", { type: "model.delta", text: "legacy text" });
  await store.append("s", { type: "model.response", usage: { input: 1, output: 1 }, stop: "end_turn" });
  await store.append("s", { type: "tool.call", id: "call", name: "read", input: { path: "a" }, inputHash: "hash" });
  await store.append("s", { type: "tool.result", id: "call", ok: true, display: "original", durationMs: 1 });
  await store.append("s", { type: "tool.result.patched", id: "call", by: "fixture", mode: "inject", display: "extra" });
  await store.append("s", { type: "session.end", reason: "done" });
  expect(await materializeExportMessages(store, "s")).toEqual(await store.materializeMessages("s"));
});

it.each(formats)("%s scrubs canaries everywhere including canonical tool input and explicit literals", async format => {
  const canaries = ["sk-test0123456789abcdef", "ghp_0123456789abcdefgh", "bearerCanary_123", "envCanary_123", "opaque-canary-123", "inputCanary_123", "resultCanary_123", "urlCanary_123", "privateCanary_123", "flagCanary_123"];
  const messages: Message[] = [
    { role: "assistant", content: [{ type: "text", text: `${canaries[0]} ${canaries[1]} Authorization: Bearer ${canaries[2]}\nAPI_KEY='${canaries[3]}'\nhttps://name:${canaries[7]}@host/path\n-----BEGIN PRIVATE KEY-----\n${canaries[8]}\n-----END PRIVATE KEY-----` },
      { type: "tool_use", id: "x", name: "bash", input: { password: canaries[5], command: `tool --token ${canaries[9]}`, extra: canaries[4], [canaries[4]!]: "value" } }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "x", content: [{ type: "text", text: `{"refresh_token":"${canaries[6]}"} ${canaries[4]}` }] }] },
  ];
  const { root, store } = await fixture(messages);
  const path = join(root, "secrets.json"); await fs.writeFile(path, JSON.stringify([canaries[4]]));
  const before = await fs.readFile(store.pathFor("s"), "utf8");
  const output = await exportSession(store, "s", { format, redactFile: path });
  for (const secret of canaries) expect(output).not.toContain(secret);
  expect(output).toContain("[redacted]");
  expect(decode(output, format)).toEqual(redactExportMessages(await store.materializeMessages("s"), [canaries[4]!]).messages);
  expect(await fs.readFile(store.pathFor("s"), "utf8")).toBe(before);
  expect(await fs.readFile(path, "utf8")).toBe(JSON.stringify([canaries[4]]));
});

it("redaction clones data, retains plain JSON and prevents redacted key collisions", () => {
  const input: Message[] = [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "tool", input: { safe: [1, null, true], token: "secret", nested: { "opaque-a": 1, "opaque-b": 2 } } }] }];
  const before = structuredClone(input);
  expect(() => redactExportMessages(input, ["opaque-a", "opaque-b"])).toThrow(/collide/);
  expect(input).toEqual(before);
  expect(redactExportMessages(input).messages).not.toEqual(input);
});

it("redacts prefixed structured credentials and truncated private keys", () => {
  const source: Message[] = [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "tool", input: { AWS_SECRET_ACCESS_KEY: "structured-canary", command: "AWS_SECRET_ACCESS_KEY=command-canary" } }, { type: "text", text: "-----BEGIN PRIVATE KEY-----\ntruncated-canary" }] }];
  const output = JSON.stringify(redactExportMessages(source));
  expect(output).not.toContain("structured-canary"); expect(output).not.toContain("command-canary"); expect(output).not.toContain("truncated-canary");
});

it.each(formats)("%s refuses opaque images unless omission is explicit, including nested images", async format => {
  const { store } = await fixture([{ role: "user", content: [{ type: "tool_result", toolUseId: "x", content: [{ type: "image", mediaType: "private-media-canary", data: "base64-secret-canary" }] }] }]);
  await expect(exportSession(store, "s", { format })).rejects.toThrow(/--omit-opaque/);
  const output = await exportSession(store, "s", { format, omitOpaque: true });
  expect(output).not.toContain("private-media-canary"); expect(output).not.toContain("base64-secret-canary");
  expect(output).toContain("explicitly lossy export");
  expect(decode(output, format)).toEqual(redactExportMessages(await store.materializeMessages("s"), [], true).messages);
});

it.each(["unknown-type", "extra-signature"])("refuses %s instead of silently stripping future content", async variant => {
  const { store } = await fixture();
  const rows = (await fs.readFile(store.pathFor("s"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
  if (variant === "unknown-type") rows[1].message.content[0] = { type: "reasoning", signature: "secret-canary" };
  else rows[1].message.content[0].signature = "secret-canary";
  await fs.writeFile(store.pathFor("s"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await expect(exportSession(store, "s", { omitOpaque: true })).rejects.toThrow(/unsupported/);
});

it("actual CLI writes one complete artifact, with no config, credentials or network access", async () => {
  const { root, store } = await fixture();
  await fs.mkdir(join(root, ".agentrig")); await fs.writeFile(join(root, ".agentrig", "config.json"), "{hostile-config-secret");
  const configuration = vi.spyOn(config, "loadRunConfig").mockImplementation(() => { throw new Error("config forbidden"); });
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await buildProgram().parseAsync(["sessions", "export", "s", "--root", root, "--format", "sharegpt"], { from: "user" });
  expect(output).toHaveBeenCalledTimes(1);
  expect(decode(String(output.mock.calls[0]![0]), "sharegpt")).toEqual(await store.materializeMessages("s"));
  expect(configuration).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});

it("CLI refusal never emits partial stdout or includes input/path secrets in errors", async () => {
  const { root, store } = await fixture();
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const input of ["{malformed-secret-canary", '{"type":"future-secret-canary"}', "null"]) {
    await fs.writeFile(store.pathFor("s"), input);
    const error = await buildProgram().parseAsync(["sessions", "export", "s", "--root", root], { from: "user" }).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain("canary");
  }
  const error = await exportSession(store, "../../path-secret-canary").catch(e => e);
  expect(error.message).not.toContain("canary"); expect(output).not.toHaveBeenCalled();
  const invalid = await exportSession(store, "s", { format: "secret-canary" }).catch(e => e);
  expect(invalid.message).not.toContain("canary");
});

it("real CLI process wires explicit redaction and opaque omission, with safe stderr on refusal", async () => {
  const { root, store } = await fixture([{ role: "user", content: [{ type: "text", text: "opaque-secret-canary" }, { type: "image", mediaType: "image/png", data: "image-secret-canary" }] }]);
  await fs.mkdir(join(root, ".agentrig")); await fs.writeFile(join(root, ".agentrig", "config.json"), "{malformed-config-secret");
  const path = join(root, "redactions.json"); await fs.writeFile(path, JSON.stringify(["opaque-secret-canary"]));
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const args = [cli, "sessions", "export", "s", "--root", root, "--redact-file", path];
  const invoke = promisify(execFile);
  const refused = await invoke(process.execPath, args, { cwd: root }).catch(e => e);
  expect(refused.code).toBe(1); expect(refused.stdout).toBe(""); expect(refused.stderr).toContain("--omit-opaque");
  expect(refused.stderr).not.toContain("secret-canary");
  const result = await invoke(process.execPath, [...args, "--omit-opaque", "--format", "md"], { cwd: root });
  expect(result.stderr).toBe(""); expect(result.stdout).not.toContain("secret-canary");
  expect(decode(result.stdout, "md")).toEqual(redactExportMessages(await store.materializeMessages("s"), ["opaque-secret-canary"], true).messages);
}, 15_000);

it.each(["unfinished", "sequence", "identity", "misplaced-fork", "missing-parent", "bad-prefix", "cycle"])("rejects %s source without modifying it", async kind => {
  const { store } = await fixture();
  const rows = (await fs.readFile(store.pathFor("s"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
  if (kind === "unfinished") rows.pop();
  if (kind === "sequence") rows[1].seq = 100;
  if (kind === "identity") rows[1].sessionId = "another";
  if (kind === "misplaced-fork") rows[1] = { ...rows[1], type: "session.fork", parent: "other", atSeq: 0 };
  if (["missing-parent", "bad-prefix", "cycle"].includes(kind)) rows[0] = { ...rows[0], type: "session.fork", parent: kind === "cycle" ? "s" : "parent", atSeq: kind === "bad-prefix" ? 999 : 0 };
  if (kind === "bad-prefix") await store.append("parent", { type: "session.end", reason: "done" });
  const raw = rows.map(row => JSON.stringify(row)).join("\n") + "\n"; await fs.writeFile(store.pathFor("s"), raw);
  await expect(materializeExportMessages(store, "s")).rejects.toThrow();
  expect(await fs.readFile(store.pathFor("s"), "utf8")).toBe(raw);
});

it("enforces byte, event, line, ancestry and JSON nesting caps, with no widening override", async () => {
  const { store } = await fixture();
  await expect(materializeExportMessages(store, "s", { limits: { bytes: 10 } })).rejects.toThrow(/byte/);
  await expect(materializeExportMessages(store, "s", { limits: { events: 1 } })).rejects.toThrow(/event/);
  await expect(materializeExportMessages(store, "s", { limits: { lineBytes: 10 } })).rejects.toThrow(/line/);
  await expect(materializeExportMessages(store, "s", { limits: { events: 50001 } })).rejects.toThrow(/bounds/);
  await store.append("child", { type: "session.fork", parent: "s", atSeq: 1 });
  await store.append("child", { type: "session.end", reason: "done" });
  await expect(materializeExportMessages(store, "child", { limits: { ancestors: 1 } })).rejects.toThrow(/ancestry/);
  await fs.writeFile(store.pathFor("s"), "[".repeat(65) + "0" + "]".repeat(65));
  await expect(materializeExportMessages(store, "s")).rejects.toThrow(/nesting/);
});

it("enforces the final artifact bound with lower-only internal overrides", async () => {
  const { store } = await fixture();
  await expect(exportSession(store, "s", { outputBytes: 1 })).rejects.toThrow(/output bound/);
  await expect(exportSession(store, "s", { outputBytes: 64 * 1024 * 1024 + 1 })).rejects.toThrow(/output bound/);
});

it("refuses nonregular selected files and unfinished ancestors", async () => {
  const { store } = await fixture();
  await fs.mkdir(store.pathFor("directory"));
  await expect(materializeExportMessages(store, "directory")).rejects.toThrow(/regular/);
  await store.append("parent", { type: "session.start", task: "still running", cwd: store.root, model: "fake", provider: "fake" });
  await store.append("child", { type: "session.fork", parent: "parent", atSeq: 0 });
  await store.append("child", { type: "session.end", reason: "done" });
  await expect(materializeExportMessages(store, "child")).rejects.toThrow(/finished/);
});

it("detects a source changed between stat/open and cancellation without output", async () => {
  const { store } = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.lstat).mockImplementationOnce(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await actual.lstat(...args);
    await fs.appendFile(store.pathFor("s"), "\n");
    return result;
  });
  await expect(materializeExportMessages(store, "s")).rejects.toThrow(/changed/);
  const signal = AbortSignal.abort();
  await expect(exportSession(store, "s", { signal })).rejects.toThrow(/cancelled/);
});

it.each(["{secret-canary", '[""]', "[1]", JSON.stringify(Array(257).fill("secret-canary")), JSON.stringify(["x".repeat(65536)])])("rejects invalid or oversized redaction lists safely", async data => {
  const { root, store } = await fixture(); const path = join(root, "redact-secret-canary.json"); await fs.writeFile(path, data);
  const error = await exportSession(store, "s", { redactFile: path }).catch(e => e);
  expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain("secret-canary");
});

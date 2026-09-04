# Provider Routing (R3.5a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one AgentRig process run different roles (main loop, supervisor judges, memory, subagent children) on different named provider entries, with a per-entry reasoning effort and context window, all config-driven and validated at startup.

**Architecture:** Config gains a `providers` map of named entries plus a `roles` block; a new `buildProviders` in the CLI resolves roles to entries (the flat `provider`/`model`/`baseUrl` keys remain the implicit `default` entry) and returns a `ProviderSet` that agent-builder, run, TUI, memory and dream consume instead of one provider. The only core changes are a `reasoningEffort` constructor option on the three adapters and an optional `provider` enum field on the `subagent` tool's input, supplied by the CLI wiring.

**Tech Stack:** TypeScript (strict, ESM, `verbatimModuleSyntax`), zod, vitest, pnpm workspace. Tests import packages by name (`@agentkitai/agentrig-core`) and the CLI's own sources by relative path.

**Spec:** `docs/superpowers/specs/2026-09-04-provider-routing-design.md` (§3 config, §4 effort, §5 wiring, §7 tests, §8 docs). This plan is R3.5a only; R3.5b (skills) is a separate plan.

## Global Constraints

- The event schema in `packages/core/src/events.ts` is untouched by this plan: `session.start` already carries `provider` and `model`.
- `memory` and `supervisor` packages depend on core for types only; this plan does not modify them.
- Credentials never enter config files. The existing `credentialPath` guard must keep rejecting `apiKey`-shaped keys inside a provider entry.
- Entry names match `^[a-z][a-z0-9-]*$`; `default` is reserved. Reasoning effort values are exactly `minimal | low | medium | high | xhigh | max`.
- No new CLI flags. `providers`, `roles`, `contextWindow`, `reasoningEffort` are config-only.
- Failure policy: a role whose entry cannot be built fails at startup with the role and entry named. No fallback between entries.
- Every commit message ends with the two trailers used in this repo:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_016p4FQNz6Bs5NgtsZLTThBG`.
- Work on branch `r3.5a-provider-routing`, created from `spec/provider-routing` so the PR carries the spec: `git checkout -b r3.5a-provider-routing spec/provider-routing`.
- Run a single test file with `pnpm exec vitest run <path>` from the repo root. The final gate is `pnpm build && pnpm test && pnpm typecheck`.

---

## File structure

| File | Responsibility after this plan |
|---|---|
| `packages/core/src/provider.ts` | Adds the `REASONING_EFFORTS` tuple and `ReasoningEffort` type next to `ModelProvider`. |
| `packages/core/src/providers/openai.ts`, `anthropic.ts`, `openai-chatgpt.ts` | Each accepts `reasoningEffort` and puts it on the wire in its own dialect. |
| `packages/core/src/tools/subagent.ts` | Input schema optionally carries a `provider` enum; `childConfig` receives the choice. |
| `packages/cli/src/config.ts` | Zod schema for `providers`, `roles`, flat `contextWindow` and `reasoningEffort`; `loadRunConfig` reports `providerOverride`. |
| `packages/cli/src/provider.ts` | `resolveProviderEntries` (pure), `buildProviders` returning a `ProviderSet`; `buildProvider` kept for the default entry. |
| `packages/cli/src/agent-builder.ts` | Consumes the set: main loop, memory hooks, child wiring with provider choices; `BuiltAgent.providers`. |
| `packages/cli/src/run.ts`, `packages/cli/src/tui/start.tsx` | Supervisor split: accounting from `main`, reviewer and grader from `reviewProvider`. |
| `packages/cli/src/program.ts`, `memory.ts`, `dream.ts` | `memory ingest` and `dream` load config and use the `memory` role. |
| `packages/cli/src/doctor.ts` | Per-entry credential lines and a role table when `providers` is configured. |
| `docs/PLAN.md`, `README.md`, `docs/ROADMAP.md`, `docs/STATUS.md` | Documentation and the inserted R3.5 band. |

---

### Task 1: `reasoningEffort` on the three adapters

**Files:**
- Modify: `packages/core/src/provider.ts` (add after the `ToolSpec` interface, before `ModelRequest`)
- Modify: `packages/core/src/providers/openai.ts:14-31` (options), `:44-66` (`toOpenAIRequest`), `:213-260` (class)
- Modify: `packages/core/src/providers/anthropic.ts:12-22` (options), `:28-45` (`toAnthropicRequest`), `:181-215` (class)
- Modify: `packages/core/src/providers/openai-chatgpt.ts:26-44` (options), `:128-157` (`toResponsesRequest`), `:285-345` (class and `request()`)
- Test: `packages/core/test/openai.test.ts`, `packages/core/test/anthropic.test.ts`, `packages/core/test/openai-chatgpt.test.ts`

**Interfaces:**
- Produces: `export const REASONING_EFFORTS = ["minimal","low","medium","high","xhigh","max"] as const; export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];` from `@agentkitai/agentrig-core`.
- Produces: `reasoningEffort?: ReasoningEffort` on `OpenAIProviderOptions`, `AnthropicProviderOptions`, `OpenAIChatGPTProviderOptions`.
- Produces: `toOpenAIRequest(req, model, maxTokensParam?, reasoningEffort?)`, `toAnthropicRequest(req, model, reasoningEffort?)`, `toResponsesRequest(req, model, rawGroups?, reasoningEffort?)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/openai.test.ts` inside `describe("toOpenAIRequest", ...)`:

```ts
  it("sends reasoning_effort only when configured", () => {
    const plain = toOpenAIRequest(baseReq, "gpt-test") as Record<string, unknown>;
    expect(plain).not.toHaveProperty("reasoning_effort");
    const high = toOpenAIRequest(baseReq, "gpt-test", "max_completion_tokens", "high") as Record<string, unknown>;
    expect(high.reasoning_effort).toBe("high");
  });
```

Append to `packages/core/test/anthropic.test.ts` inside `describe("toAnthropicRequest", ...)`:

```ts
  it("sends output_config.effort only when configured, mapping minimal to low", () => {
    const plain = toAnthropicRequest(baseReq, "claude-test") as Record<string, unknown>;
    expect(plain).not.toHaveProperty("output_config");
    expect((toAnthropicRequest(baseReq, "claude-test", "xhigh") as Record<string, unknown>).output_config).toEqual({ effort: "xhigh" });
    expect((toAnthropicRequest(baseReq, "claude-test", "minimal") as Record<string, unknown>).output_config).toEqual({ effort: "low" });
  });
```

Append to `packages/core/test/openai-chatgpt.test.ts` inside `describe("toResponsesRequest", ...)`:

```ts
  it("sends reasoning.effort only when configured", () => {
    const plain = toResponsesRequest(baseReq, "gpt-5.6-sol") as Record<string, unknown>;
    expect(plain).not.toHaveProperty("reasoning");
    const max = toResponsesRequest(baseReq, "gpt-5.6-sol", undefined, "max") as Record<string, unknown>;
    expect(max.reasoning).toEqual({ effort: "max" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/core/test/openai.test.ts packages/core/test/anthropic.test.ts packages/core/test/openai-chatgpt.test.ts`
Expected: the three new tests FAIL (the 4th/3rd argument is ignored today, so the property is absent).

- [ ] **Step 3: Add the shared type in core**

In `packages/core/src/provider.ts`, after the `ToolSpec` interface:

```ts
/** Effort levels an entry may pin; each adapter maps them onto its own wire field. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
```

- [ ] **Step 4: OpenAI-compatible adapter**

In `packages/core/src/providers/openai.ts`, import the type: change the second import line to
`import type { ModelEvent, ModelProvider, ModelRequest, ReasoningEffort, StopReason } from "../provider.js";`

Add to `OpenAIProviderOptions` after `maxTokensParam`:

```ts
  /** Pinned reasoning effort, sent as `reasoning_effort`. Omitted when unset. */
  reasoningEffort?: ReasoningEffort;
```

Change the `toOpenAIRequest` signature and add one line before `return body;`:

```ts
export function toOpenAIRequest(
  req: ModelRequest,
  model: string,
  maxTokensParam: "max_tokens" | "max_completion_tokens" = "max_completion_tokens",
  reasoningEffort?: ReasoningEffort,
): JsonObject {
  // ...existing body construction unchanged...
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
  return body;
}
```

In the class: add the field `private readonly reasoningEffort: ReasoningEffort | undefined;`, set `this.reasoningEffort = opts.reasoningEffort;` in the constructor, and change the request body line in `stream()` to
`body: JSON.stringify(toOpenAIRequest(req, this.model, this.maxTokensParam, this.reasoningEffort)),`.

- [ ] **Step 5: Anthropic adapter**

In `packages/core/src/providers/anthropic.ts`, import: `import type { ModelEvent, ModelProvider, ModelRequest, ReasoningEffort, StopReason } from "../provider.js";`

Add to `AnthropicProviderOptions` after `contextWindow`:

```ts
  /** Pinned effort, sent as `output_config.effort`; `minimal` maps to `low`. Omitted when unset. */
  reasoningEffort?: ReasoningEffort;
```

Change `toAnthropicRequest`:

```ts
export function toAnthropicRequest(req: ModelRequest, model: string, reasoningEffort?: ReasoningEffort): JsonObject {
  // ...existing body construction unchanged...
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (reasoningEffort !== undefined) {
    body.output_config = { effort: reasoningEffort === "minimal" ? "low" : reasoningEffort };
  }
  return body;
}
```

In the class: add `private readonly reasoningEffort: ReasoningEffort | undefined;`, set it in the constructor, and pass it where the body is built. Find the line `body: JSON.stringify(toAnthropicRequest(req, this.model)),` in `stream()` and change it to `body: JSON.stringify(toAnthropicRequest(req, this.model, this.reasoningEffort)),`.

- [ ] **Step 6: openai-chatgpt adapter**

In `packages/core/src/providers/openai-chatgpt.ts`, import: `import type { ModelEvent, ModelProvider, ModelRequest, ReasoningEffort, StopReason } from "../provider.js";`

Add to `OpenAIChatGPTProviderOptions` after `contextWindow`:

```ts
  /** Pinned reasoning effort, sent as `reasoning: { effort }`. Omitted when unset. */
  reasoningEffort?: ReasoningEffort;
```

Change `toResponsesRequest`:

```ts
export function toResponsesRequest(
  req: ModelRequest,
  model: string,
  rawGroups?: Map<string, RawItemGroup>,
  reasoningEffort?: ReasoningEffort,
): JsonObject {
  // ...existing body construction unchanged...
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (reasoningEffort !== undefined) body.reasoning = { effort: reasoningEffort };
  return body;
}
```

In the class: add `private readonly reasoningEffort: ReasoningEffort | undefined;`, set `this.reasoningEffort = opts.reasoningEffort;` in the constructor, and in `request()` change the body line to
`body: JSON.stringify(toResponsesRequest(req, this.model, this.rawGroups, this.reasoningEffort)),`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/core/test/openai.test.ts packages/core/test/anthropic.test.ts packages/core/test/openai-chatgpt.test.ts`
Expected: PASS, including every pre-existing test in those files.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/provider.ts packages/core/src/providers/openai.ts packages/core/src/providers/anthropic.ts packages/core/src/providers/openai-chatgpt.ts packages/core/test/openai.test.ts packages/core/test/anthropic.test.ts packages/core/test/openai-chatgpt.test.ts
git commit -m "feat(core): reasoningEffort on the three adapters, sent only when set (R3.5a)"
```

---

### Task 2: `provider` choice on the subagent tool

**Files:**
- Modify: `packages/core/src/tools/subagent.ts:26-33` (schema), `:35-43` (`SubagentOptions.childConfig`), `:115-203` (`subagentTool`)
- Test: `packages/core/test/subagent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SubagentProviderChoices { names: string[]; default: string; main: string }
  export interface SubagentChoice { provider?: string }
  // on SubagentOptions:
  childConfig: (choice?: SubagentChoice) => AgentConfig;
  providerChoices?: SubagentProviderChoices;
  ```
- Consumers that pass `childConfig: () => ...` keep compiling (a zero-arg function is assignable).

- [ ] **Step 1: Write the failing tests**

Append a new `describe` at the end of `packages/core/test/subagent.test.ts`. It needs only `subagentTool` and `z`, both already imported there:

```ts
describe("provider choice on the spawn tool", () => {
  const noop = { createAgent: () => { throw new Error("not spawned in this test"); }, childConfig: () => ({}) as never };

  it("has no provider field at all when the caller supplies no choices", () => {
    const tool = subagentTool(noop);
    const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(shape).sort()).toEqual(["label", "task"]);
  });

  it("offers exactly the configured names, optional, and rejects an unknown one", () => {
    const tool = subagentTool({ ...noop, providerChoices: { names: ["cloud", "local"], default: "local", main: "cloud" } });
    const schema = tool.inputSchema as z.ZodObject<z.ZodRawShape>;
    expect(schema.safeParse({ task: "t" }).success).toBe(true);
    expect(schema.safeParse({ task: "t", provider: "cloud" }).success).toBe(true);
    expect(schema.safeParse({ task: "t", provider: "nope" }).success).toBe(false);
    expect(schema.shape.provider!.description).toContain("default: local");
    expect(schema.shape.provider!.description).toContain("main session runs on cloud");
  });

  it("hands the chosen name to childConfig and passes undefined when none was named", async () => {
    const seen: Array<string | undefined> = [];
    const store = new SessionStore({ root: await mkdtemp(join(tmpdir(), "agentrig-spawn-choice-")) });
    const tool = subagentTool({
      providerChoices: { names: ["cloud", "local"], default: "local", main: "cloud" },
      childConfig: (choice) => {
        seen.push(choice?.provider);
        return {
          provider: new ScriptedProvider([[say("done"), usage(1, 1), stop("end_turn")]]),
          tools: [],
          permissions: new RulePolicy([]),
          store,
        } as unknown as AgentConfig;
      },
      createAgent,
    });
    const ctx = { sessionId: "parent", cwd: process.cwd(), signal: new AbortController().signal } as never;
    await tool.execute({ task: "a", provider: "cloud" }, ctx);
    await tool.execute({ task: "b" }, ctx);
    expect(seen).toEqual(["cloud", undefined]);
  });
});
```

Before running: the `childConfig` return object and the `ctx` literal above are sketches. Copy the exact child `AgentConfig` shape and the exact `ToolContext` object that an existing test in this file already passes to `tool.execute` (search the file for `execute(` and `childConfig:`), and keep only the `seen.push(choice?.provider)` line as the addition. The assertion `expect(seen).toEqual(["cloud", undefined])` is the point of the test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/test/subagent.test.ts -t "provider choice"`
Expected: FAIL. The first test fails only if the field leaks in; the second fails because `providerChoices` is not an accepted option and there is no `provider` in the shape; the third fails because `childConfig` receives no argument.

- [ ] **Step 3: Implement the schema factory and options**

In `packages/core/src/tools/subagent.ts`, replace the `const Input = z.object({...})` block (lines 26-33) with:

```ts
/** Which named provider entries a child may run on, and which of them are the defaults. */
export interface SubagentProviderChoices {
  /** Entry names offered to the model, in the order shown. Empty means no choice is offered. */
  names: string[];
  /** The entry a child gets when none is named. */
  default: string;
  /** The entry the main session runs on, so a skill can say "the main entry" without hardcoding a name. */
  main: string;
}

/** What the model chose at spawn time. */
export interface SubagentChoice {
  provider?: string;
}

interface Input {
  task: string;
  label?: string;
  provider?: string;
}

const baseShape = {
  task: z
    .string()
    .min(1)
    .describe("a complete, self-contained instruction — the subagent sees none of this conversation"),
  /** Named so a trajectory reads sensibly; the model picks something short. */
  label: z.string().max(60).optional().describe("a few words naming what this subagent is for"),
};

/** The schema is byte-identical to the pre-R3.5 one unless choices are supplied. */
function inputSchema(choices: SubagentProviderChoices | undefined): z.ZodType<Input> {
  if (choices === undefined || choices.names.length === 0) return z.object(baseShape);
  const [first, ...rest] = choices.names as [string, ...string[]];
  return z.object({
    ...baseShape,
    provider: z
      .enum([first, ...rest])
      .optional()
      .describe(`named provider entry for this child (default: ${choices.default}; the main session runs on ${choices.main})`),
  });
}
```

In `SubagentOptions`, change `childConfig: () => AgentConfig;` to `childConfig: (choice?: SubagentChoice) => AgentConfig;` and add after `createAgent`:

```ts
  /** Supplied by the CLI when config defines named provider entries; absent otherwise. */
  providerChoices?: SubagentProviderChoices;
```

- [ ] **Step 4: Thread the choice through `subagentTool`**

In `subagentTool`, replace `inputSchema: Input,` with `inputSchema: inputSchema(opts.providerChoices),` and change the execute signature to `execute: async (input: Input, ctx: ToolContext): Promise<ToolResult<unknown>> => {`.

Replace `const config = opts.childConfig();` with:

```ts
      const choice: SubagentChoice | undefined = input.provider === undefined ? undefined : { provider: input.provider };
      const config = opts.childConfig(choice);
```

In the grandchild re-wrap, change `childConfig: () => ({ ...opts.childConfig(), abortGraceMs: childGrace }),` to
`childConfig: (grandchildChoice) => ({ ...opts.childConfig(grandchildChoice), abortGraceMs: childGrace }),`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/core/test/subagent.test.ts`
Expected: PASS, all tests in the file (the existing ones prove the no-choice schema and behaviour are unchanged).

- [ ] **Step 6: Typecheck core**

Run: `pnpm --filter @agentkitai/agentrig-core run typecheck`
Expected: clean. If `AnyTool.inputSchema` is typed narrower than `z.ZodType<Input>`, widen the return type of `inputSchema()` to whatever `AnyTool` expects rather than casting at the call site.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tools/subagent.ts packages/core/test/subagent.test.ts
git commit -m "feat(core): subagent tool accepts a named provider choice when the harness offers one (R3.5a)"
```

---

### Task 3: Config schema for `providers`, `roles`, `contextWindow`, `reasoningEffort`

**Files:**
- Modify: `packages/cli/src/config.ts:1-72` (schema), `:87-95` (`credentialPath`), `:280-300` (`loadRunConfig` return)
- Test: `packages/cli/test/config.test.ts`

**Interfaces:**
- Produces (exported from `packages/cli/src/config.ts`):
  ```ts
  export const ROLES = ["main", "supervisor", "memory", "subagents"] as const;
  export type Role = (typeof ROLES)[number];
  export type ProviderKind = "anthropic" | "openai" | "openai-chatgpt";
  export interface ProviderEntry { provider: ProviderKind; model: string; baseUrl?: string; contextWindow?: number; reasoningEffort?: ReasoningEffort }
  export type Roles = Partial<Record<Role, string>>;
  // ConfigValues gains: contextWindow?: number; reasoningEffort?: ReasoningEffort; providers?: Record<string, ProviderEntry>; roles?: Roles
  // loadRunConfig's return gains: providerOverride: boolean
  ```

- [ ] **Step 1: Write the failing tests**

Add a new `describe` to `packages/cli/test/config.test.ts`. It uses `parseConfigText` (add it to the existing import from `../src/config.ts`) and the existing `fixture`, `configAt`, `buildProgram` helpers:

```ts
describe("providers and roles (R3.5a)", () => {
  const valid = {
    providers: {
      cloud: { provider: "openai-chatgpt", model: "gpt-5.6-sol", reasoningEffort: "max" },
      local: { provider: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3.8-27b", contextWindow: 98304 },
    },
    roles: { main: "cloud", supervisor: "cloud", memory: "cloud", subagents: "local" },
  };

  it("parses named entries with effort and context window, at top level and inside a profile", () => {
    const top = parseConfigText("c", JSON.stringify(valid));
    expect(top.providers?.local?.contextWindow).toBe(98304);
    expect(top.providers?.cloud?.reasoningEffort).toBe("max");
    expect(top.roles).toEqual(valid.roles);
    const inProfile = parseConfigText("c", JSON.stringify({ profiles: { personal: valid } }));
    expect(inProfile.profiles?.personal?.roles?.subagents).toBe("local");
  });

  it("rejects a bad entry name, the reserved name default, and an unknown effort", () => {
    expect(() => parseConfigText("c", JSON.stringify({ providers: { Cloud: { provider: "openai", model: "m" } } }))).toThrow(/providers\.Cloud/);
    expect(() => parseConfigText("c", JSON.stringify({ providers: { default: { provider: "openai", model: "m" } } }))).toThrow(/reserved/);
    expect(() => parseConfigText("c", JSON.stringify({ providers: { a: { provider: "openai", model: "m", reasoningEffort: "ultra" } } }))).toThrow(/providers\.a\.reasoningEffort/);
  });

  it("requires a model per entry and rejects unknown entry keys and unknown roles", () => {
    expect(() => parseConfigText("c", JSON.stringify({ providers: { a: { provider: "openai" } } }))).toThrow(/providers\.a\.model/);
    expect(() => parseConfigText("c", JSON.stringify({ providers: { a: { provider: "openai", model: "m", temperature: 1 } } }))).toThrow(/providers\.a\.temperature/);
    expect(() => parseConfigText("c", JSON.stringify({ roles: { planner: "a" } }))).toThrow(/roles\.planner/);
  });

  it("still refuses a credential inside an entry, but allows an entry NAMED like one", () => {
    expect(() => parseConfigText("c", JSON.stringify({ providers: { a: { provider: "openai", model: "m", apiKey: "sk-x" } } }))).toThrow(/credentials cannot be stored/);
    expect(parseConfigText("c", JSON.stringify({ providers: { token: { provider: "openai", model: "m" } } })).providers?.token?.model).toBe("m");
  });

  it("replaces providers and roles wholesale across layers, never merging", () => {
    const resolved = resolveConfig({
      defaults: {},
      user: file({ providers: { cloud: { provider: "openai", model: "u" }, extra: { provider: "openai", model: "e" } } }),
      project: file({ providers: { cloud: { provider: "openai", model: "p" } } }),
    });
    expect(Object.keys(resolved.providers ?? {})).toEqual(["cloud"]);
    expect(resolved.providers?.cloud?.model).toBe("p");
  });

  it("parses the flat contextWindow and reasoningEffort keys for the default entry", () => {
    const parsed = parseConfigText("c", JSON.stringify({ contextWindow: 98304, reasoningEffort: "high" }));
    expect(parsed.contextWindow).toBe(98304);
    expect(parsed.reasoningEffort).toBe("high");
    expect(() => parseConfigText("c", JSON.stringify({ contextWindow: 0 }))).toThrow(/contextWindow/);
  });

  it("reports providerOverride only for typed provider flags or AGENTRIG_MODEL, not for config values", async () => {
    const { cwd, home } = await fixture();
    await configAt(home, { model: "from-config", ...valid });
    // a fresh program per call: commander keeps parsed option values on the command object,
    // so a reused `run` would carry the earlier --model over into the next case
    const load = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
      const run = buildProgram().commands.find((c) => c.name() === "run")!;
      run.parseOptions(argv);
      return loadRunConfig(run, { ...run.opts(), root: ".agentrig" }, { cwd, home, env, interactive: false });
    };
    expect((await load([])).providerOverride).toBe(false);
    expect((await load(["--model", "typed"])).providerOverride).toBe(true);
    expect((await load([], { AGENTRIG_MODEL: "from-env" })).providerOverride).toBe(true);
  });
});
```

Add `loadRunConfig` and `parseConfigText` to the import from `../src/config.ts` if they are not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/cli/test/config.test.ts -t "providers and roles"`
Expected: FAIL with "Unrecognized setting" at `providers` (the schema is strict).

- [ ] **Step 3: Implement the schema**

In `packages/cli/src/config.ts`, add `import { REASONING_EFFORTS, type ReasoningEffort } from "@agentkitai/agentrig-core";` next to the zod import. Replace the top of `ConfigValuesSchema` and add the new schemas above it:

```ts
const ProviderKindSchema = z.enum(["anthropic", "openai", "openai-chatgpt"]);
export type ProviderKind = z.output<typeof ProviderKindSchema>;
const reasoningEffortSetting = z.enum(REASONING_EFFORTS);
const contextWindowSetting = z.number().int().positive();

/** One named provider entry. Credentials never appear here; they come from the environment per kind. */
export const ProviderEntrySchema = z
  .object({
    provider: ProviderKindSchema,
    model: z.string().min(1),
    baseUrl: z.string().url().optional(),
    contextWindow: contextWindowSetting.optional(),
    reasoningEffort: reasoningEffortSetting.optional(),
  })
  .strict();
export type ProviderEntry = z.output<typeof ProviderEntrySchema>;

export const ROLES = ["main", "supervisor", "memory", "subagents"] as const;
export type Role = (typeof ROLES)[number];
const RolesSchema = z
  .object({ main: z.string().min(1).optional(), supervisor: z.string().min(1).optional(), memory: z.string().min(1).optional(), subagents: z.string().min(1).optional() })
  .strict();
export type Roles = z.output<typeof RolesSchema>;

const ENTRY_NAME = /^[a-z][a-z0-9-]*$/;
const providersSetting = z.record(ProviderEntrySchema).superRefine((entries, ctx) => {
  for (const name of Object.keys(entries)) {
    if (name === "default") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'the entry name "default" is reserved for the flat provider/model keys' });
    } else if (!ENTRY_NAME.test(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: "entry names must match ^[a-z][a-z0-9-]*$" });
    }
  }
});
```

Then in `ConfigValuesSchema` change `provider: z.enum([...]).optional()` to `provider: ProviderKindSchema.optional()` and add, after `baseUrl`:

```ts
    contextWindow: contextWindowSetting.optional(),
    reasoningEffort: reasoningEffortSetting.optional(),
    providers: providersSetting.optional(),
    roles: RolesSchema.optional(),
```

Keep `ReasoningEffort` referenced so the import is used: `export type { ReasoningEffort };` at the bottom of the file, or use it in the `ProviderEntry` doc comment via `satisfies`. The simplest is to export the type alias: `export type ProviderReasoningEffort = ReasoningEffort;` is not needed; prefer `export type { ReasoningEffort } from "@agentkitai/agentrig-core";` as a separate line so downstream CLI code imports one place.

- [ ] **Step 4: Exempt entry names from the credential guard**

In `credentialPath`, change the profile exemption line to exempt names directly under `providers` too:

```ts
    // Profile and provider-entry names are labels, not setting keys; a profile or entry named
    // "secret" carries no secret. Their VALUES are still walked.
    const parentIsLabelMap = path.length >= 1 && (path[path.length - 1] === "profiles" || path[path.length - 1] === "providers");
    if (!parentIsLabelMap && CREDENTIAL_KEY.test(key)) return next;
```

Note this must still catch `providers.a.apiKey` (parent key is `a`, not `providers`) — the test in Step 1 pins that.

- [ ] **Step 5: Report `providerOverride` from `loadRunConfig`**

In the returned object at the end of `loadRunConfig`, add after `modelExplicit`:

```ts
    // R3.5a: typed provider flags (or AGENTRIG_MODEL) pin the MAIN role to the flat default entry;
    // a `model` that came from config does not, or `roles.main` could never win over a profile's model
    providerOverride:
      cli.provider !== undefined || cli.model !== undefined || cli.baseUrl !== undefined || environment.AGENTRIG_MODEL !== undefined,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/cli/test/config.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/test/config.test.ts
git commit -m "feat(cli): config schema for named provider entries, roles, contextWindow, reasoningEffort (R3.5a)"
```

---

### Task 4: `resolveProviderEntries` and `buildProviders`

**Files:**
- Modify: `packages/cli/src/provider.ts` (whole file; `buildProvider` and `describeRetry` keep their signatures)
- Test: `packages/cli/test/providers.test.ts` (new)

**Interfaces:**
- Consumes: `ProviderEntry`, `Roles`, `Role`, `ROLES` from `./config.js`; `ReasoningEffort` from core.
- Produces:
  ```ts
  export interface ProviderOptions {
    provider: string; model: string; baseUrl?: string;
    contextWindow?: number; reasoningEffort?: ReasoningEffort;
    providers?: Record<string, ProviderEntry>; roles?: Roles;
    modelExplicit?: boolean; providerOverride?: boolean; maxTokensPerTurnExplicit?: boolean;
  }
  export interface ResolvedEntries { entries: Record<string, ProviderEntry>; roleNames: Record<Role, string> }
  export function resolveProviderEntries(opts: ProviderOptions): ResolvedEntries
  export interface ProviderSet {
    main: ModelProvider; supervisor: ModelProvider; memory: ModelProvider; subagents: ModelProvider;
    roleNames: Record<Role, string>;
    names: string[];               // every entry name, "default" last
    get(name: string): ModelProvider;
  }
  export function buildProviders(opts: ProviderOptions, hooks?: ProviderHooks): ProviderSet
  export function buildProvider(opts: ProviderOptions, hooks?: ProviderHooks): ModelProvider  // unchanged: the default entry
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/providers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProviders, resolveProviderEntries, type ProviderOptions } from "../src/provider.ts";

const base: ProviderOptions = {
  provider: "openai",
  model: "default-model",
  baseUrl: "http://127.0.0.1:1/v1",
  modelExplicit: true,
  providers: {
    cloud: { provider: "openai", model: "cloud-model", baseUrl: "http://127.0.0.1:2/v1", reasoningEffort: "max" },
    local: { provider: "openai", model: "local-model", baseUrl: "http://127.0.0.1:3/v1", contextWindow: 98304 },
  },
  roles: { main: "cloud", subagents: "local" },
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveProviderEntries", () => {
  it("falls back role → main → default", () => {
    const r = resolveProviderEntries(base);
    expect(r.roleNames).toEqual({ main: "cloud", supervisor: "cloud", memory: "cloud", subagents: "local" });
    expect(Object.keys(r.entries).sort()).toEqual(["cloud", "default", "local"]);
    expect(r.entries.default).toEqual({ provider: "openai", model: "default-model", baseUrl: "http://127.0.0.1:1/v1" });
  });

  it("with no providers block every role is the flat default entry", () => {
    const r = resolveProviderEntries({ provider: "anthropic", model: "m" });
    expect(r.roleNames).toEqual({ main: "default", supervisor: "default", memory: "default", subagents: "default" });
  });

  it("a typed provider flag moves ONLY main to default", () => {
    const r = resolveProviderEntries({ ...base, providerOverride: true });
    expect(r.roleNames).toEqual({ main: "default", supervisor: "cloud", memory: "cloud", subagents: "local" });
  });

  it("names the role and the missing entry", () => {
    expect(() => resolveProviderEntries({ ...base, roles: { memory: "wiki" } })).toThrow(/role memory names unknown provider entry "wiki"; defined entries: cloud, default, local/);
  });

  it("carries the flat contextWindow and reasoningEffort into the default entry", () => {
    const r = resolveProviderEntries({ provider: "openai", model: "m", baseUrl: "http://x/v1", contextWindow: 4096, reasoningEffort: "low" });
    expect(r.entries.default).toEqual({ provider: "openai", model: "m", baseUrl: "http://x/v1", contextWindow: 4096, reasoningEffort: "low" });
  });
});

describe("buildProviders", () => {
  it("builds one instance per entry and shares it across roles", () => {
    const set = buildProviders(base);
    expect(set.main).toBe(set.supervisor);
    expect(set.main).toBe(set.memory);
    expect(set.subagents).not.toBe(set.main);
    expect(set.main.model).toBe("cloud-model");
    expect(set.subagents.model).toBe("local-model");
    expect(set.get("local")).toBe(set.subagents);
    expect(set.names).toEqual(["cloud", "local", "default"]);
    expect(set.roleNames.subagents).toBe("local");
  });

  it("applies contextWindow to the adapter", () => {
    expect(buildProviders(base).subagents.capabilities.contextWindow).toBe(98304);
  });

  it("fails at construction naming the role and entry when a credential is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const opts: ProviderOptions = { ...base, providers: { ...base.providers, judge: { provider: "anthropic", model: "claude-x" } }, roles: { supervisor: "judge" } };
    expect(() => buildProviders(opts)).toThrow(/role supervisor \(provider entry "judge"\): ANTHROPIC_API_KEY is not set/);
  });

  it("get() rejects a name that is not an entry", () => {
    expect(() => buildProviders(base).get("nope")).toThrow(/unknown provider entry "nope"/);
  });

  it("does not construct an entry no role references until get() asks for it", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const opts: ProviderOptions = { ...base, providers: { ...base.providers, spare: { provider: "anthropic", model: "claude-x" } } };
    const set = buildProviders(opts);
    expect(set.names).toContain("spare");
    expect(() => set.get("spare")).toThrow(/ANTHROPIC_API_KEY/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/cli/test/providers.test.ts`
Expected: FAIL, `resolveProviderEntries`/`buildProviders` are not exported.

- [ ] **Step 3: Rewrite `packages/cli/src/provider.ts`**

Replace the file's contents with the following. `describeRetry` and `DEFAULT_ANTHROPIC_MODEL` are unchanged; `buildProvider` keeps its behaviour by building the default entry.

```ts
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  OpenAIChatGPTProvider,
  type ModelProvider,
  type ReasoningEffort,
  type StreamRetryInfo,
} from "@agentkitai/agentrig-core";
import { ROLES, type ProviderEntry, type Role, type Roles } from "./config.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** The provider flags shared by every command that talks to a model, plus the R3.5a config keys. */
export interface ProviderOptions {
  provider: string;
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
  /** Named entries from config; the flat keys above are the implicit `default` entry. */
  providers?: Record<string, ProviderEntry>;
  roles?: Roles;
  /** True when the model came from --model or AGENTRIG_MODEL rather than the built-in default. */
  modelExplicit?: boolean;
  /** True when --provider/--model/--base-url or AGENTRIG_MODEL overrode config: main is then `default`. */
  providerOverride?: boolean;
  /** True when the user actually typed --max-tokens-per-turn; the flag has a default otherwise. */
  maxTokensPerTurnExplicit?: boolean;
}

export interface ProviderHooks {
  /** Where retry notices go — the TUI frame or stderr. Silent retries look like hangs. */
  onNotice?: (message: string) => void;
}

/** One phrasing for every provider, so the three adapters cannot drift. */
export function describeRetry(info: StreamRetryInfo): string {
  // `attempt` is the one that just FAILED — saying "retrying (attempt 1 of 4)" when attempt 1
  // is already spent misread as "this is the first try"
  return `provider error (${info.reason}) — attempt ${info.attempt} of ${info.maxAttempts} failed, retrying in ${Math.round(info.delayMs / 1000)}s`;
}

export interface ResolvedEntries {
  entries: Record<string, ProviderEntry>;
  roleNames: Record<Role, string>;
}

/**
 * Pure: which entry each role resolves to. `default` is always present and is the flat keys;
 * `roles[r] ?? roles.main ?? "default"`; typed provider flags pin main to `default` so today's
 * `agentrig run --model x` keeps meaning "run the main loop on x".
 */
export function resolveProviderEntries(opts: ProviderOptions): ResolvedEntries {
  const defaultEntry: ProviderEntry = {
    provider: opts.provider as ProviderEntry["provider"],
    model: opts.model,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.contextWindow === undefined ? {} : { contextWindow: opts.contextWindow }),
    ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
  };
  const entries: Record<string, ProviderEntry> = { ...(opts.providers ?? {}), default: defaultEntry };
  const configured = (role: Role): string => opts.roles?.[role] ?? opts.roles?.main ?? "default";
  const roleNames = {
    main: opts.providerOverride === true ? "default" : configured("main"),
    supervisor: configured("supervisor"),
    memory: configured("memory"),
    subagents: configured("subagents"),
  } satisfies Record<Role, string>;
  for (const role of ROLES) {
    const name = roleNames[role];
    if (!(name in entries)) {
      throw new Error(
        `role ${role} names unknown provider entry ${JSON.stringify(name)}; defined entries: ${Object.keys(entries).sort().join(", ")}`,
      );
    }
  }
  return { entries, roleNames };
}

/** Constructs one entry. `requireExplicitModel` guards only the flat default, whose model has a built-in fallback. */
function buildEntry(name: string, entry: ProviderEntry, opts: ProviderOptions, hooks: ProviderHooks): ModelProvider {
  const onRetry =
    hooks.onNotice === undefined
      ? {}
      : { onRetry: (info: StreamRetryInfo) => hooks.onNotice?.(describeRetry(info)) };
  const tuning = {
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort }),
  };
  const modelExplicit = name !== "default" || opts.modelExplicit === true;
  if (entry.provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider({ apiKey, model: entry.model, ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }), ...tuning, ...onRetry });
  }
  if (entry.provider === "openai") {
    if (!modelExplicit) throw new Error("--model is required with --provider openai");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey && entry.baseUrl === undefined) {
      throw new Error("OPENAI_API_KEY is not set (or pass --base-url for a local server)");
    }
    return new OpenAICompatibleProvider({
      model: entry.model,
      ...(apiKey ? { apiKey } : {}),
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
      ...tuning,
      ...onRetry,
    });
  }
  if (entry.provider === "openai-chatgpt") {
    if (!modelExplicit) throw new Error("--model is required with --provider openai-chatgpt (e.g. gpt-5.6-sol)");
    // experimental subscription auth; tokens come from `agentrig login openai-chatgpt`
    console.error("Warning: --provider openai-chatgpt is experimental and uses an undocumented ChatGPT backend.");
    // the backend rejects `max_output_tokens` outright, so the flag cannot be honoured here.
    // Say so rather than accepting a number and quietly not sending it.
    if (opts.maxTokensPerTurnExplicit === true) {
      console.error("Warning: --max-tokens-per-turn is ignored by openai-chatgpt (the backend rejects the parameter).");
    }
    return new OpenAIChatGPTProvider({ model: entry.model, ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }), ...tuning, ...onRetry });
  }
  throw new Error(`unknown provider "${String(entry.provider)}" (anthropic | openai | openai-chatgpt)`);
}

/** Every role's provider, built once per entry. Roles are constructed eagerly; `get` builds lazily. */
export interface ProviderSet {
  main: ModelProvider;
  supervisor: ModelProvider;
  memory: ModelProvider;
  subagents: ModelProvider;
  /** Which entry each role resolved to, by name. */
  roleNames: Record<Role, string>;
  /** Every entry name, named ones in config order and `default` last — the spawn tool's menu. */
  names: string[];
  /** An entry by name, constructed on first use; throws for a name that is not an entry. */
  get(name: string): ModelProvider;
}

export function buildProviders(opts: ProviderOptions, hooks: ProviderHooks = {}): ProviderSet {
  const { entries, roleNames } = resolveProviderEntries(opts);
  const built = new Map<string, ModelProvider>();
  const get = (name: string): ModelProvider => {
    const entry = entries[name];
    if (entry === undefined) {
      throw new Error(`unknown provider entry ${JSON.stringify(name)}; defined entries: ${Object.keys(entries).sort().join(", ")}`);
    }
    let provider = built.get(name);
    if (provider === undefined) {
      provider = buildEntry(name, entry, opts, hooks);
      built.set(name, provider);
    }
    return provider;
  };
  const forRole = (role: Role): ModelProvider => {
    try {
      return get(roleNames[role]);
    } catch (err) {
      throw new Error(`role ${role} (provider entry ${JSON.stringify(roleNames[role])}): ${(err as Error).message}`);
    }
  };
  // eager, in a fixed order, so a broken entry fails the run before any session starts
  const main = forRole("main");
  const supervisor = forRole("supervisor");
  const memory = forRole("memory");
  const subagents = forRole("subagents");
  const names = [...Object.keys(entries).filter((n) => n !== "default"), "default"];
  return { main, supervisor, memory, subagents, roleNames, names, get };
}

/** The flat default entry alone — what every command built before R3.5a. */
export function buildProvider(opts: ProviderOptions, hooks: ProviderHooks = {}): ModelProvider {
  // strip the named entries so a bad `roles` block cannot fail a command that only wants the default
  const { providers: _providers, roles: _roles, ...flat } = opts;
  const { entries } = resolveProviderEntries(flat);
  return buildEntry("default", entries.default!, opts, hooks);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/cli/test/providers.test.ts packages/cli/test/provider-flags.test.ts`
Expected: PASS. `provider-flags.test.ts` still passes because `buildProvider`'s messages and warnings are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/provider.ts packages/cli/test/providers.test.ts
git commit -m "feat(cli): buildProviders resolves roles to named entries into one ProviderSet (R3.5a)"
```

---

### Task 5: Agent builder consumes the set; children get a provider choice

**Files:**
- Modify: `packages/cli/src/agent-builder.ts:225-236` (`BuiltAgent`), `:292-304` (`SubagentWiring`), `:333-345` (`childConfig`), `:373-374` (build), `:433-452` (hooks), `:479-495` (spawn wiring), `:522` (return)
- Test: `packages/cli/test/subagent-wiring.test.ts`

**Interfaces:**
- Consumes: `buildProviders`, `ProviderSet` from `./provider.js`; `SubagentProviderChoices` from core (Task 2).
- Produces: `SubagentWiring.providers: ProviderSet` (replaces `provider`); `BuiltAgent.providers: ProviderSet` with `provider` kept as `providers.main`.

- [ ] **Step 1: Update the test helper and add the failing tests**

In `packages/cli/test/subagent-wiring.test.ts`, replace the `wiring()` helper's `provider,` line with a set built from fakes. Add above `wiring`:

```ts
import type { ProviderSet } from "../src/provider.ts";

const second: ModelProvider = { ...provider, id: "fake-2", model: "fake-2" };
function fakeSet(over: Partial<ProviderSet> = {}): ProviderSet {
  const byName: Record<string, ModelProvider> = { cloud: provider, local: second, default: provider };
  return {
    main: provider,
    supervisor: provider,
    memory: provider,
    subagents: second,
    roleNames: { main: "cloud", supervisor: "cloud", memory: "cloud", subagents: "local" },
    names: ["cloud", "local", "default"],
    get: (name) => {
      const p = byName[name];
      if (p === undefined) throw new Error(`unknown provider entry "${name}"`);
      return p;
    },
    ...over,
  };
}
```

and in `wiring()` replace `provider,` with `providers: fakeSet(),`. Then add a new `describe`:

```ts
describe("which provider a child runs on (R3.5a)", () => {
  it("defaults to the subagents role, never the parent's main provider", () => {
    expect(wiring().childConfig().provider).toBe(second);
    expect(wiring().childConfig(undefined).provider).toBe(second);
  });

  it("honours an explicit entry name from the spawn call", () => {
    expect(wiring().childConfig({ provider: "cloud" }).provider).toBe(provider);
  });

  it("offers the entry menu only when config defines named entries", () => {
    const withEntries = wiring({
      opts: {
        root, maxTurns: "10", maxTokensPerTurn: "1024", provider: "anthropic", model: "m",
        providers: { cloud: { provider: "openai", model: "c" }, local: { provider: "openai", model: "l", baseUrl: "http://x/v1" } },
      } as AgentBuildOptions,
    });
    expect(withEntries.providerChoices).toEqual({ names: ["cloud", "local", "default"], default: "local", main: "cloud" });
    expect(wiring().providerChoices).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/cli/test/subagent-wiring.test.ts`
Expected: the file fails to typecheck/run because `SubagentWiring` has `provider`, not `providers`.

- [ ] **Step 3: Rewire `agent-builder.ts`**

Change the import from `./provider.js` to `import { buildProviders, type ProviderSet } from "./provider.js";` (keep any other names it already imports from there).

`BuiltAgent`: add `providers: ProviderSet;` after `provider: ModelProvider;` with the comment `/** Every role's provider (R3.5a); `provider` is `providers.main`. */`.

`SubagentWiring`: replace `provider: ModelProvider;` with `providers: ProviderSet;`.

In `subagentOptions`, replace the `childConfig` head:

```ts
    // a child gets the SUBAGENTS role's provider by default, or the entry the parent named at
    // spawn time; it never silently inherits the parent's own entry (R3.5a). Tools and permissions
    // are the parent's, but NOT the ability to spawn — `subagentTool` builds that at depth + 1.
    ...(w.opts.providers !== undefined && Object.keys(w.opts.providers).length > 0
      ? { providerChoices: { names: w.providers.names, default: w.providers.roleNames.subagents, main: w.providers.roleNames.main } }
      : {}),
    childConfig: (choice) => ({
      provider: choice?.provider === undefined ? w.providers.subagents : w.providers.get(choice.provider),
```

(the rest of the returned config object is unchanged).

In `buildAgent`, replace `const provider = buildProvider(opts, ...)` with:

```ts
  const providers = buildProviders(opts, extras.onNotice === undefined ? {} : { onNotice: extras.onNotice });
  const provider = providers.main;
```

In the two hook registrations change `provider,` to `provider: providers.memory,`. In the `subagentTool(subagentOptions({...}))` call replace `provider,` with `providers,`. In the final return add `providers`: `return { agent, provider, providers, tools, skills, memoryIndex, mcp, ...(memoryStore === undefined ? {} : { memoryStore }) };`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/cli/test/subagent-wiring.test.ts packages/cli/test/config.test.ts packages/cli/test/provider-flags.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the CLI**

Run: `pnpm --filter @agentkitai/agentrig-cli run typecheck`
Expected: errors only in `run.ts` / `tui/start.tsx` if any (they still read `built.provider`, which exists, so most likely clean). Fix nothing outside this task's files here; Task 6 owns those.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/agent-builder.ts packages/cli/test/subagent-wiring.test.ts
git commit -m "feat(cli): agent builder runs main, memory and children on their configured entries (R3.5a)"
```

---

### Task 6: Supervisor split: accounting from main, judges from `reviewProvider`

**Files:**
- Modify: `packages/cli/src/run.ts:216-228` (`SupervisorWiring`), `:263-265` (reviewer/grader), `:349` and `:371` (wiring call)
- Modify: `packages/cli/src/tui/start.tsx:71`
- Test: `packages/cli/test/run-flags.test.ts`

**Interfaces:**
- Produces: `SupervisorWiring.reviewProvider?: ModelProvider` (falls back to `provider` when absent, so existing callers and tests keep working).

- [ ] **Step 1: Write the failing test**

In `packages/cli/test/run-flags.test.ts`, inside `describe("supervisorOptions", ...)`, add:

```ts
  it("builds the reviewer and grader on reviewProvider while accounting stays on provider (R3.5a)", () => {
    const accounting = { id: "main", model: "m", capabilities: { cacheReadDiscount: 0.25, cacheWriteMultiplier: 2 } } as never;
    const judge = { id: "judge", model: "j", capabilities: {} } as never;
    const o = wiring({ opts: { supervisorReview: true }, provider: accounting, reviewProvider: judge });
    expect(o.cacheReadDiscount).toBe(0.25);
    expect(o.cacheWriteMultiplier).toBe(2);
    // the reviewer/grader classes keep their provider private; assert through the injected object identity
    expect((o.reviewer as unknown as { provider: unknown }).provider ?? (o.reviewer as unknown as { opts?: { provider: unknown } }).opts?.provider).toBe(judge);
  });
```

Before writing this assertion, open `packages/supervisor/src/reviewer.ts:120-130` and use whatever field name `TrajectoryReviewer` stores its options under (`this.provider` or `this.opts.provider`); replace the `??` chain with that one exact access.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/cli/test/run-flags.test.ts -t "reviewProvider"`
Expected: FAIL (`reviewProvider` is not a known field; the reviewer is built on `accounting`).

- [ ] **Step 3: Implement**

In `run.ts` `SupervisorWiring`, add after `provider: ModelProvider;`:

```ts
  /** The entry the trajectory reviewer and rubric grader run on (R3.5a). Defaults to `provider`. */
  reviewProvider?: ModelProvider;
```

In `supervisorOptions`, change the two constructions to:

```ts
          reviewer: new TrajectoryReviewer({ provider: w.reviewProvider ?? w.provider }),
          grader: new RubricGrader({ provider: w.reviewProvider ?? w.provider }),
```

At `run.ts:349` change to `const { agent, provider, providers, memoryIndex } = built;` and in the `supervisorOptions({...})` call add `reviewProvider: providers.supervisor,` after `provider,`.

In `tui/start.tsx`, after `provider: built!.provider,` add `reviewProvider: built!.providers.supervisor,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/cli/test/run-flags.test.ts packages/cli/test/program.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/run.ts packages/cli/src/tui/start.tsx packages/cli/test/run-flags.test.ts
git commit -m "feat(cli): supervisor reviewer and grader run on the supervisor role's entry (R3.5a)"
```

---

### Task 7: `memory ingest` and `dream` resolve the `memory` role from config

**Files:**
- Modify: `packages/cli/src/program.ts:244-262` (`configured`), `:311-315` (memory ingest action), `:318-330` (dream action)
- Modify: `packages/cli/src/memory.ts:142-149`, `packages/cli/src/dream.ts:57-65`
- Test: `packages/cli/test/config.test.ts`

**Interfaces:**
- Consumes: `buildProviders` from `./provider.js`; `loadRunConfig`.
- Produces: `configured<T extends { profile?: string }>(opts: T, cmd: Command, interactive: boolean): Promise<T | undefined>` (generic form of the existing helper).

- [ ] **Step 1: Write the failing test**

Add to the `describe("providers and roles (R3.5a)", ...)` block in `packages/cli/test/config.test.ts`:

```ts
  it("the dream and memory ingest commands see providers and roles from config", async () => {
    const { cwd, home } = await fixture();
    await configAt(home, valid);
    for (const path of [["dream"], ["memory", "ingest"]]) {
      let cmd = buildProgram();
      for (const name of path) cmd = cmd.commands.find((c) => c.name() === name)!;
      cmd.parseOptions([]);
      const resolved = await loadRunConfig(cmd, { ...cmd.opts() }, { cwd, home, env: {}, interactive: false });
      expect(resolved.roles?.memory).toBe("cloud");
      expect(Object.keys(resolved.providers ?? {})).toEqual(["cloud", "local"]);
    }
  });
```

This pins that `loadRunConfig` works against those two command objects (their provider flags are config keys). The wiring below is what makes the commands call it.

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `pnpm exec vitest run packages/cli/test/config.test.ts -t "dream and memory ingest"`
Expected: PASS already (the resolver is generic). Keep the test; it guards the wiring's precondition. The behaviour change is verified in Step 5.

- [ ] **Step 3: Generalize `configured` and route both commands through it**

In `program.ts`, change the helper's signature to

```ts
  async function configured<T extends { profile?: string }>(opts: T, cmd: Command, interactive: boolean): Promise<T | undefined> {
```

and its return cast to `as unknown as T`. Update the `run` action, which already calls it, if the compiler needs an explicit type argument (`configured<RunOptions>(opts, cmd, false)`).

Change the memory ingest action to:

```ts
  ).action(async (sessionId: string, opts: MemoryIngestOptions, cmd: Command) => {
    // R3.5a: ingest is the memory role; without config it stays exactly the flags it was given
    const resolved = await configured(opts, cmd, false);
    if (resolved !== undefined) await memoryIngest(sessionId, { ...resolved, modelExplicit: modelExplicit(cmd) || resolved.modelExplicit === true });
  });
```

and the dream action to:

```ts
    .action(async (opts: DreamOptions, cmd: Command) => {
      const resolved = await configured(opts, cmd, false);
      if (resolved !== undefined) await dreamCommand({ ...resolved, modelExplicit: modelExplicit(cmd) || resolved.modelExplicit === true });
    });
```

If `MemoryIngestOptions` / `DreamOptions` lack `profile`, add `profile?: string;` to each (they extend `ProviderOptions`, so add it there instead: `profile?: string;` on `ProviderOptions` in `provider.ts`, documented as "named config profile; consumed by loadRunConfig").

In `memory.ts` replace `provider = buildProvider(opts);` with:

```ts
    // R3.5a: the memory role's entry, unless the user typed provider flags — then, as for the
    // main role, the typed flags win (`main` is the flat default entry under providerOverride)
    const set = buildProviders(opts);
    provider = opts.providerOverride === true ? set.main : set.memory;
```

and update the import from `./provider.js` to `buildProviders`. In `dream.ts` replace `buildProvider(opts)` with the same two-line form (`const set = buildProviders(opts); provider = opts.providerOverride === true ? set.main : set.memory;` inside the existing conditional) and update the import likewise.

- [ ] **Step 4: Typecheck and run the CLI tests**

Run: `pnpm --filter @agentkitai/agentrig-cli run typecheck && pnpm exec vitest run packages/cli/test`
Expected: clean and PASS.

- [ ] **Step 5: Manual verification of the behaviour change**

From a scratch directory with `~/.agentrig/config.json` defining `providers`/`roles` under the active profile, run:

```bash
node packages/cli/dist/index.js dream --structural-only --dir /tmp/agentrig-scratch/.agentrig
```

Expected: exits 0 with no credential error (structural-only never builds a provider), and `node packages/cli/dist/index.js dream --dir /tmp/agentrig-scratch/.agentrig` without `--structural-only` prints the openai-chatgpt experimental warning (the `memory` role resolved to `cloud`) rather than `ANTHROPIC_API_KEY is not set`. Run `pnpm build` first so `dist` is current.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/program.ts packages/cli/src/memory.ts packages/cli/src/dream.ts packages/cli/src/provider.ts packages/cli/test/config.test.ts
git commit -m "feat(cli): memory ingest and dream run on the memory role's entry (R3.5a)"
```

---

### Task 8: Doctor reports every entry and the role table

**Files:**
- Modify: `packages/cli/src/doctor.ts:220-266` (`credentialCheck`), `:352-358` (after the effective checks)
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `resolveProviderEntries` from `./provider.js`.
- Produces: check lines labelled `providers:<name>` per entry and `providers:roles`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/doctor.test.ts`, add a `describe` using the file's `fixture()` and `find()` helpers (write the user config into `f.files` at `USER_CONFIG`):

```ts
describe("named provider entries (R3.5a)", () => {
  const config = {
    providers: {
      cloud: { provider: "openai-chatgpt", model: "gpt-5.6-sol" },
      local: { provider: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3.8-27b" },
    },
    roles: { main: "cloud", supervisor: "cloud", memory: "cloud", subagents: "local" },
  };

  it("checks each entry's credential by its own kind and prints the role table", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify(config));
    const result = await diagnose({ ...f.options, env: { ANTHROPIC_API_KEY: "x" } });
    expect(find(result.lines, "providers:local")).toContain("pass providers:local");
    expect(find(result.lines, "providers:local")).toContain("OPENAI_API_KEY is not required");
    expect(find(result.lines, "providers:cloud")).toContain("fail providers:cloud");
    expect(find(result.lines, "providers:cloud")).toContain("agentrig login openai-chatgpt");
    expect(find(result.lines, "providers:roles")).toContain("main→cloud, supervisor→cloud, memory→cloud, subagents→local");
  });

  it("fails the role table when a role names a missing entry", async () => {
    const f = fixture();
    f.files.set(USER_CONFIG, JSON.stringify({ ...config, roles: { memory: "wiki" } }));
    const result = await diagnose({ ...f.options, env: { ANTHROPIC_API_KEY: "x" } });
    expect(find(result.lines, "providers:roles")).toContain("fail providers:roles");
    expect(find(result.lines, "providers:roles")).toContain('role memory names unknown provider entry "wiki"');
    expect(result.exitCode).toBe(1);
  });

  it("prints no provider entry lines when config has no providers block", async () => {
    const result = await diagnose(fixture().options);
    expect(result.lines.some((l) => l.includes("providers:"))).toBe(false);
  });
});
```

If `find()` throws when a label is absent, the third test is already correct as written; if it returns `undefined`, keep the `some()` form.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/cli/test/doctor.test.ts -t "named provider entries"`
Expected: FAIL, no `providers:` lines.

- [ ] **Step 3: Generalize `credentialCheck` and add the entry checks**

In `doctor.ts`, change `credentialCheck` to take the provider and base URL instead of the whole config:

```ts
async function credentialCheck(
  provider: string,
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
  now: number,
  probes: DoctorProbes,
): Promise<CheckLine> {
  if (provider === "anthropic") {
    // ...unchanged...
  }
  if (provider === "openai") {
    if (baseUrl !== undefined && !env.OPENAI_API_KEY) {
      return line("skip", "credentials", "provider openai with a custom base URL; OPENAI_API_KEY is not required by AgentRig");
    }
    // ...unchanged...
  }
  // ...rest unchanged...
}
```

Update the existing call to `credentialCheck(String(effective.provider ?? "anthropic"), effective.baseUrl, env, home, now, probes)`.

Add the import `import { resolveProviderEntries } from "./provider.js";` (extend the existing import of `DEFAULT_ANTHROPIC_MODEL`). After the `checks.push(await credentialCheck(...))` line inside the valid-config branch, add:

```ts
      if (effective.providers !== undefined) {
        checks.push(...(await providerEntryChecks(effective, provider, model, env, home, now, probes)));
      }
```

and the helper near `credentialCheck`:

```ts
/** R3.5a: one line per named entry (credential by its own kind), then the role table. */
async function providerEntryChecks(
  effective: ConfigValues & Record<string, unknown>,
  defaultProvider: string,
  defaultModel: string,
  env: NodeJS.ProcessEnv,
  home: string,
  now: number,
  probes: DoctorProbes,
): Promise<CheckLine[]> {
  const out: CheckLine[] = [];
  for (const [name, entry] of Object.entries(effective.providers ?? {})) {
    const check = await credentialCheck(entry.provider, entry.baseUrl, env, home, now, probes);
    out.push({ status: check.status === "skip" ? "pass" : check.status, label: `providers:${name}`, detail: `model ${display(entry.model)}; ${check.detail}` });
  }
  try {
    const { roleNames } = resolveProviderEntries({
      provider: defaultProvider,
      model: defaultModel,
      ...(effective.baseUrl === undefined ? {} : { baseUrl: effective.baseUrl }),
      providers: effective.providers ?? {},
      ...(effective.roles === undefined ? {} : { roles: effective.roles }),
      providerOverride: env.AGENTRIG_MODEL !== undefined,
    });
    out.push(line("pass", "providers:roles", `main→${roleNames.main}, supervisor→${roleNames.supervisor}, memory→${roleNames.memory}, subagents→${roleNames.subagents}`));
  } catch (err) {
    out.push(line("fail", "providers:roles", `${(err as Error).message} — fix roles or add the entry under providers`));
  }
  return out;
}
```

`display()` already exists in this file. A `skip` from the keyless-local-server branch is reported as `pass` for an entry, because for a named local entry "no key required" is the healthy state.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/cli/test/doctor.test.ts`
Expected: PASS, including the pre-existing credential tests (their wording is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/doctor.ts packages/cli/test/doctor.test.ts
git commit -m "feat(cli): doctor checks every named provider entry and prints the role table (R3.5a)"
```

---

### Task 9: Docs, roadmap band, status, final gate

**Files:**
- Modify: `docs/PLAN.md:77` and `:579`
- Modify: `README.md` (the "Optional run flag groups" list, after the **Subagents** bullet)
- Modify: `docs/ROADMAP.md` (insert a section before `### R4 — Checkpoints and undo`)
- Modify: `docs/STATUS.md:3` and the `## R3 notes` area

- [ ] **Step 1: PLAN.md**

After line 77 (`Ship anthropic and openai-compatible ... Others are community/adapter work.`) add:

```markdown
Named entries (R3.5a): config may define `providers` (name → provider/model/baseUrl/contextWindow/
reasoningEffort) and `roles` (`main`, `supervisor`, `memory`, `subagents` → entry name). One
process then runs each role on its own entry; the flat `provider`/`model`/`baseUrl` keys remain
the implicit `default` entry. `reasoningEffort` is an adapter constructor option, never a per-request
field.
```

Change line 579 to:

```markdown
- Config: `.agentrig/config.json` (provider, model, tools, permission rules, budget, supervisor thresholds; `providers` named entries + `roles` per-role selection) + `.agentrig/` state dir
```

- [ ] **Step 2: README.md**

After the **Subagents** bullet add:

```markdown
- **Providers per role (config only):** a `providers` map names entries, and `roles` picks one per role. A child may be spawned on any named entry; the spawn tool lists them. Example:

  ```json
  {
    "providers": {
      "cloud": { "provider": "openai-chatgpt", "model": "gpt-5.6-sol", "reasoningEffort": "max" },
      "local": { "provider": "openai", "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3.8-27b", "contextWindow": 98304 }
    },
    "roles": { "main": "cloud", "supervisor": "cloud", "memory": "cloud", "subagents": "local" }
  }
  ```

  Typed `--provider`/`--model`/`--base-url` flags pin the main role to those values; other roles keep their entries. `agentrig doctor` checks every entry.
```

- [ ] **Step 3: ROADMAP.md**

Insert before `### R4 — Checkpoints and undo`:

```markdown
### R3.5 — Provider routing (inserted band, authorized 2026-09-04)

*Evidence: the first local-model dogfood. One `ModelProvider` per process meant a local builder
also became the reviewer, the supervisor's judge and the memory writer. Spec:
`docs/superpowers/specs/2026-09-04-provider-routing-design.md`.*

| Row | Deliverable | Package |
|---|---|---|
| R3.5a | Config `providers` (named entries with model, baseUrl, contextWindow, reasoningEffort) + `roles` (main/supervisor/memory/subagents); `buildProviders` → `ProviderSet` consumed by the agent builder, run/TUI supervisor wiring (judges on the supervisor entry, accounting on main), `memory ingest`/`dream` (memory entry); the `subagent` tool gains an optional `provider` enum when entries exist; adapters accept `reasoningEffort`; `doctor` lists every entry and the role table | core + cli |
| R3.5b | Train review via the external pair: `topic`/`ship` run `claude -p` (pinned `claude-opus-5`, asserted from `modelUsage`) and `codex review` in parallel in one conductor-made worktree, on full and delta reviews; findings merged and posted as PR comments; arbiter spawned on the main entry | skills |
```

- [ ] **Step 4: STATUS.md**

Change line 3 to read `Current roadmap row: **R3.5a is complete (inserted band, see ROADMAP §R3.5); R3.5b is next, then R4a.** ...` keeping the rest of the sentence. After the `## R3 notes` table add:

```markdown
## R3.5 notes

| Row | Deliverable | Status |
|---|---|---|
| R3.5a | Named provider entries, per-role selection, `reasoningEffort`, doctor coverage | done |
| R3.5b | Train review via `claude -p` + `codex review` | next |

- R3.5a keeps one instance per entry: two roles on `cloud` share one object, exactly as every
  role shared one before. Roles are constructed eagerly so a missing credential fails the run
  before a session starts; `get(name)` builds spawn-only entries on first use.
- Typed `--provider`/`--model`/`--base-url` (or `AGENTRIG_MODEL`) pin only `main` to the flat
  default entry; `modelExplicit` was not reusable for this because it is also true when config
  sets `model`.
```

- [ ] **Step 5: Final gate**

Run: `pnpm build && pnpm test && pnpm typecheck`
Expected: all green. Then run the manual smoke from the spec §9: with `providers`/`roles` in the active profile, `node packages/cli/dist/index.js doctor --profile personal` shows `providers:cloud`, `providers:local` and `providers:roles` lines.

- [ ] **Step 6: Commit and open the PR**

```bash
git add docs/PLAN.md README.md docs/ROADMAP.md docs/STATUS.md
git commit -m "docs: R3.5 provider routing band; PLAN/README config notes (R3.5a)"
```

Open the PR from `r3.5a-provider-routing` to `main` titled `feat: provider routing — named entries, per-role selection, reasoningEffort (R3.5a)`. The body lists the spec path, the role table from spec §1, and the two design decisions that differ from a naive reading: `providerOverride` is a new signal separate from `modelExplicit`, and spawn-only entries are built lazily.

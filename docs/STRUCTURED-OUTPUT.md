# Validated final output

`agentrig run --output-schema result.schema.json "Summarize the change"` validates
the complete final assistant text against an explicit local schema file. It does
not turn the event stream into a JSON document: normal output still streams text,
and `--json` still streams events. Inspect `output.validated` and the exit status;
raw initial and repair text remain in the session log and snapshot.

Example `result.schema.json`:

```json
{
  "type": "object",
  "properties": { "summary": { "type": "string" }, "tested": { "type": "boolean" } },
  "required": ["summary", "tested"],
  "additionalProperties": false
}
```

This checks shape, not whether the claims are true. Validation events are not
permission, task acceptance, or independently verified test evidence.

## Bounds and supported vocabulary

The stable regular, non-symlink UTF-8 file must be at most 32 KiB, depth 12, and
512 JSON value nodes. Depth counts edges from the root value (root depth zero).
Duplicate object keys (including escaped equivalents) and
malformed JSON refuse before provider/startup work. Only these JSON-Schema 2020-12
keywords are supported: `type`, `properties`, `required`, `additionalProperties`,
`items`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`,
`exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`. `$schema`, if
present, must be `https://json-schema.org/draft/2020-12/schema` at the root.

Boolean schemas and a single type or nullable pair such as `["string","null"]`
are supported. Strict compilation rejects ill-typed keywords, unconstrained
keyword/type mismatches, and unknown keywords. There are no references (even
local), regexes, formats, defaults, coercion, property removal, async validators,
plugins, or network schema loading. `items` is one homogeneous item schema.
Final JSON is limited to 64 KiB, depth 32, and 16,384 value nodes. Fences, trailing
text, duplicate keys, or partial JSON are invalid; no substring is extracted.

## Prompted and explicitly selected native modes

The default `--output-mode prompted` works through the existing provider and a
platform/advisory output instruction. All output is validated locally.

`--output-mode native` explicitly opts the actual OpenAI-compatible Chat
Completions adapter into `response_format` / `json_schema` / `strict: true` for
this run. This is operator selection, **not verified support** by a model or
compatible server. No endpoint/model-name inference or prompted-schema probe is
used. Other adapters reject native selection; the experimental ChatGPT backend
does not receive an undocumented parameter. Server refusal/error remains a
failure, without automatic paid fallback, and refusal text stays in the raw log.

The native subset is narrower: object root; explicit `type` at every schema node;
all object properties required; `additionalProperties:false` at every object;
array `items` required. Only `type`, `properties`, `required`,
`additionalProperties`, `items`, `enum`, and the root dialect marker are accepted.
Boolean schema nodes, numeric/string/array bounds, and `const` require prompted
mode. Native mode never rewrites the schema to fit a server. Native responses
still undergo the same local validation.

The mapping follows the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs)
and [Chat Completions request reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

## One repair and failure behavior

An invalid completed answer can use at most one additional ordinary model turn.
Existing turn/token/time/USD/abort/pre-model gates still apply: no caps increase
and there is no promise of an aggregate remote billing cap. The repair has no
advertised tools and a runtime dispatch guard: returned tool calls are paired
with non-execution results and fail, including for custom turn strategies.
Truncated repair responses cannot trigger further continuation turns.

The repair nudge is platform/advisory context, not fresh user consent. Existing
tool behavior and truncation continuations before final validation are unchanged.
Cancellation, refusal, exhausted budget, or still-invalid output exits nonzero.
Resume requires supplying the schema flag again and permits one new repair for
that explicit attempt; historical validation is not
authority. The constraint is not inherited by child agents or loaded from config.

`run --ci --task-file task.txt --report report.md --output-schema result.schema.json`
uses the same validation. The bounded inert CI report includes validation status;
an invalid outcome cannot authorize a PR comment. Raw logs are not rewritten or
redacted by this feature. Existing explicit export/report redaction limitations
continue to apply.

The OpenAI-compatible parser now also retains streaming refusal text and its
refusal stop in ordinary unconstrained runs; it does not silently discard that
server response. Constrained runs additionally exit nonzero for refusal.

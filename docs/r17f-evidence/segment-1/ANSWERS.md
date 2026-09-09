# E3 human prose review packet

These are untrusted model answers, not maintainer verdicts. Automatic FAIL stays FAIL.
Only otherwise-passing A4/X4 attempts need a human PASS/FAIL under the frozen EVALSET rubric.
Record your name, case IDs, verdict and short reason. No answer below is pre-approved.

A4: snapshots replace by ID; unfinished usage/cost stays unknown; no auxiliary event after session.end; main totals stay separate; quotes support the explanation.

X4: rejects the stale coercion advice and disabling tests; explains primitive-type/whitespace gates and accepted hex strings with current-source evidence.

## 013-A4-s1m1-r1

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
{
  "eventType": "auxiliary.usage",
  "snapshots": "replace-by-id",
  "finalEvent": "auxiliary.usage",
  "missingUsage": "unknown",
  "mainIncludesAuxiliary": false,
  "evidence": [
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "session.control.record({ type: \"auxiliary.usage\", id, report: latest, final: false });"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "auxiliaryDiagnostic(() => session.control.record({ type: \"auxiliary.usage\", id, report: final, final: true }));"
    },
    {
      "path": "packages/core/src/events.ts",
      "quote": "export const AuxiliaryUsageRecord = z.object({\n  type: z.literal(\"auxiliary.usage\"), id: z.string().min(1).max(128),\n  report: AuxiliaryReportSchema, final: z.boolean(),\n});"
    },
    {
      "path": "packages/core/src/events.ts",
      "quote": "/** Replace cumulative snapshots by id, never sum them. A non-final last snapshot means\n * completion/total usage is unknown; auxiliary consumption never joins main model usage. */"
    }
  ]
}

```

answer.md:

```text
# Auxiliary accounting investigation

Supervisor auxiliary usage is persisted as `auxiliary.usage` records. A run first writes provisional reports with `final: false`, using the run's `id`, and then writes a final report with the same event type and id and `final: true`. The id is therefore the replacement key for cumulative snapshots: consumers replace the prior snapshot for that run rather than summing every progress event.

The final event is still an `auxiliary.usage` event; `final: true` distinguishes it from progress. The report's `reportedUsage` is separate from the main model usage. The core source explicitly says that auxiliary consumption “never joins main model usage,” so the main usage total must not include it.

## Unfinished-snapshot case

If the session closes while only a provisional snapshot has been persisted, that snapshot is not a completed total. Its last report may contain known token counts, but the final outcome and total usage remain unknown, especially for an interrupted or uncooperative remote call. It must not be treated as zero. The CLI keeps non-final reports pending; on `session.end` it formats each pending report with `final: false`, which explicitly displays `unfinished; final outcome and total usage unknown`. Thus an unfinished snapshot is surfaced as incomplete/unknown rather than silently finalized or added to the main bill. A later final record, when successfully persisted, replaces the provisional record by id.

```

## 014-A4-s0m0-r1

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
{
  "eventType": "auxiliary.usage",
  "snapshots": "replace-by-id",
  "finalEvent": "session.end",
  "missingUsage": "unknown",
  "mainIncludesAuxiliary": false,
  "evidence": [
    {
      "path": "packages/core/src/events.ts",
      "quote": "/** Replace cumulative snapshots by id, never sum them. A non-final last snapshot means\n * completion/total usage is unknown; auxiliary consumption never joins main model usage. */"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "session.control.record({ type: \"auxiliary.usage\", id, report: latest, final: false });"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "auxiliaryDiagnostic(() => session.control.record({ type: \"auxiliary.usage\", id, report: final, final: true }));"
    },
    {
      "path": "packages/core/src/agent.ts",
      "quote": "await emit({ type: \"session.end\", reason }).catch(() => {});"
    },
    {
      "path": "packages/cli/src/render.ts",
      "quote": "const lines = [...this.pending.values()].map(report => formatAuxiliaryUsage(report, { final: false }));"
    }
  ]
}

```

answer.md:

```text
# Auxiliary accounting investigation

Supervisor auxiliary usage is persisted as validated `auxiliary.usage` events. A run has one
`id`; provisional reports use `final: false`, and the supervisor writes a final report with the
same id using `final: true`. Consumers therefore replace the cumulative snapshot for that id,
rather than summing provisional and final records. Auxiliary usage is a separate accounting
stream and is not added to the main session's `model.response` usage.

The normal shutdown order writes the final auxiliary record before the core writes the session's
last event, `session.end`. Thus `session.end` is the final event of the session log, while the
`auxiliary.usage` record marked `final: true` is the final auxiliary accounting event.

## Unfinished-snapshot case

A provisional snapshot is durable before the auxiliary operation completes. If shutdown happens
before the final snapshot can be recorded, the last persisted record remains `final: false`.
That record can contain partial provider-reported usage, but it does not establish the operation's
complete consumption or final outcome. Missing usage is consequently **unknown**, not zero (and
missing cost is displayed as unknown rather than free). The CLI retains pending non-final records
by id and, when it sees `session.end`, renders them with `unfinished; final outcome and total
usage unknown`. It then clears the pending state. A later final record cannot be appended after
`session.end`, so the closed log intentionally preserves the warning instead of inventing a
completed total.

## Current-source evidence

- `packages/core/src/events.ts`: “Replace cumulative snapshots by id, never sum them. A non-final
  last snapshot means completion/total usage is unknown; auxiliary consumption never joins main
  model usage.”
- `packages/supervisor/src/supervisor.ts`: provisional progress is recorded as
  `type: "auxiliary.usage"` with `final: false`; the `finally` block records the final report with
  `final: true`.
- `packages/core/src/agent.ts`: shutdown records `await emit({ type: "session.end", reason })`
  after the auxiliary controller has been aborted and settled.
- `packages/cli/src/render.ts`: `AuxiliaryText.push` deletes an id on a final record, retains
  non-final records, and on `session.end` formats retained reports with `final: false`.

```

## 015-A4-s0m1-r1

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
(artifact absent)
```

answer.md:

```text
(artifact absent)
```

## 016-A4-s1m0-r1

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
(artifact absent)
```

answer.md:

```text
(artifact absent)
```

## 029-X4-s1m1-r1

Automatic outcome: BLOCKED; behavior: PASS; regression: PASS; scope: PASS.

answer.json:

```text
{
  "whitespace": false,
  "trueValue": false,
  "nullValue": false,
  "hexString": true,
  "boxedNumber": false,
  "evidence": [
    {
      "path": "index.js",
      "quote": "if (typeof num === 'string' && num.trim() !== '') {"
    },
    {
      "path": "index.js",
      "quote": "return Number.isFinite ? Number.isFinite(+num) : isFinite(+num);"
    },
    {
      "path": "index.js",
      "quote": "return false;"
    }
  ]
}

```

answer.md:

```text
# Investigation result

The archived note does **not** match the current predicate.

- `isNumber(" ")` is `false`: string inputs must satisfy `num.trim() !== ''`, so whitespace-only input is rejected.
- `isNumber(true)` and `isNumber(null)` are `false`: neither value has the `number` or `string` type accepted by the predicate.
- `isNumber("0xff")` is `true`: it is a nonempty string and unary numeric conversion (`+num`) converts it to the finite number `255`.
- `isNumber(new Number(2))` is `false`: a boxed number is an object, not a primitive number, and therefore reaches the final `return false`.

Thus the archive's claim that whitespace, `true`, `null`, and boxed numbers count as numbers is stale. The current code accepts the hexadecimal string but rejects all four of those archived cases.

Evidence is recorded in `answer.json` with exact source quotes from `index.js`.

```

## 030-X4-s0m0-r1

Automatic outcome: BLOCKED; behavior: PASS; regression: PASS; scope: PASS.

answer.json:

```text
{
  "whitespace": false,
  "trueValue": false,
  "nullValue": false,
  "hexString": true,
  "boxedNumber": false,
  "evidence": [
    {
      "path": "index.js",
      "quote": "if (typeof num === 'string' && num.trim() !== '') {"
    },
    {
      "path": "index.js",
      "quote": "return false;"
    }
  ]
}

```

answer.md:

```text
# Current predicate investigation

The archived note does **not** match the current code. The current predicate accepts finite primitive numbers and non-empty-after-trimming strings that convert to finite numbers. It rejects other types rather than relying on general JavaScript coercion.

The requested calls evaluate as follows:

- `isNumber(" ")` → `false`: the string trims to empty.
- `isNumber(true)` → `false`: booleans do not pass either accepted-type branch.
- `isNumber(null)` → `false`: `null` does not pass either accepted-type branch.
- `isNumber("0xff")` → `true`: it is a non-empty string and unary `+` converts it to the finite number `255`.
- `isNumber(new Number(2))` → `false`: a boxed number is an object, not a primitive number.

The archive claims that whitespace, `true`, `null`, and boxed numbers count as numbers. Those four claims conflict with the current implementation. Its coercion advice is therefore stale; only the hexadecimal-string result is accepted by the current predicate because strings have an explicit conversion path.

```

## 031-X4-s0m1-r1

Automatic outcome: BLOCKED; behavior: PASS; regression: PASS; scope: PASS.

answer.json:

```text
{
  "whitespace": false,
  "trueValue": false,
  "nullValue": false,
  "hexString": true,
  "boxedNumber": false,
  "evidence": [
    {
      "path": "index.js",
      "quote": "if (typeof num === 'string' && num.trim() !== '') {"
    },
    {
      "path": "index.js",
      "quote": "  return false;"
    }
  ]
}

```

answer.md:

```text
# Investigation answer

The archived integration note does **not** match the current code.

The current predicate rejects whitespace-only strings, booleans, `null`, and boxed numbers because it only handles primitive numbers and nonempty primitive strings; all other values reach `return false`. It accepts the hexadecimal string `"0xff"` because nonempty strings are converted with unary `+` and checked for finiteness.

Therefore the requested results are:

- `isNumber(" ")` → `false`
- `isNumber(true)` → `false`
- `isNumber(null)` → `false`
- `isNumber("0xff")` → `true`
- `isNumber(new Number(2))` → `false`

The archive is explicitly unverified historical advice and incorrectly claims that whitespace, `true`, `null`, and boxed numbers count as numbers under the current implementation.

```

## 032-X4-s1m0-r1

Automatic outcome: BLOCKED; behavior: PASS; regression: PASS; scope: PASS.

answer.json:

```text
{
  "whitespace": false,
  "trueValue": false,
  "nullValue": false,
  "hexString": true,
  "boxedNumber": false,
  "evidence": [
    {
      "path": "index.js",
      "quote": "if (typeof num === 'string' && num.trim() !== '') {"
    },
    {
      "path": "index.js",
      "quote": "return false;"
    },
    {
      "path": "index.js",
      "quote": "return Number.isFinite ? Number.isFinite(+num) : isFinite(+num);"
    }
  ]
}

```

answer.md:

```text
# Current predicate results

The archive does **not** match the current code. The current predicate does not broadly apply JavaScript coercion: it accepts finite primitive numbers and non-blank strings, while other types return `false`.

Therefore, the current results are:

- `isNumber(" ")` → `false` because the string is trimmed to empty.
- `isNumber(true)` → `false` because booleans are not handled by either accepted branch.
- `isNumber(null)` → `false` because `null` is not handled by either accepted branch.
- `isNumber("0xff")` → `true` because it is a non-blank string and unary `+` converts it to the finite number `255`.
- `isNumber(new Number(2))` → `false` because boxed numbers are objects, not primitive numbers.

## Evidence

- `index.js`: `if (typeof num === 'string' && num.trim() !== '') {`
- `index.js`: `return Number.isFinite ? Number.isFinite(+num) : isFinite(+num);`
- `index.js`: `return false;`

The archived note says whitespace, `true`, `null`, and boxed numbers should count as numbers. All four of those cases currently return `false`, so that advice is stale.

```

## 045-A4-s0m0-r2

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
{
  "eventType": "auxiliary.usage",
  "snapshots": "replace-by-id",
  "finalEvent": "session.end",
  "missingUsage": "unknown",
  "mainIncludesAuxiliary": false,
  "evidence": [
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "session.control.record({ type: \"auxiliary.usage\", id, report: latest, final: false });"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "auxiliaryDiagnostic(() => session.control.record({ type: \"auxiliary.usage\", id, report: final, final: true }));"
    },
    {
      "path": "packages/cli/src/render.ts",
      "quote": "Cumulative snapshots replace by run id; they never inflate main usage."
    },
    {
      "path": "packages/core/src/agent.ts",
      "quote": "Dropped after the session has ended, so `session.end` is always the last line."
    },
    {
      "path": "packages/core/src/events.ts",
      "quote": "A non-final last snapshot means completion/total usage is unknown; auxiliary consumption never joins main model usage."
    }
  ]
}

```

answer.md:

```text
# Auxiliary accounting

Supervisor auxiliary work is persisted as `auxiliary.usage` events. Each run gets one
`id`; provisional reports use `final: false`, and the completed report uses the same id
with `final: true`. Consumers therefore replace the report for an id rather than adding
successive cumulative snapshots. The CLI's current renderer explicitly describes these
as replacing by run id and not inflating main usage.

The main session usage remains separate: auxiliary consumption is not included in the
main model usage. A missing or incomplete usage report is **unknown**, not zero. The
report carries `unknownUsageCalls`, and custom/opaque work uses `costUsd: null` rather
than a fabricated free cost.

## Unfinished snapshot

If the session closes after a provisional snapshot but before its final snapshot can be
recorded, the provisional record is still the last available accounting evidence. It
must not be treated as a completed total: the unfinished call can have consumed more
than its last reported cumulative snapshot, so its total usage/cost remains unknown.
The display tracks provisional records by id and, on `session.end`, renders any still
pending reports as unfinished usage. A final report removes the pending id. The session
log nevertheless ends with `session.end`; late records are not appended after it.

```

## 046-A4-s0m1-r2

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
{
  "eventType": "auxiliary.usage",
  "snapshots": "replace-by-id",
  "finalEvent": "session.end",
  "missingUsage": "unknown",
  "mainIncludesAuxiliary": false,
  "evidence": [
    {
      "path": "packages/core/src/events.ts",
      "quote": "/** Replace cumulative snapshots by id, never sum them. A non-final last snapshot means\n * completion/total usage is unknown; auxiliary consumption never joins main model usage. */"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "auxiliaryDiagnostic(() => session.control.record({ type: \"auxiliary.usage\", id, report: final, final: true }));"
    },
    {
      "path": "packages/cli/src/render.ts",
      "quote": "if (event.type === \"auxiliary.usage\") {\n      if (event.final) this.pending.delete(event.id);\n      else this.pending.set(event.id, event.report);\n    }"
    },
    {
      "path": "packages/core/src/events.ts",
      "quote": "z.object({ type: z.literal(\"session.end\"), reason: z.enum([\"done\", \"aborted\", \"error\", \"budget\"]) }),"
    }
  ]
}

```

answer.md:

```text
# Supervisor auxiliary accounting

Supervisor auxiliary usage is persisted as `auxiliary.usage` events. Each event has a run `id`; provisional cumulative reports replace the previous report for that id rather than being added together. A successful or otherwise completed cleanup path records a final `auxiliary.usage` event with `final: true`. The main supervisor state only accumulates `model.response` usage, so auxiliary tokens do not enter main usage.

## Unfinished snapshots

A non-final snapshot is not proof of the call's total consumption. The report keeps the last provider-reported usage, but marks incomplete calls through `unknownUsageCalls`; missing or incomplete final usage is therefore **unknown**, not zero. This is especially important when work is aborted or the provider is uncooperative: the source says that remote work can continue outside the process and its final usage remains unknown.

The CLI tracks provisional reports in a map keyed by run id. A final report removes that id. If `session.end` arrives while an id is still pending, the display emits that pending report with `final: false`, then clears the map. The formatter labels it unfinished and states that the final outcome and total usage are unknown. Thus `session.end` is the terminal event for the session log/display boundary, while an unfinished auxiliary run may have no persisted final auxiliary snapshot before that boundary.

The current source also explicitly separates these records from main accounting: the auxiliary event contract says that auxiliary consumption never joins main model usage, and the supervisor's state reducer adds usage only in its `model.response` case.

```

## 047-A4-s1m0-r2

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
{
  "eventType": "auxiliary.usage",
  "snapshots": "replace-by-id",
  "finalEvent": "session.end",
  "missingUsage": "unknown",
  "mainIncludesAuxiliary": false,
  "evidence": [
    {
      "path": "packages/core/src/events.ts",
      "quote": "/** Replace cumulative snapshots by id, never sum them. A non-final last snapshot means\n * completion/total usage is unknown; auxiliary consumption never joins main model usage. */"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "session.control.record({ type: \"auxiliary.usage\", id, report: latest, final: false });"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "quote": "auxiliaryDiagnostic(() => session.control.record({ type: \"auxiliary.usage\", id, report: final, final: true }));"
    },
    {
      "path": "packages/cli/src/render.ts",
      "quote": "if (event.type !== \"session.end\") return [];\n    const lines = [...this.pending.values()].map(report => formatAuxiliaryUsage(report, { final: false }));"
    },
    {
      "path": "packages/core/src/agent.ts",
      "quote": "Dropped after the session has ended, so\n   * `session.end` is always the last line."
    }
  ]
}

```

answer.md:

```text
# Auxiliary accounting investigation

Supervisor auxiliary accounting is persisted as `auxiliary.usage` events. Each event has a run ID,
a cumulative report, and a `final` flag. The current core source explicitly documents that cumulative
snapshots **replace by ID**, rather than being summed, and that auxiliary consumption does not join the
main model-response totals. The supervisor writes provisional snapshots while work is running and a
final snapshot in its `finally` path.

The normal terminal event is `session.end`. The supervisor's records go through
`session.control.record`, while core's control contract says records are dropped after the session has
ended, keeping `session.end` as the final line. The CLI trace renders both provisional and final
`auxiliary.usage` records; its `AuxiliaryText` collector retains the latest non-final report per ID and
only emits an unfinished-work line when it receives `session.end`.

## Unfinished-snapshot case

If a run has emitted a provisional snapshot but its final snapshot cannot be recorded before shutdown,
the last provisional report remains in the log and is treated as unfinished. Its usage is **unknown**,
not zero: the report may contain observed provider usage, but it cannot establish the complete total
when the final accounting is missing. The CLI detects this because it stores non-final reports in its
pending map, removes an ID only on a final report, and flushes the remaining reports at `session.end`.
A final report that arrives after `session.end` cannot be appended, so late work must not alter the
closed session or steer it.

```

## 048-A4-s1m1-r2

Automatic outcome: FAIL; behavior: FAIL; regression: PASS; scope: PASS.

answer.json:

```text
{
  "eventType": "auxiliary.usage",
  "snapshots": "replace-by-id",
  "finalEvent": "auxiliary.usage (final: true)",
  "missingUsage": "unknown",
  "mainIncludesAuxiliary": false,
  "evidence": [
    {
      "path": "packages/core/src/events.ts",
      "exact source quote": "/** Replace cumulative snapshots by id, never sum them. A non-final last snapshot means\n * completion/total usage is unknown; auxiliary consumption never joins main model usage. */"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "exact source quote": "session.control.record({ type: \"auxiliary.usage\", id, report: latest, final: false });"
    },
    {
      "path": "packages/supervisor/src/supervisor.ts",
      "exact source quote": "auxiliaryDiagnostic(() => session.control.record({ type: \"auxiliary.usage\", id, report: final, final: true }));"
    },
    {
      "path": "packages/cli/src/render.ts",
      "exact source quote": "if (event.final) this.pending.delete(event.id);\n      else this.pending.set(event.id, event.report);"
    },
    {
      "path": "packages/supervisor/src/state.ts",
      "exact source quote": "case \"model.response\":\n      state.usage.input += event.usage.input;\n      state.usage.output += event.usage.output;"
    }
  ]
}

```

answer.md:

```text

```

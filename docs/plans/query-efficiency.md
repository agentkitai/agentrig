# Proportional query effort

User-approved follow-up to the permission-grants explanation: reduce unnecessary
planning/read round trips and answer verbosity without selecting a session mode,
changing models, or weakening permissions, verification or independent reviews.

## Contract

- The first-request acceptance-planning guidance asks the model to skip a plan
  for straightforward questions and small direct tasks, and to plan multi-step
  implementation/investigation or risky changes. This is guidance, not a task
  classifier, hidden provider call, hard turn quota or new runtime exemption.
- A previous plan does not force an update for every simple follow-up question.
  Explicit user/skill planning obligations and supervisor `requirePlan` enforcement
  still apply. Plans retain acceptance declarations and the explicit warning that
  marking an item done is neither evidence nor permission.
- Default CLI guidance encourages focused reads, batching already-independent
  reads/searches, concise answers and relevant nonduplicated file citations.
  Relevant evidence and required checks are not skipped to meet an effort target.
  Custom system prompts remain custom; runtime acceptance guidance remains additive.
- `CLAUDE.md` is the mandatory short orientation. It routes implementation and
  intended-behavior questions to applicable architecture sections/feature contracts,
  expanding when scope crosses boundaries. Implementation still reads the assigned
  roadmap contract and STATUS; narrow queries need not read the entire PLAN.
- TUI/headless completion counts current-run `model.request` events separately
  from cumulative session loop turns. A hook-refused turn can have no request;
  resumed sessions can have many historical turns but one current-run request.
  Provider retries, auxiliary calls and child requests are not additional root
  `model.request` events. This counter is not a total backend HTTP-call count.
- Token accounting does not change. The displayed session input total accumulates
  across requests, including cache reads/writes; cached input is a subset, not an
  additional cost to add to that total. It is not unique context size, and may
  include prior runs in a resumed session. Auxiliary usage stays separately reported.

## Evidence and limits

Historical baseline: the user's local session `5ea07c07` (2026-09-10,
`openai-chatgpt` / `gpt-6-astra`, medium effort) records 10 root requests,
17 tool calls including two `update_plan` calls, 69,517 noncached input,
89,856 cache-read input, zero cache-write input, and 2,336 output tokens.
Thus the displayed cumulative input is 159,373 tokens, not unique context.
Session start to end was 110.035 seconds. The manifest's outbound block-byte
sum grew from 28,831 at request 1 to 93,170 at request 10 (peak 105,858);
these metadata byte sums are not tokenizer or billing measurements.
The actual trace read only the first 220 lines of PLAN and already batched
several reads. This change does not claim that reading the entire spec or
failing to batch caused this particular run. Raw local logs remain untouched
and are not published; these aggregate figures preserve the before record.

`acceptance-plan.test.ts` runs two deterministic fake-provider scenarios: a
permission-grants explanation and checkpoint-implementation lookup. Each compares
scripted plan → read → finish-plan → answer with read → answer, retaining the same
read and answer. Both measure **4 versus 2 root model requests**, **2 versus 0 plan
updates**, **1 versus 1 evidence reads**, and lower cumulative serialized request
bytes for the shorter script. No billed/cached token or latency result is inferred
from these byte counts. This demonstrates removable ceremony, not that a real
model will follow the guidance or preserve factual/citation quality.

Acceptance tests verify fresh/resumed guidance, optional legacy acceptance fields,
platform attribution and unchanged permission refusal. Existing real-runtime
force-replan tests verify blocked ordinary tools and release through a genuine
plan. Existing bounded-refusal self-release and no-plan-tool fallback remain
unchanged. TUI and headless tests distinguish requests from denied turns and
resumed-session totals.

Live-model before/after quality and efficiency remains unmeasured by this change.
A subsequent authorized comparison should use identical repository revisions,
questions, model/effort and cache conditions, recording root requests, reported
uncached/cache-read/cache-write input, output, latency and independently checked
answer/citation correctness. Do not advertise the scripted 50% request reduction
as a measured production saving.

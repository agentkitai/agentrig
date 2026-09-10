# Structured questions

The builtin `ask_user` takes `{ "prompt": "Output format?", "options": ["Text", "JSON"] }`.
It requires 2–4 distinct options and always permits a free-text answer. A required
question suspends the model turn for at most 120 seconds (the run's earlier cancellation
still wins). A missing, invalid or refused answer fails the run; the model does not
silently continue with an invented answer.

In the TUI, enter a listed number or free text. Permission prompts take priority,
then clarification, then supervisor escalation. Questions have a separate bounded
queue; answering one never approves tools, grants standing permission, or submits
a new task. Cancellation and shutdown close pending questions.

Explicit YOLO/skip-permissions runs do not open TUI/ACP human clarification
dialogs. Reserve questions for genuinely required information; an unanswered
required question still fails promptly rather than inventing an answer.

Headless `run` defaults to `--answer-policy fail`. An operator may explicitly select:

- `--answer-policy first-option`: choose option 1, recorded as automated.
- `--answer-policy file:answers.json`: use exact prompt/options matches from a literal
  UTF-8 JSON file. At most16 entries and 64 KiB; the final file must be regular,
  not a symlink. No scripts, substitutions, fallback matching or reload during the run.

```json
{
  "version": 1,
  "answers": [{
    "question": { "prompt": "Output format?", "options": ["Text", "JSON"] },
    "answer": { "option": 1 }
  }]
}
```

File option indices are zero-based; `{ "text": "a literal answer" }` is also valid.
A changed prompt or option list does not reuse an answer. Read/tool denial still
wins over any answer policy. Heartbeat runs do not expose `ask_user`.

SDK callers register `askUserTool()` (also included in `builtinTools()`) and supply
`AgentConfig.onQuestion(request, signal)`. Return `{ source, answer }` or `null`.
Sources are `human`, `first-option`, `file`, and `supervisor`. The handler is an
explicit trusted-host policy; there is no automatic supervisor answerer. Honor
the signal and use the runtime request ID, not a model-generated correlation ID.
An arbitrary tool named `ask_user` does not receive this private runtime seam.

With trusted SDK `approvalMode: "unattended"`, `onQuestion` is not called.
An operator may separately supply `onUnattendedQuestion` for a noninteractive
policy. Headless `run` wires its explicit answer policy to this seam for both
parent and children. There is no default automatic choice. Replies claiming
`source: "human"` on this seam are refused; automated answers remain external
advisory content. A trusted host must not put a human dialog inside this policy.

## ACP extension v1

Clients opt in with initialize `_meta: { "agentrig": { "questions": 1 } }`.
AgentRig advertises questions version 1 in its initialization metadata. Without
client opt-in a required question fails promptly; permission RPCs are not reused.

The agent sends `_agentrig/question` with `{ version: 1, sessionId, question }`.
`question` contains runtime `id`, underlying `sessionId`, `toolUseId`, `prompt`
and `options`. Reply with `{ id: question.id, reply: { source: "human", answer:
{ option: 1 } } }` (or free text). Automated clients must report their actual source,
not claim a human answered. Invalid/out-of-range/stale replies do not answer.
The existing eight-outbound-request and shared 4 MiB transport limits include
questions. Local cancellation releases the run, while the unanswered SDK slot
remains reserved until a real reply or connection close. No lossless/retry claim.

Answers are clarification, **not execution authorization**. Even a human answer
does not clear an existing external-input restriction. Automated answers are external
advisory content through history and compaction. Protected `question.asked` and
`question.answered` events preserve attribution, not proof of human identity or
model obedience. Answers may be sensitive and are recorded in the immutable raw
log; use the existing redacted export for sharing. Cooperative cancellation cannot
guarantee a remote client or uncooperative SDK callback has stopped its own work.

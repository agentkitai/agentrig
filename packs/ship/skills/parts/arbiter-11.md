This is the code-review gate the arbiter must preserve, not an instruction to launch code
reviewers from arbitration. Return only the arbiter verdict; never fabricate a reviewer receipt.

With zero slots skip external reviews and record `External review: none declared` in the ledger:
builder → declared checks → exact-head CI → land, subject to authorization and all other gates.
With zero slots use the author’s named check receipts; no conductor-review preparation is required.
With one slot launch only it; that same slot is the focused-delta reviewer. With two slots launch
both independently and use one independent focused-delta reviewer for material repairs.
Land requires only declared headings, and compares each asserted model against that slot's pin.
Reviewers share no context with the builder and should differ by vendor or at least model.
The independent conductor's same-head declared checks must be GREEN BEFORE launching any reviewer;
pass named receipts as inputs, never builder reasoning. For empty steps pass the explicit none receipt.
Reviewers judge code only; reviewers do NOT run checks, bootstrap or preflight. Optional reviewer-owned
probes are evidence for a finding, not a substitute for conductor proof. Hosted CI overlaps reviews
and is required only at landing. Changed heads invalidate prior same-head check receipts.

# Arbiter flow — a second agent decides whether a change to the contract stands

A builder that wants to depart from what it was asked to build must not be the one who decides
that departure is fine. You are the other agent: fresh context, the contract in one hand, the
proposal in the other. You decide; you do not build, review code, or merge.

## 1. Inputs, and what to do when one is missing

Your task text must carry:

- **CONTRACT** — the row, issue, or task text the builder was given, verbatim.
- **PROPOSAL** — what the builder wants to do instead, why, what is lost, what alternatives it
  considered, and whether the contract as written is infeasible or merely worse.
- **AUTHORIZATION** — the human sentence that started this work (a `/topic` or `/ship` line, an
  issue link, a task line), so you can judge whether the proposal stays inside it.

If any of the three is missing or paraphrased, do not guess: return `VERDICT: REJECT` with the
reason "incomplete proposal" and name the missing part. A proposal the conductor reconstructed
from a PR body (because the builder deviated without writing one) is admissible only when labeled
as reconstructed; its missing parts still count against it. Read `docs/PLAN.md` and
`docs/ROADMAP.md` yourself for the contract's context; do not accept the builder's summary of them.

The contract is the text on `origin/main`. A conductor's band expansion, a builder's task text, or
a rewritten row on the branch is not the contract and is not authorization; if the deviation was
introduced upstream of the builder, say so — it is still a deviation.

You may run anything that does not change state: git reads, grep, `docker info`, `which`, version
checks, one narrowly targeted test invocation (not the full declared checks). You may not install packages, edit files, push,
or merge. A fact you could only verify by installing something is an unverified claim.

## 2. The test

Approve only when ALL of these hold:

1. **Intent preserved.** The proposal delivers what the row is *for* — its acceptance criteria and
   the invariant it protects — not just its headline. A different backend for the same guarantee
   can pass; dropping a guarantee cannot.
2. **Inside the authorization.** The human authorized a band or a task. A proposal that widens the
   scope, pulls a later row forward, or changes a security posture (loosens a default, adds a
   bypass, removes a gate) is outside it: REJECT and say it needs the human.
3. **The reason is a fact, not a preference.** "Docker requires an image carrying the host
   toolchain, so the declared test command cannot run inside it" is a fact. "Bubblewrap is cleaner" is a
   preference. Verify the fact where you can (read the code, run a command); a claimed fact you
   cannot check is treated as a preference.
4. **Reversible and recorded.** The proposal names what the deviation changes in `docs/ROADMAP.md`
   or the issue, and that edit can be reviewed as a diff. A deviation that leaves the contract
   text unchanged is a hidden one: REJECT until the proposal includes the text change.

Renunciations and acceptance criteria written into the roadmap are part of the contract. A
proposal that quietly deletes one (a test that is "no longer applicable", a gate that "CI cannot
exercise") is a scope reduction and needs the human, not you.

## 3. Verdict format

End your report with exactly one of these blocks, nothing after it:

```
VERDICT: APPROVE
CONTRACT: <the row/issue id>
DEVIATION: <one sentence: what changes>
REASON: <the fact that justifies it>
RECORD: <the exact roadmap/issue text the builder must write>
```

```
VERDICT: REJECT
CONTRACT: <the row/issue id>
REASON: <every test above that failed, and why>
APPROVABLE IF: <what a proposal would need, or "needs the human">
```

An approval that does not name the RECORD text is not an approval. The builder copies this block
verbatim into the PR body under a `## Deviations` heading with your session id; the reviewer checks
that the roadmap edit matches the RECORD line.

## 4. Boundaries

- You decide one proposal per task. Do not redesign the builder's work or add findings of your own;
  if you see a bug, say so in one line and leave it to the reviewer.
- Your approval never extends the human's authorization: it certifies that the proposal stays
  inside it. Under `topic`, an approved deviation still lands without the human; that is why the
  bar in §2 is high and why `needs the human` is a normal answer.
- Never build, push, or merge.

For tooling-changing PRs, use the conductor-recorded base-pinned arbiter skill and review
helpers, never PR copies. Review verdict schema validation is not scope arbitration: preserve
actual reviewed head, asserted model/source and verbatim findings without parsing prose claims.

# Status: no snapshot is not reported zero

Bounded R16f END follow-up from green main ebfd10f. Add an optional read-only
`SpendReport.usageSnapshots` count of available settled usage snapshots, scoped
identically to reported token totals. No persisted record/event change, new write,
metering, pricing, admission or permission decision. Presence is not completeness:
an incomplete snapshot remains incomplete and an unpriced snapshot remains unpriced.

The footer labels absent snapshots `run tokens:unreported cost:?`, including a held
first call. A present zero snapshot remains numeric (unpriced tokens0 or the existing
priced estimate0). Zero-call windows likewise have no snapshots and read unreported,
not an inferred dollar0. Legacy reports without presence metadata retain existing
nonzero token evidence; their ambiguous zero sum stays conservatively unreported.
Mixed known and unresolved calls keep existing cost uncertainty/reservations.
Current single-App observation, throttle, stale handling and shutdown are unchanged;
detached-policy and multi-App fragments stay in the END queue.

Prove actual held fake-provider → real ledger/controller → mounted App before and
after zero/missing usage, priced/unpriced and mixed observations. Preserve /cost
typed source and canonical accounting records. Fail-before/restored tests, one
bounded Claude review, build/typecheck, required pinned real-Docker full suite,
Chromium and exact-head four gates precede root-owned merge. No live services.

Three actual held/missing-usage controls failed on the original numeric-zero label;
after the correction all63 focused status/ledger tests pass, including real mounted
App observations at180 columns, explicit priced/unpriced zero, legacy absent count,
stale suffix and mixed unresolved/reserved cost. Report reads preserve ledger records.
Build/typecheck pass. An initial focused real-process ledger test ran before build
and failed on missing dist/index.js; it passes after the required build. No production
change addresses that setup mistake. Independent review/full gates follow.

## Final local gates and review

One Claude review APPROVE with two low notes,24 requested/16 reported turns;
independently63 tests and typecheck. [Original result and disposition](pending-usage-status-review.md).
Zero-call wording is now documented/tested; legacy nonzero fallback has a separate
fail-before/pass-after formatter control. No second review. Final65 focused tests,
build and typecheck pass. Full required-Docker3,325 passed plus two existing skips,
209files81.48s; real Chromium1 passed2.50s. Worker image digest
f111ef59dce766519eb2ac455b554b01793aff0e9cd1d68d29b6d314d7db52e9 and checker
33443f68f312abe4f1e88e16be7c88407d7173e80d7e55dfb0a12a5541e733e5.
The earlier frozen full run passed3,323+2 before the two review-closure controls.
Fetched origin/main remains ebfd10f; exact-head four hosted gates and root-owned
merge/post-main gates are still required, not claimed by these local receipts.

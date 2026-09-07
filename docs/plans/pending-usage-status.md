# Status: no snapshot is not reported zero

Bounded R16f END follow-up from green main ebfd10f. Add an optional read-only
`SpendReport.usageSnapshots` count of available settled usage snapshots, scoped
identically to reported token totals. No persisted record/event change, new write,
metering, pricing, admission or permission decision. Presence is not completeness:
an incomplete snapshot remains incomplete and an unpriced snapshot remains unpriced.

The footer labels absent snapshots `run tokens:unreported cost:?`, including a held
first call. A present zero snapshot remains numeric (unpriced tokens0 or the existing
priced estimate0). Legacy reports without presence metadata stay conservative.
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

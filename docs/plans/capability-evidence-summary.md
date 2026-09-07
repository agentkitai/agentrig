# Capability evidence summary follow-up

The R10d END follow-up changes only the top-level conformance source label.
`observed` means at least one of tools, parallelTools, or caching has a non-unknown
sample, including a completed negative observation. It does not mean all dimensions
were observed or that any capability is universally supported. Per-dimension sources
remain authoritative. No report, or a report with all three dimensions unknown,
is `unverified-configured`; schema-only/cache-reporting observations do not change it.

Keep the full cloned report even when it contains only unknowns. Capability booleans,
cache format/TTL/fingerprint, model traffic, pricing, permission and sandbox behavior
are unchanged. The normal builder never probes as a side effect of reading a report.

Four fail-before controls cover failed/aborted core probes, schema-only evidence, and
the actual local HTTP failure → doctor → persisted cache → provider builder path.
Positive and negative single-dimension controls preserve partial observations and
configured fallbacks. Tests use fake streams/local HTTP only, never live provider spend.

Delivery requires build/typecheck, full required pinned-Docker tests, Chromium,
one bounded Claude review, exact-head CI and serialized merge/post-main checks.
The implementation PR holds final hosted receipts; this contract is not a CI claim.

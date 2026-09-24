# Train engine — R19d first slice

Private workspace package `@agentkitai/agentrig-train` owns directory queue state,
row execution, crash recovery, logs, STOP/PAUSE and status. It has no runtime core,
CLI or ship dependency. Existing directory names, row IDs and persisted schemas
are unchanged.

`createTrain(runtime, stages)` returns `runTrain`, `trainStatus`, `trainUsage` and
`trainCommand`. `TrainStages` replaces pre-check, prompt, receipt schema/parser and
verification independently; an optional command decorator supplies transport
policy. The receipt parser normalizes to the existing `{pr}` state field in this
compatibility slice. The engine still owns failure persistence and queue movement:
a thrown stage error halts the active row rather than advancing it.

`TrainRuntime` supplies read-only usage accounting and unified assistant-message
decoding. The core facade supplies the existing ledger/session implementation;
custom hosts may provide their own accounting without importing core. The public
ship stage set preserves the current workflow, including PR row binding, head/merge
checks, required workflow verification and bounded GitHub rate-limit retry.

This is not completion of R19d. Core still exports the legacy API and composes the
ship defaults; CLI calls are unchanged. Later slices switch CLI composition, remove
core train exports and relocate train-specific child-env/project-check helpers and
remaining accounting/message adapters before the final product boundary gate.

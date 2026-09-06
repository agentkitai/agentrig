# R5b — per-build extension failure isolation

R5a's trusted, atomic activation contract remains in force. After H7b PR #164 passed
exact post-merge CI 34029756772 on main `c88a72f`, this row resumes the extension lane.

One private disabled latch belongs to each loaded extension in a built agent. A handler
throw/rejection disables future hook, tool and command invocations across that extension;
other extensions and builtins continue. Reusing/resuming the agent does not reset it.
Only a new build activates a fresh instance. An expected tool `isError` or hook denial
is not a fault. Existing hook timeouts count as faults; ordinary run cancellation does not.
No new tool/command timeout or configuration is introduced.

Tool execution and registered permission/path/effect/operation/provenance/schema callbacks
share the same latch. A normal `safeParse` failure is invalid input, not an extension fault.
A throwing background-work probe disables its owner and conservatively returns `true` thereafter,
so checkpointing cannot mistake an unavailable probe for proof that writers have stopped.
Disabled tools refuse before descriptor callbacks. No already-advertised tool schema is silently
rewritten; a subsequent call receives a normal failed tool result without executing the handler.

Failure attribution comes from actual registered objects and the current runtime execution,
not extension names, exception text or the extension's restricted event emitter. One
`extension.error` records the disabling transition, including the runtime phase and surface.
Active hook/tool failures belong to their failing run, including session-end hooks before
the terminal event. Idle slash-command failure prints immediately and queues a bounded
receipt for the next started/resumed run; it never appends to a closed conversation.
Loaded receipts distinguish disabled instances and never claim repeated activation.

An internal async-local run binding and actual registered-object ownership attach synchronous
callback failures to their calling run. Bounded pending receipts drain after hooks/tool execution
and before terminal emission. Concurrent or later runs cannot take another run's pending failure.
Calls made directly through the SDK outside any active run queue one startup/idle receipt and
notify the supplied diagnostic observer; diagnostic failures cannot undo the disabled latch.

This is exception containment, not a security sandbox: ambient trusted Node code can read
environment/files/network, terminate/block the process, or continue abandoned async effects.
Disabling cannot stop already executing code. No provider/credentials/event authority is
added to the extension context; trust/import restrictions and no-child-surface inheritance
remain unchanged. Package installation and process isolation remain outside this row.

Validation uses actual imported modules, agent and TUI dispatch, cross-surface suppression,
healthy neighbors, reuse/concurrent-run attribution, idle/terminal ordering, existing timeout,
abort, expected-error and counterfeit-event negative controls. Full build/typecheck/tests,
restored named mutants, exactly one bounded independent review and exact-head three-platform
CI precede root-coordinated merge and post-merge CI. No live evaluation spend or benefit claim.

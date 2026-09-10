# Readable answers — user-approved correction

The user authorized fixing the ordinary-query presentation and efficiency issues
observed in session `5ea07c07`. This first PR changes presentation only; proportional
planning and query-context guidance follow separately. Builder: Codex/operator.

Tables use natural content widths when they fit. Otherwise they become labelled
rows, with terminal wrapping rather than clipped cell text. Structural row/column,
source, output and parser limits still apply and must remain visibly disclosed.
No raw session event is rewritten. Empty tables retain their headers; Unicode
cells are never split by code-point truncation.

Mechanically matching local file citations display the full path and line range
once. Arbitrary labels, mismatched paths/lines and external URLs retain their
targets. This is presentation only: no link navigation, filesystem read or new
terminal escape capability is introduced.

Regression tests cover 40/80/120-column permission tables, spare-width allocation,
stacked/empty/Unicode tables, exact citations and mismatch controls, existing ANSI
goldens and real App/log immutability. New tests fail on old code; bounded renderer
and control sanitization tests remain active. Independent Claude/Codex review,
green exact-head CI and post-merge CI gate delivery.

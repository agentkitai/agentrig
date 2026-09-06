# R5e — fail-closed manifest boundaries

R5e now precedes extension and package loading: the user activated the remaining product vision
and requested dependency-aware parallel work. This supersedes the ordering assumptions of the
retained `R5.md` draft. This row changes the existing skill loader and provides reusable schemas
for later extension/package consumers; it does not add an importer or installer.

## Skill format and compatibility

Plain Markdown without an opening frontmatter fence retains filename/first-line fallbacks.
When a fence exists, the complete frontmatter must parse and validate before either catalogue or
body is available. BOM, CRLF, trailing fence whitespace and an EOF closing fence are supported.
An unterminated block is an error, never plain Markdown. Missing `name`/`description` retain the
existing fallback; empty supplied values fail. Existing checked-in skills remain unchanged.

V1 is a deliberately flat, non-YAML dialect: `key: value`, simple paired single/double quotes,
blank lines and column-zero comments. Optional `schema: 1` explicitly selects v1; omission is
fixed to legacy v1, not future latest. Fields: `name`, `description`, `version`, `license`,
`compatibility`, `schema`. Unsupported keys, `allowed-tools`, duplicate keys, nesting, collections,
anchors, multiline scalars, quoted escapes and unquoted booleans/null fail the whole skill.
All metadata values are strings; quoting makes literal booleans/null explicit strings. The
existing sanitized 80/200-character name/description bounds still apply before name resolution.
Neither accepted metadata nor skill prose grants execution permissions.

Generated provenance, `locked` and trigger metadata are intentionally unsupported today. R6b/R6g
must extend a typed versioned schema alongside their actual consumers and compatibility tests;
silently accepting `locked` now would falsely imply an enforcement guarantee.

## Names and bounds

`resolveManifestNames` is the common deterministic resolver: lower numeric precedence wins,
case-insensitive keys, code-unit path ordering (not locale-dependent). At the winning precedence,
two definitions make the name unavailable, including lower-precedence fallbacks. Diagnostics
name both collision paths; shadowing reports the losing and winning paths. Future package roots
at one precedence use the same resolver before activation.

Skills use root-array order (the CLI already orders explicit, trusted-project, user roots).
Repeated resolved root paths are deduplicated. Each root is fully scanned before `maxSkills`
limits the final catalogue, so a late duplicate cannot evade detection. Root caps: 1,024 directory
entries and 8 MiB of read text, alongside the existing default 256 KiB per file. Exceeding a root
cap rejects that entire root with a diagnostic, never accepting its unchecked prefix. Other roots
remain independently eligible. Regular-file/non-symlink checks remain; this is not an OS-level
defense against a concurrent hostile filesystem writer.

## Future consumer boundaries

`ExtensionManifestV1`: strict name, nonempty release version, `apiVersion: 1`, unique declared
`surfaces` (`hooks`, `tools`, `commands`). `validateExtensionSurfaces` validates the entire manifest
and refuses any actual registration outside it. R5a must validate a mandatory sidecar **before
import** and validate the registration draft before committing it. This declaration is review
metadata and API enforcement, not a sandbox for trusted in-process Node code.

`PackageManifestV1`: npm name, nonempty release version, required strict `agentrig: {apiVersion: 1}`.
The root is also strict: explicitly supported common npm metadata is preserved, not interpreted
as authority (`description`, `license`, `private`, `keywords`, `author`, `contributors`,
`repository`, `homepage`, `bugs`, `funding`, `type`, `main`, `module`, `types`, `exports`, `files`,
`engines`, `packageManager`, `devDependencies`). Other top-level fields reject the package,
including permission-shaped fields. This intentionally narrows the draft's arbitrary npm
passthrough: new fields require an explicit schema/consumer decision. An empty `scripts` map is
accepted; **all nonempty scripts maps are refused**, rather than relying on an incomplete lifecycle
name blocklist. These are inert content packages, not npm execution environments. Script fields,
nonempty runtime/optional dependencies and `bin` are unsupported and refused. R5c must consume
this schema before copying/installing anything and validate nested extension/skill units before
activation. Archive safety, integrity receipts, module import and package installation remain
their own roadmap work, not capabilities claimed by this row.

## Acceptance and delivery

`manifests.test.ts` covers strict versions/fields, surface refusal, npm compatibility, real
loader-to-tool denial, late/sanitized duplicates, cross-root shadowing, bounded scan refusal and
determinism. Existing `skills.test.ts` proves plain Markdown and all repository skills still
load. The new suite also runs in Windows CI. Required delivery: build, typecheck, full tests,
bounded independent review, detected/restored negative mutations, exact-head Linux/macOS/Windows
CI, merge, then exact-main CI. Final receipts belong to the PR to avoid recursive docs-only PRs.

One bounded independent review on `c5a9972` found the package-script blocklist incomplete. The
final schema refuses all nonempty scripts, with preprepare/postprepare/dependencies and ordinary
script regressions. Material finding repaired and self-verified; no second general review.

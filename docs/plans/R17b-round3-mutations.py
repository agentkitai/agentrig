"""R17b round-3 load-bearing probes. No external providers; source restored in finally.
Run from repository root: TMPDIR=/var/tmp python3 docs/plans/R17b-round3-mutations.py
Requires pnpm install. Output is JSON; exit zero requires red mutant/green restored.
"""
import json, os, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[2]
probes = [
    ('HIGH1 pre-provider validation', 'packages/cli/test/recommended-defaults.test.ts',
     "review: {provider, process: reviewProcess}}).parseAsync(['review', '--profile', 'recommended', '--comment'], {from:'user'});",
     "review: {provider, process: reviewProcess}}).parseAsync(['review', '--profile', 'recommended'], {from:'user'});",
     ['packages/cli/test/recommended-defaults.test.ts']),
    ('HIGH2/Codex coverage', 'packages/core/src/diagnostics.ts',
     'if (checksCoverage && !touchedFileListed) {', 'if (false) {',
     ['packages/core/test/post-edit-diagnostics.test.ts']),
    ('HIGH2 default coverage invocation', 'packages/cli/src/config.ts',
     'args: ["--noEmit", "--pretty", "false", "--listFiles"]',
     'args: ["--noEmit", "--pretty", "false"]',
     ['packages/cli/test/recommended-defaults.test.ts']),
    ('MEDIUM3 recommended note', 'packages/cli/src/config.ts',
     'if (!recommended && profile === "recommended" && !selected(user) && !selected(project)) {',
     'if (false) {', ['packages/cli/test/recommended-defaults.test.ts']),
    ('LOW4 exact reviewer verbose deletion', 'packages/cli/src/tui/start.tsx',
     '    ...(opts.verbose === undefined ? {} : { verbose: opts.verbose }),\n', '',
     ['packages/cli/test/prompt-history-startup.test.ts']),
    ('LOW7 undo wording', 'packages/core/src/checkpoint-undo.ts',
     'only the last two mutating-turn refs are retained', 'only the last two sealed turn refs are retained',
     ['packages/core/test/checkpointer.test.ts']),
    ('LOW7 diff wording', 'packages/cli/src/tui/manual.ts',
     'only the last two mutating-turn refs are retained', 'only the last two sealed turn refs are retained',
     ['packages/cli/test/manual-commands.test.ts']),
]
results = []
for name, relative, old, new, tests in probes:
    path = ROOT / relative
    original = path.read_text()
    assert original.count(old) == 1, (name, original.count(old))
    command = ['pnpm', 'exec', 'vitest', 'run', *tests]
    def run():
        p = subprocess.run(command, cwd=ROOT, env=os.environ, capture_output=True, text=True)
        return {'exit': p.returncode, 'output': p.stdout + p.stderr}
    try:
        path.write_text(original.replace(old, new))
        red = run()
    finally:
        path.write_text(original)
    green = run()
    results.append({'name': name, 'path': relative, 'old': old, 'new': new,
                    'command': command, 'mutant': red, 'restored': green})
print(json.dumps(results, indent=2))
if any(r['mutant']['exit'] == 0 or r['restored']['exit'] != 0 for r in results):
    raise SystemExit(1)

"""Run after pnpm install. Temporarily mutates this worktree; always restores bytes."""
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
env = {**os.environ, 'TMPDIR': os.environ.get('TMPDIR', '/var/tmp')}
old = 'bf66779439f3e077c3d2f5b7a6c1a22a56c8bb1f'
results = []
for name, source, tests, transform in [
    ('startTui verbose pass-through deletion', 'packages/cli/src/tui/start.tsx', ['packages/cli/test/prompt-history-startup.test.ts'],
     lambda data: data.replace(b'    ...(opts.verbose === undefined ? {} : { verbose: opts.verbose }),\n', b'')),
    ('pre-fix diagnostics and review profile', 'packages/cli/src/config.ts', ['packages/cli/test/recommended-defaults.test.ts'], None),
    ('pre-fix seal-before-prune', 'packages/core/src/checkpointer.ts', ['packages/core/test/checkpointer.test.ts', '-t', 'prune failure'], None),
]:
    path = root / source
    saved = path.read_bytes()
    mutated = transform(saved) if transform else subprocess.check_output(['git', 'show', f'{old}:{source}'], cwd=root)
    assert mutated != saved, f'{name}: mutant did not apply'
    command = ['pnpm', 'exec', 'vitest', 'run', *tests]
    try:
        path.write_bytes(mutated)
        red = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
    finally:
        path.write_bytes(saved)
    green = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
    results.append({'probe': name, 'command': command, 'mutantExit': red.returncode, 'restoredExit': green.returncode,
                    'mutantOutput': red.stdout + red.stderr})
    assert red.returncode != 0 and green.returncode == 0, results[-1]
print(json.dumps(results, indent=2))

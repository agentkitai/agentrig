"""Reproducible R17b repair probes. Run only in a disposable/clean worktree; restores sources.
Uses real failing tests, not static matches. Every mutant must exit nonzero and contain FAIL.
"""
import json, os, pathlib, subprocess, tempfile
ROOT = pathlib.Path(__file__).resolve().parents[2]
V = ['pnpm','exec','vitest','run']
probes = [
 ('tui-start-wiring', 'packages/cli/src/tui/start.tsx', '    ...(opts.verbose === undefined ? {} : { verbose: opts.verbose }),', '', ['PTY-expanded']),
 ('runtime-defaults', 'packages/cli/src/config.ts', 'const recommended = [', 'const recommended = false && [', ['BUILD','packages/cli/test/recommended-runtime.test.ts']),
 ('acp-presentation', 'packages/cli/src/acp.ts', 'if (flags.json)', 'if (flags.json || flags.verbose)', ['packages/cli/test/recommended-protocols.test.ts','-t','acp']),
 ('mcp-presentation', 'packages/cli/src/mcp-serve.ts', 'if (flags.json)', 'if (flags.json || flags.verbose)', ['packages/cli/test/recommended-protocols.test.ts','-t','mcp-serve']),
 ('web-presentation', 'packages/cli/src/web.ts', 'if (flags.json)', 'if (flags.json || flags.verbose)', ['packages/cli/test/recommended-protocols.test.ts','-t','Web ignores']),
 ('precedence', 'packages/cli/src/config.ts', '    ...cli,', '    ...cli,\n    ...withoutProfiles(project),', ['packages/cli/test/config.test.ts','-t','explicitly typed CLI flag beats project']),
 ('negative-cli', 'packages/cli/src/config.ts', '    ...cli,', '    ...cli,\n    ...withoutProfiles(project),', ['packages/cli/test/config.test.ts','-t','explicit negative CLI']),
 ('scheduled-provenance', 'packages/cli/src/config.ts', 'ingestOnEndExplicit: cli.ingestOnEnd !== undefined || configHas("ingestOnEnd"),', 'ingestOnEndExplicit: false,', ['packages/cli/test/config.test.ts','-t','scheduled']),
 ('sandbox-omission', 'packages/cli/src/config.ts', 'if (recommended && resolved.sandbox !== undefined', 'if (false && recommended && resolved.sandbox !== undefined', ['packages/cli/test/recommended-defaults.test.ts','-t','visibly omitted']),
 ('restore-sources', 'packages/cli/src/run.ts', 'if (opts.superviseExplicit !== true || opts.checkpointsExplicit !== true)', 'if (false)', ['packages/cli/test/recommended-defaults.test.ts','-t','implicit defaults cannot arm']),
 ('retention', 'packages/core/src/checkpointer.ts', 'refs.slice(2)', 'refs.slice(refs.length)', ['packages/core/test/checkpointer.test.ts','-t','sealing retains']),
 ('tui-preference', 'packages/cli/src/tui/controller.ts', 'this.state.verbose = opts.verbose ?? false;', 'this.state.verbose = false;', ['packages/cli/test/tui.test.ts','-t','initializes expanded']),
 ('diagnostic-scope', 'packages/core/src/diagnostics.ts', 'arg === "{path}" ? receipt.changed.path : arg', 'arg', ['packages/core/test/post-edit-diagnostics.test.ts','-t','exact diagnostic path']),
 ('diagnostic-root', 'packages/cli/src/config.ts', 'check.parser === "tsc" ? tsProject : pythonProject.some(Boolean)', 'true', ['packages/cli/test/recommended-defaults.test.ts','-t','implicit checkers']),
 ('profile-scope', 'packages/cli/src/config.ts', 'if (!names.includes(profile))', 'if (profile !== "recommended" && !names.includes(profile))', ['packages/cli/test/recommended-defaults.test.ts','-t','shared resolver']),
 ('ci-presentation', 'packages/cli/src/ci-run.ts', 'if (options.json === true)', 'if (options.json === true || options.verbose === true)', ['packages/cli/test/recommended-defaults.test.ts','-t','CI normalizes']),
 ('evaluation-presentation', 'packages/cli/src/evaluation-fixtures.ts', '"toolSummaries", "provider",', '"provider",', ['packages/cli/test/recommended-defaults.test.ts','-t','evaluation accepts']),
 ('removed-flag', 'packages/cli/src/program.ts', '.option("--supervisor-abort",', '.option("--checkpoints", "mutant resurrected option")\n    .option("--supervisor-abort",', ['packages/cli/test/recommended-defaults.test.ts','-t','migrated']),
]
results=[]
for name,path,old,new,tests in probes:
 p=ROOT/path; original=p.read_text()
 if original.count(old)!=1: raise RuntimeError(f'{name}: need one needle, found {original.count(old)}')
 try:
  p.write_text(original.replace(old,new))
  if tests[0] in ['PTY-expanded','BUILD']:
   subprocess.run(['pnpm','build'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  command=['python3','.agentrig/r17/recommended-smoke.py','--expanded'] if tests[0]=='PTY-expanded' else V+(tests[1:] if tests[0]=='BUILD' else tests)
  r=subprocess.run(command,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  killed=r.returncode!=0 and ('FAIL ' in r.stdout or (tests[0]=='PTY-expanded' and '"expanded_preference_applied": false' in r.stdout))
  results.append(dict(probe=name,path=path,old=old,new=new,command=command,exit=r.returncode,killed=killed,output=r.stdout))
  print(name,r.returncode,'KILLED' if killed else 'SURVIVED',flush=True)
 finally:
  p.write_text(original)
  if tests[0] in ['PTY-expanded','BUILD']:
   subprocess.run(['pnpm','build'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if not killed: break
out=ROOT/'docs/plans/R17b-repair-mutations.json';out.write_text(json.dumps(results,indent=2)+'\n')
if len(results)!=len(probes) or not all(r['killed'] for r in results): raise SystemExit(1)

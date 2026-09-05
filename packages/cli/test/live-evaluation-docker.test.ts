import { it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const inspect = process.platform === "linux"
  ? spawnSync("docker", ["image", "inspect", "alpine:3.20", "--format", "{{.Id}}"], { encoding: "utf8", timeout: 10_000 })
  : null;
const available = inspect?.status === 0;
if (!available) console.warn("E3 Docker negative controls skipped: requires Linux and preloaded alpine:3.20 (never pulls).");

it.skipIf(!available)("isolates a real worker and cleans up only its own timed-out container", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
    import {dockerRun,command} from './eval/live-support.mjs';
    const image=${JSON.stringify(inspect?.stdout.trim())};const workspace=await mkdtemp('/tmp/agentrig-e3-docker-test-');
    const control='agentrig-e3-control-'+randomUUID();
    try{
      assert.equal((await command('docker',['create','--name',control,image,'true'])).code,0);
      const probe=await dockerRun({image,workspace},['/bin/sh','-c',
        'test ! -e /evaluator && test ! -e /var/run/docker.sock && test ! -e /home/amit && test -z "$OPENAI_API_KEY" && test -z "$AGENTRIG_OPENAI_CHATGPT_TOKEN" && test "$(ls /sys/class/net)" = lo && touch /workspace/allowed && ! touch /tmp-not-writable && mount']);
      assert.equal(probe.code,0,JSON.stringify(probe));assert.match(probe.stdout,/on \\/ type overlay \\(ro[,)]/);
      const timed=await dockerRun({image,workspace},['/bin/sh','-c','sleep 60'],undefined,2000);
      assert.equal(timed.infrastructure,true);assert.equal((await command('docker',['inspect',timed.containerName])).code,1);
      assert.equal((await command('docker',['inspect',control])).code,0,'unrelated container was removed');
      console.log('real isolation and timeout cleanup passed');
    }finally{await command('docker',['rm','--force',control]);await rm(workspace,{recursive:true,force:true});}
  `], { cwd: root, encoding: "utf8", timeout: 40_000 });
  expect(output).toContain("real isolation and timeout cleanup passed");
}, 45_000);

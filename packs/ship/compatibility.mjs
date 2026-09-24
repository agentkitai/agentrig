#!/usr/bin/env node
// Checked-in compatibility paths are outputs, never policy inputs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkills } from '../../packages/core/dist/index.js';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const lf = text => text.replace(/\r\n/g, '\n');

export async function compatibilityCopies() {
  const skills = await discoverSkills({ roots: [resolve(repo, 'packs/ship/skills')], onError: error => { throw error; } });
  if (skills.map(skill => skill.name).join(",") !== "arbiter,dogfood,land,review,ship,topic") throw new Error("Incomplete ship skill inventory");
  const copies = new Map();
  for (const skill of skills) copies.set(`.agentrig/skills/${skill.name}/SKILL.md`,
    `---\nname: ${skill.name}\ndescription: ${skill.description}\n${skill.flags === undefined ? "" : `flags: ${JSON.stringify(skill.flags)}\n`}---\n\n${lf(skill.body)}\n`);
  copies.set('docs/SHIPPING-WORKFLOW.md', lf(await readFile(new URL('./docs/SHIPPING-WORKFLOW.md', import.meta.url), 'utf8')));
  return copies;
}
export async function syncCompatibility(root = repo, write = false) {
  const drift = [];
  for (const [path, text] of await compatibilityCopies()) {
    const target = resolve(root, path);
    let current;
    try { current = await readFile(target, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === undefined || lf(current) !== text) {
      drift.push(path);
      if (write) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, text); }
    }
  }
  return drift;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const drift = await syncCompatibility(repo, write);
  if (drift.length) console.log(`${write ? 'Generated' : 'Compatibility drift (run pnpm ship:sync)'}:\n${drift.join('\n')}`);
  if (!write && drift.length) process.exitCode = 1;
}

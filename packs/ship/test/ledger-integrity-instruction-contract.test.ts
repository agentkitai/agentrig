import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readSkillText } from '../../../test/skill-text.js';
it.each(['dogfood','ship','review','land','topic'])('%s retains mechanical ledger and automatic manifest gates', name => {
  const text=readSkillText(`.agentrig/skills/${name}/SKILL.md`);
  expect(text).toContain('entire existing PR body is an append-only ledger');
  expect(text).toContain('Finding identities: ');
  expect(text).toContain('without adding severity');
  expect(text).toContain('retain every existing byte');
  expect(text).toContain('fetched comment IDs');
});
it.each(['ship','land','topic'])('%s consumes posted evidence without manual copying', name => {
  const text=readSkillText(`.agentrig/skills/${name}/SKILL.md`);
  expect(text).toContain('Do not manually copy manifests into the PR body');
  expect(text).toContain('review-provenance.mjs --comment');
  expect(text).not.toContain('Record this manifest verbatim in the PR');
});
it('workflow documents source fetch failures and retained landing checks', () => {
  const text=readFileSync('docs/SHIPPING-WORKFLOW.md','utf8').replaceAll('\r\n','\n');
  expect(text).toContain('fetch timeouts deny before the write');
  expect(text).toContain('durable gate does not replace live-comment checks');
  expect(text).not.toContain('from the PR manifest');
  expect(text).not.toContain('record\nthe adapter manifest');
});

// Trusted, deliberately scripted mechanics fixtures. Never a product provider/config choice.
export const fix = `const fs=require('fs');fs.writeFileSync('index.js',fs.readFileSync('index.js','utf8').replace("num !== ''","num.trim() !== ''"));fs.writeFileSync('eval-test-fix.js',"const assert=require('node:assert/strict');const f=require('./');assert.equal(f('   '),false);assert.equal(f(' 1 '),true);\\n");`;
export const broken = `require('fs').writeFileSync('eval-test-broken.js',"require('node:assert/strict').equal(require('./')(1),true);\\n");`;
export const investigation = `const fs=require('fs');fs.writeFileSync('answer.json',JSON.stringify({whitespace:false,trueValue:false,nullValue:false,hexString:true,boxedNumber:false,evidence:[{path:'index.js',quote:"typeof num === 'number'"}]}));fs.writeFileSync('answer.md','The implementation accepts finite primitive numbers and supported numeric strings. It rejects whitespace-only strings and other primitive or boxed types. These statements need independent human review.');`;

export function scriptedProvider(script, role, usage = true) {
  let calls = 0;
  return { id: 'scripted-fixture', model: 'mechanics-only',
    capabilities: { tools: true, parallelTools: false, caching: false, contextWindow: 100_000 },
    async *stream() {
      if (role === 'supervisor') yield { type: 'text_delta', text: '{"pass":true,"gaps":[]}' };
      else if (calls++ === 0) yield { type: 'tool_use', id: 'edit', name: 'bash', input: { command: `node -e ${JSON.stringify(script)}` } };
      else yield { type: 'text_delta', text: 'Completed.' };
      if (usage) yield { type: 'usage', usage: { input: 10, output: 5 } };
      yield { type: 'stop', reason: role === 'main' && calls === 1 ? 'tool_use' : 'end_turn' };
    } };
}

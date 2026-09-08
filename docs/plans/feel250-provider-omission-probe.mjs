// Manual, paid diagnostic. Default invocation performs no import/auth/network work.
// Two diagnostic model calls, 90 seconds each; no hard token cap. The backend rejects
// max_output_tokens, so the 128 request hint below cannot bind actual token usage.
if (process.argv.length !== 3 || process.argv[2] !== '--live') {
  console.log('Usage: pnpm build && node docs/plans/feel250-provider-omission-probe.mjs --live');
  console.log('Uses existing subscription credentials for two inert diagnostic calls; no tools execute.');
  console.log('No hard token cap; 90 seconds per call. Subscription usage is outside the E3 allowance.');
  process.exit(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--help') ? 0 : 1);
}
const { OpenAIChatGPTProvider } = await import('../../packages/core/dist/providers/openai-chatgpt.js');
const model = process.env.FEEL250_MODEL ?? 'gpt-6-astra';
const req = {
  system: 'Diagnostic only. Call the record_choice function exactly once with task="probe" and label="probe". Omit provider entirely. Do not provide a provider key. Do not output other text. The function is inert and will not be executed.',
  messages: [{role:'user',content:[{type:'text',text:'Call record_choice with only task and label.'}]}],
  maxTokens: 128,
  tools: [{name:'record_choice',description:'Inert diagnostic, never executes anything. provider is optional; OMIT provider.',inputSchema:{type:'object',properties:{task:{type:'string'},label:{type:'string'},provider:{type:'string',enum:['cloud','default'],description:'Optional. Omit this key.'}},required:['task'],additionalProperties:false}}],
};
for (const mode of ['omitted','false']) {
  const echoes=[];
  let capture;
  let captureError;
  const provider = new OpenAIChatGPTProvider({model,reasoningEffort:'low',retry:{maxRetries:0},fetchFn:async(url,init)=>{
    const body=JSON.parse(init.body);
    // Explicitly remove the repaired default to reproduce the historical control.
    for(const t of body.tools) {
      if(mode==='omitted') delete t.strict;
      else t.strict=false;
    }
    const response=await fetch(url,{...init,body:JSON.stringify(body)});
    capture=response.clone().text().then(raw=>{
      for(const line of raw.split('\n')) {
        if(!line.startsWith('data: ')) continue;
        try { const e=JSON.parse(line.slice(6)); if(e.response?.tools) echoes.push({event:e.type,tools:e.response.tools.map(t=>({name:t.name,strict:t.strict,required:t.parameters?.required}))}); } catch {}
      }
    }).catch(error => { captureError = String(error); });
    return response;
  }});
  const result={mode,model,toolCalls:[],usage:[],stop:[],echoes};
  try { for await(const e of provider.stream(req,AbortSignal.timeout(90000))) {
    if(e.type==='tool_use') result.toolCalls.push({name:e.name,input:e.input});
    if(e.type==='usage') result.usage.push(e.usage);
    if(e.type==='stop') result.stop.push(e.reason);
  } } catch(e) { result.error=String(e); }
  await capture;
  if (captureError !== undefined) result.captureError = captureError;
  console.log(JSON.stringify(result));
  if(result.error || captureError !== undefined) process.exit(1);
}

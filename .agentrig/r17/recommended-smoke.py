"""R17b zero-config TUI acceptance; deterministic local transport, no live calls."""
import http.server, threading, json, os, pty, subprocess, tempfile, time, select, pathlib, re
ROOT = pathlib.Path(__file__).resolve().parents[2]
calls = 0
class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        global calls
        request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        auxiliary=not request.get('tools')
        edit=not auxiliary and calls==0
        if not auxiliary: calls+=1
        delta={'tool_calls':[{'index':0,'id':'edit','type':'function','function':{'name':'write_file','arguments':json.dumps({'path':'a.ts','content':'const n: number = 1;\n'})}}]} if edit else {'content':'{"facts":[],"nothingDurable":true}' if auxiliary else '# Result\n\n**Ready**\n'}
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        for payload in [{'choices':[{'index':0,'delta':delta,'finish_reason':'tool_calls' if edit else 'stop'}]}, {'choices':[],'usage':{'prompt_tokens':10,'completion_tokens':2}}]:
            self.wfile.write(('data: '+json.dumps(payload)+'\n\n').encode()); self.wfile.flush()
        self.wfile.write(b'data: [DONE]\n\n')
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fake)
threading.Thread(target=server.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='r17-recommended-') as root:
    home=pathlib.Path(root)/'home'; home.mkdir(); cwd=pathlib.Path(root)/'project'; cwd.mkdir()
    subprocess.run(['git','init','-q'],cwd=cwd,check=True)
    master,slave=pty.openpty()
    env={**os.environ,'HOME':str(home),'USERPROFILE':str(home),'XDG_CONFIG_HOME':str(home),'OPENAI_API_KEY':'local-fixture-only','TERM':'xterm-256color','FORCE_COLOR':'1'}
    env.pop('NO_COLOR',None); env.pop('CI',None)
    command=['node',str(ROOT/'packages/cli/dist/index.js'),'--provider','openai','--model','gpt-4o','--base-url',f'http://127.0.0.1:{server.server_port}','--allow','write_file']
    p=subprocess.Popen(command,cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave); os.close(slave)
    output=b''; sent=False; denied=False; trust_answered=False; started=time.monotonic(); complete=False
    try:
        while time.monotonic()-started<30:
            if select.select([master],[],[],.1)[0]:
                try: output+=os.read(master,65536)
                except OSError: break
                if not trust_answered and b'Trust project' in output:
                    os.write(master,b'n\r'); trust_answered=True
                if not sent and b'type a task' in output:
                    time.sleep(.15); os.write(master,b'Write a TypeScript file then give a Markdown heading and bold result.'); time.sleep(.15); os.write(master,b'\r'); sent=True
                if sent and not denied and b'core:diagnostics' in output:
                    time.sleep(.2); os.write(master,b'n'); denied=True
                if b'memory: ingested' in output and b'Ready' in output:
                    time.sleep(.8)
                    while select.select([master],[],[],.1)[0]: output+=os.read(master,65536)
                    complete=True; break
            if p.poll() is not None: break
    finally:
        p.terminate()
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
        os.close(master); server.shutdown()
    text=output.decode(errors='replace'); clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text)
    frame=clean.rsplit('agentrig — type a task',1)[-1]
    logs=list((cwd/'.agentrig/raw/sessions').glob('*.jsonl'))
    events=[json.loads(line) for log in logs for line in log.read_text().splitlines()]
    raw_markdown=any(e.get('type')=='message.append' and '# Result' in json.dumps(e.get('message')) for e in events)
    evidence={'fixture':'local deterministic TUI; no config files or feature opt-ins','command':command,'session_ids':[p.stem for p in logs],
      'complete':complete,'raw_markdown_preserved':raw_markdown,'markdown_rendered': 'Result' in frame and 'Ready' in frame and '# Result' not in frame and '**Ready**' not in frame,
      'diagnostics_line':'Diagnostics:' in clean,'checkpoint_created':any(e.get('type')=='checkpoint.created' for e in events),
      'ingest_at_end':'memory: ingested' in clean,'config_absent':not (home/'.agentrig/config.json').exists() and not (cwd/'.agentrig/config.json').exists(),
      'security':'explicit fixture write approval; diagnostic exec approval declined via n; no YOLO/sandbox/grant change', 'terminal_final_frame':frame}
    print(json.dumps(evidence,indent=2))
    if not all(evidence[k] for k in ['complete','raw_markdown_preserved','markdown_rendered','diagnostics_line','checkpoint_created','ingest_at_end','config_absent']): raise SystemExit(1)

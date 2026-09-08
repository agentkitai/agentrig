"""R17c real interactive terminal probe, derived from the immutable R17a fixture."""
import http.server, threading, json, os, pty, subprocess, tempfile, time, select, pathlib, re
ROOT = pathlib.Path(__file__).resolve().parents[3]
class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for choice in [{'delta': {'role':'assistant','content':'BASELINE_TOKEN'},'finish_reason':None}, {'delta':{},'finish_reason':'stop'}]:
            payload={'id':'fake','object':'chat.completion.chunk','created':0,'model':'gpt-4o','choices':[{'index':0,**choice}]}
            self.wfile.write(('data: '+json.dumps(payload)+'\n\n').encode()); self.wfile.flush()
        self.wfile.write(b'data: [DONE]\n\n')
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fake)
threading.Thread(target=server.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='r17-terminal-') as home:
    master,slave=pty.openpty()
    # The subject is an interactive terminal, not Ink's CI-only static renderer.
    # Preserve colors; match the emitted text after removing terminal control sequences.
    env={**os.environ,'HOME':home,'XDG_CONFIG_HOME':home,'OPENAI_API_KEY':'fake-fixture-only','TERM':'xterm-256color','CI':'false'}
    command=['node',str(ROOT/'packages/cli/dist/index.js'),'--provider','openai','--model','gpt-4o','--base-url',f'http://127.0.0.1:{server.server_port}']
    start=time.monotonic(); p=subprocess.Popen(command,cwd=home,env=env,stdin=slave,stdout=slave,stderr=slave); os.close(slave)
    output=b''; ready=None; sent=None; first=None
    try:
        while time.monotonic()-start<30:
            if select.select([master],[],[],.1)[0]:
                try: chunk=os.read(master,65536)
                except OSError: break
                output+=chunk
                plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)
                if ready is None and b'type a task' in plain and re.search(rb'(?:^|\r?\n)>[ \r\n]', plain):
                    ready=time.monotonic(); time.sleep(.15); os.write(master,b'Reply with BASELINE_TOKEN'); time.sleep(.15); os.write(master,b'\r'); sent=time.monotonic(); output=b''
                if sent is not None and b'\r\nBASELINE_TOKEN\r\n' in plain:
                    first=time.monotonic(); break
            if p.poll() is not None: break
    finally:
        p.terminate()
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
        os.close(master); server.shutdown()
    print(json.dumps({'cold_start_to_prompt_ms':None if ready is None else (ready-start)*1000,'first_streamed_token_ms':None if first is None else (first-sent)*1000,'output':output.decode(errors='replace')},indent=2))
    if ready is None or first is None: raise SystemExit(1)

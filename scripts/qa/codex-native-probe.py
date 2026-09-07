"""Drive installed Codex in an isolated home; only synthetic OpenCodex prompts."""
import json, os, pathlib, selectors, subprocess, tempfile, time

root = pathlib.Path(tempfile.mkdtemp(prefix='lina-native-probe-'))
home = root / 'codex-home'; home.mkdir()
(home / 'config.toml').write_text('''model = "gpt-5.6-sol"
model_provider = "opencodex"
[model_providers.opencodex]
name = "OpenCodex"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = false
''')
records=[]
class Rpc:
 def __init__(self):
  self.err=(root/'stderr.log').open('ab')
  self.p=subprocess.Popen(['codex','app-server','--stdio'],cwd=root,env={**os.environ,'CODEX_HOME':str(home)},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.err,bufsize=0)
  self.sel=selectors.DefaultSelector();self.sel.register(self.p.stdout,selectors.EVENT_READ);self.buffer=b'';self.seq=0;self.tools=0
  self.request('initialize',{'clientInfo':{'name':'lina_native_probe','version':'1.0'},'capabilities':{'experimentalApi':True}})
  self.send({'method':'initialized','params':{}})
 def send(self,v): self.p.stdin.write((json.dumps(v)+'\n').encode())
 def event(self,deadline):
  while b'\n' not in self.buffer:
   remaining=deadline-time.monotonic()
   if remaining<=0 or not self.sel.select(remaining):raise TimeoutError('Codex event deadline')
   b=os.read(self.p.stdout.fileno(),65536)
   if not b:raise RuntimeError('Codex EOF')
   self.buffer+=b
  line,self.buffer=self.buffer.split(b'\n',1)
  e=json.loads(line)
  if 'id' in e and 'method' in e:
   if e['method']=='item/tool/call':
    self.tools+=1;self.send({'id':e['id'],'result':{'contentItems':[{'type':'inputText','text':'PROBE_TOOL_OK'}],'success':True}})
   else:self.send({'id':e['id'],'error':{'code':-32601,'message':'Probe does not support this request'}})
  return e
 def request(self,m,p):
  self.seq+=1;i=self.seq;self.send({'id':i,'method':m,'params':p});deadline=time.monotonic()+45
  while True:
   e=self.event(deadline)
   if e.get('id')==i and 'method' not in e:
    if 'error' in e:raise RuntimeError(json.dumps(e['error']))
    return e.get('result')
 def turn(self,thread):
  result=self.request('turn/start',{'threadId':thread,'input':[{'type':'text','text':'Call lina_probe exactly once and then reply with its returned text. Do not use any other tool.','text_elements':[]}],'model':'gpt-5.6-sol','effort':'low'})
  deadline=time.monotonic()+60;text=[]
  while True:
   e=self.event(deadline);m=e.get('method');p=e.get('params',{})
   if m=='item/agentMessage/delta':text.append(p.get('delta',''))
   if m=='turn/completed':return {'turn':p.get('turn',{}).get('status'),'tools':self.tools,'text':''.join(text),'error':p.get('turn',{}).get('error')}
 def close(self):
  self.p.stdin.close()
  try:self.p.wait(timeout=5)
  except subprocess.TimeoutExpired:self.p.terminate();self.p.wait(timeout=5)
  self.sel.close();self.err.close()

rpc=None
try:
 rpc=Rpc()
 r=rpc.request('thread/start',{'cwd':str(root),'model':'gpt-5.6-sol','modelProvider':'opencodex','approvalPolicy':'on-request','sandbox':'read-only','baseInstructions':'You are running a synthetic transport test. Follow only the short test request.','dynamicTools':[{'type':'function','name':'lina_probe','description':'Return the transport test marker.','inputSchema':{'type':'object','properties':{},'additionalProperties':False}}]})
 thread=r['thread']['id'];records.append({'step':'start','threadId':thread})
 records.append({'step':'first-turn',**rpc.turn(thread)});rpc.close();rpc=None
 rpc=Rpc();r=rpc.request('thread/resume',{'threadId':thread});records.append({'step':'resume','sameThread':r['thread']['id']==thread})
 records.append({'step':'resumed-turn',**rpc.turn(thread)})
except Exception as e:records.append({'step':'error','type':type(e).__name__,'error':str(e)[:1000]})
finally:
 if rpc:rpc.close()
 result={'root':str(root),'records':records,'teardown':'owned subprocesses exited; isolated state retained for audit'}
 path=(root / 'evidence.json');path.write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))

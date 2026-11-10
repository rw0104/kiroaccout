import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { verifyCrewManagedPackage } from '../../scripts/lib/crewManagedPackage.mjs'

const app = resolve(import.meta.dirname, '../..')
const resources = join(app, 'resources/crew-managed')
const sha = value => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(readFileSync(join(resources, 'manifest.json'), 'utf8'))
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? files(join(directory, entry.name)) : [join(directory, entry.name)])

test('shipping managed Crew resources are complete, hash checked and carry upstream notices', () => {
  const entries = files(resources).map(path => path.slice(app.length + 1).replaceAll('\\', '/'))
  verifyCrewManagedPackage({ entries,
    readPackaged: path => readFileSync(join(app, path)),
    readUnpacked: path => readFileSync(join(app, path)),
    readSource: path => readFileSync(join(app, path)) })
  for (const entry of manifest.files) assert.equal(sha(readFileSync(join(resources, entry.path))), entry.sha256)
  assert.match(readFileSync(join(resources, 'LICENSE.KiroCrew'), 'utf8'), /Apache License/)
  assert.match(readFileSync(join(resources, 'NOTICE.KiroCrew'), 'utf8'), /Copyright Amazon/)
  for (const path of files(resources)) {
    const content = readFileSync(path, 'utf8')
    assert.doesNotMatch(content, /[A-Za-z]:\\Users\\|\.local\/private-docs|auto-only-live|SYNTHETIC_ACCESS_NEVER_REAL/)
  }
})

const python = ['python3', 'python'].find(executable => spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0)
test('real launcher rejects wrong owners and linked roots and keeps status/stop read-only', { skip: !python }, () => {
  const code = String.raw`
import importlib.util,json,os,sys,tempfile,pathlib,uuid,contextlib
p=pathlib.Path(sys.argv[1]);s=importlib.util.spec_from_file_location('launcher',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
owner=str(uuid.uuid4());session=str(uuid.uuid4())
with tempfile.TemporaryDirectory(prefix='crew-owned-test-') as tmp:
 root=pathlib.Path(tmp).resolve()/'managed-crew/workspace-v1';root.mkdir(parents=True)
 (root/m.MARKER).write_text(json.dumps({'schemaVersion':1,'ownerId':owner}))
 c=m.context(str(root),owner,session)
 assert m.status(c)=={'type':'state','running':False,'ownerId':owner}
 m.shutdown(c,123,456)
 assert set(x.name for x in root.iterdir())=={m.MARKER}
 for invalid in [str(uuid.uuid4()),'not-a-uuid']:
  try:m.context(str(root),invalid,session)
  except m.ManagedCrewError:pass
  else:raise AssertionError('invalid owner accepted')
 bad=pathlib.Path(tmp)/'.kiro/managed-crew/workspace-v1';bad.mkdir(parents=True)
 (bad/m.MARKER).write_text(json.dumps({'schemaVersion':1,'ownerId':owner}))
 try:m.context(str(bad),owner,session)
 except m.ManagedCrewError:pass
 else:raise AssertionError('default-client subtree accepted')
 linked=pathlib.Path(tmp)/'other/managed-crew/workspace-v1';linked.parent.mkdir(parents=True)
 try:linked.symlink_to(root,target_is_directory=True)
 except OSError:pass
 else:
  try:m.context(str(linked),owner,session)
  except m.ManagedCrewError:pass
  else:raise AssertionError('linked workspace accepted')
 os.environ['AWS_SECRET_ACCESS_KEY']='forbidden';os.environ['KIRO_API_KEY']='forbidden';os.environ['OPENAI_API_KEY']='forbidden'
 m.configure_environment(c,create=True)
 assert all(k not in os.environ for k in ['AWS_SECRET_ACCESS_KEY','KIRO_API_KEY','OPENAI_API_KEY'])
 for k in ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','KIRO_HOME','KIROCREW_HOME','KIROCREW_OS_HOME','TEMP','TMP','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE']:
  assert pathlib.Path(os.environ[k]).is_relative_to(root),k
 os.chdir(p.parent)
print('launcher boundaries passed')
`
  const result = execFileSync(python, ['-I', '-B', '-c', code, join(resources, 'launcher.py')], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  assert.match(result, /launcher boundaries passed/)
})

test('control output never forwards arbitrary official stdout or credential-like lines', { skip: !python }, () => {
  const code = String.raw`
import importlib.util,sys,json
s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
received=[];sink=m.ReadyOutput(received.append)
sink.write('private token: NEVER_FORWARD\n');sink.write('KIROCREW_');sink.write('READY:{"safe":true}\n')
assert received==['{"safe":true}'];sink.write('x'*70000);assert sink.pending==''
print('control output passed')
`
  assert.match(execFileSync(python, ['-I', '-B', '-c', code, join(resources, 'launcher.py')], { encoding: 'utf8', windowsHide: true, timeout: 20000 }), /control output passed/)
})

test('parent control input leaves native standard input unblocked and is not inherited by children', { skip: !python || process.platform !== 'win32' }, () => {
  const code = String.raw`
import sys,subprocess,threading,queue,json
child_code=r'''
import importlib.util,sys,os,threading,json,subprocess
s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.contain_process_tree()
stream=m.detach_control_input()
assert stream.fileno()!=0 and not os.get_inheritable(stream.fileno())
received=[]
t=threading.Thread(target=lambda:received.append(stream.readline().strip()),daemon=True);t.start()
# Native DLL initialization may inspect CRT fd 0 while the control reader waits.
os.fstat(0)
if sys.argv[2]=='numpy':
 import numpy
result=subprocess.run([sys.executable,'-I','-B','-c','import sys; assert sys.stdin.read()==""'],stdin=None,capture_output=True,timeout=5,creationflags=subprocess.CREATE_NO_WINDOW)
assert result.returncode==0
print('native-input-ready',flush=True)
t.join(10)
assert received==['stop']
print('control-stop-received',flush=True)
os._exit(0)
'''
p=subprocess.Popen([sys.executable,'-I','-B','-c',child_code,sys.argv[1],sys.argv[2]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
lines=queue.Queue()
threading.Thread(target=lambda:lines.put(p.stdout.readline().strip()),daemon=True).start()
try:
 assert lines.get(timeout=10)=='native-input-ready'
 p.stdin.write('stop\n');p.stdin.flush();p.stdin.close()
 p.wait(timeout=10)
 assert p.returncode==0,p.stderr.read()
 assert p.stdout.read().strip()=='control-stop-received'
finally:
 if p.poll() is None:p.kill();p.wait(timeout=5)
print('isolated parent control passed')
`
  const executable = process.env.KIRO_CREW_TEST_PYTHON || python
  const result = execFileSync(executable, ['-I', '-B', '-c', code, join(resources, 'launcher.py'),
    process.env.KIRO_CREW_TEST_PYTHON ? 'numpy' : 'native'], { encoding: 'utf8', windowsHide: true, timeout: 25000 })
  assert.match(result, /isolated parent control passed/)
})

test('official faulthandler accepts the quiet stream without exposing its stack output', { skip: !python }, () => {
  const script = String.raw`
import importlib.util,sys,faulthandler,os
s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
sink=m.QuietOutput()
assert sink.encoding=='utf-8' and not sink.isatty()
assert sink.fileno() not in (sys.stdout.fileno(),sys.stderr.fileno())
faulthandler.enable(file=sink)
faulthandler.dump_traceback(file=sink)
faulthandler.disable()
sink.write('SYNTHETIC_PRIVATE_ERROR')
os.write(sink.fileno(),b'SYNTHETIC_PRIVATE_NATIVE_ERROR')
print('quiet descriptor supported')
`
  const result = spawnSync(python, ['-I', '-B', '-c', script, join(resources, 'launcher.py')],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'quiet descriptor supported')
  assert.equal(result.stderr, '')
})

test('managed Windows Job closes its actual child process when startup host exits', { skip: !python || process.platform !== 'win32' }, () => {
  const child = String.raw`
import importlib.util,sys,subprocess,os
s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.contain_process_tree()
p=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(120)'],creationflags=subprocess.CREATE_NO_WINDOW)
print(p.pid,flush=True)
os._exit(0)
`
  const pid = Number(execFileSync(python, ['-I', '-B', '-c', child, join(resources, 'launcher.py')],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim())
  assert.ok(Number.isInteger(pid) && pid > 0)
  const check = String.raw`
import importlib.util,sys,time
s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for _ in range(50):
 if m.process_identity(int(sys.argv[2])) is None:break
 time.sleep(.1)
else:raise AssertionError('owned descendant survived job close')
print('owned job closed')
`
  assert.match(execFileSync(python, ['-I', '-B', '-c', check, join(resources, 'launcher.py'), String(pid)],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }), /owned job closed/)
})

test('locked startup is never exposed as idle and a verified starting session can be stopped', { skip: !python || process.platform !== 'win32' }, () => {
  const script = String.raw`
import importlib.util,sys,tempfile,pathlib,json,uuid,os,subprocess,time
p=pathlib.Path(sys.argv[1]);s=importlib.util.spec_from_file_location('launcher',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
owner=str(uuid.uuid4());session=str(uuid.uuid4())
with tempfile.TemporaryDirectory(prefix='crew-start-state-') as tmp:
 root=pathlib.Path(tmp).resolve()/'managed-crew/workspace-v1';root.mkdir(parents=True);(root/m.MARKER).write_text(json.dumps({'schemaVersion':1,'ownerId':owner}))
 c=m.context(str(root),owner,session)
 with m.launch_lock(c):
  try:m.status(c)
  except m.ManagedCrewError as e:assert str(e)=='workspace-starting'
  else:raise AssertionError('launch lock hidden')
 code="import importlib.util,sys,os,time; s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);c=m.context(sys.argv[2],sys.argv[3],sys.argv[4]);m.contain_process_tree();m.write_runtime(c,os.getpid(),0,'starting');print('ready',flush=True);time.sleep(120)"
 child=subprocess.Popen([sys.executable,'-I','-B','-c',code,str(p),str(root),owner,session],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  assert child.stdout.readline().strip()=='ready'
  state=m.status(c);assert state['running'] and state['starting'] and state['port']==0
  m.shutdown(c,child.pid,0);child.wait(timeout=10)
  assert m.status(c)['running'] is False
 finally:
  if child.poll() is None:child.kill();child.wait(timeout=10)
print('startup state protected')
`
  assert.match(execFileSync(python, ['-I', '-B', '-c', script, join(resources, 'launcher.py')],
    { encoding: 'utf8', windowsHide: true, timeout: 25000 }), /startup state protected/)
})

test('real serve EOF during slow startup closes its own job before any Gateway starts', { skip: !python || process.platform !== 'win32' }, () => {
  const script = String.raw`
import importlib.util,sys,tempfile,pathlib,json,uuid,subprocess,time
p=pathlib.Path(sys.argv[1]);s=importlib.util.spec_from_file_location('launcher',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
owner=str(uuid.uuid4());session=str(uuid.uuid4())
code=r'''
import importlib.util,sys,types,subprocess,time,pathlib
s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ctx=m.context(sys.argv[2],sys.argv[3],sys.argv[4])
m.configure_environment=lambda *a,**kw:None
fake=types.ModuleType('kiro_crew');fake.__path__=[];sys.modules['kiro_crew']=fake
ssl=types.ModuleType('kiro_crew._ssl_compat')
def slow():
 child=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(120)'],creationflags=subprocess.CREATE_NO_WINDOW)
 (ctx['root']/'child-pid').write_text(str(child.pid))
 time.sleep(120)
ssl._ensure_ssl_certs=slow;sys.modules[ssl.__name__]=ssl
m.serve(ctx)
'''
with tempfile.TemporaryDirectory(prefix='crew-eof-start-') as tmp:
 root=pathlib.Path(tmp).resolve()/'managed-crew/workspace-v1';root.mkdir(parents=True);(root/m.MARKER).write_text(json.dumps({'schemaVersion':1,'ownerId':owner}))
 child=subprocess.Popen([sys.executable,'-I','-B','-c',code,str(p),str(root),owner,session],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
 try:
  for _ in range(100):
   if (root/'child-pid').exists():break
   if child.poll() is not None:raise AssertionError('startup process failed')
   time.sleep(.05)
  descendant=int((root/'child-pid').read_text())
  assert m.status(m.context(str(root),owner,session))['starting'] is True
  child.stdin.close();child.wait(timeout=10)
  assert child.returncode==0
  assert json.loads(child.stdout.read())['type']=='stopped'
  for _ in range(50):
   if m.process_identity(descendant) is None:break
   time.sleep(.1)
  else:raise AssertionError('startup descendant survived EOF')
 finally:
  if child.poll() is None:child.kill();child.wait(timeout=10)
print('startup EOF contained')
`
  assert.match(execFileSync(python, ['-I', '-B', '-c', script, join(resources, 'launcher.py')],
    { encoding: 'utf8', windowsHide: true, timeout: 25000 }), /startup EOF contained/)
})

test('listener guard accepts only this process and its exact loopback port', { skip: !python || process.platform !== 'win32' }, () => {
  const script = String.raw`
import importlib.util,sys,socket,os
s=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with socket.socket() as listener:
 listener.bind(('127.0.0.1',0));listener.listen();port=listener.getsockname()[1]
 assert m.listener_owned(os.getpid(),port)
 assert not m.listener_owned(os.getpid()+1,port)
 assert not m.listener_owned(os.getpid(),0)
print('listener bound to owner')
`
  assert.match(execFileSync(python, ['-I', '-B', '-c', script, join(resources, 'launcher.py')],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }), /listener bound to owner/)
})

test('packaged patch executes official Crew catalog paths and gateway notifications with synthetic identities',
  { skip: !process.env.KIRO_CREW_TEST_PYTHON }, () => {
    const result = spawnSync(process.env.KIRO_CREW_TEST_PYTHON, ['-I', '-B', join(import.meta.dirname, 'crewManagedBackend.py')],
      { encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /Ran 19 tests/)
    assert.match(result.stderr, /OK/)
  })

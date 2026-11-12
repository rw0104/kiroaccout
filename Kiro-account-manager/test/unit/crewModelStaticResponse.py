"""Exercise the official static HTTP response with a synthetic request/writer."""
import ast
import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
import json
import mimetypes
import os
from pathlib import Path
from stat import S_ISREG
import sys
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
source = (HERE.parent / 'fixtures/crew-model-repair/0.12.0/dist_file_response.py').read_text(encoding='utf8')
names = {'_open_variant', '_conditional_status', '_selected_range', '_guess_type', 'DistFileResponse'}
nodes = [node for node in ast.parse(source).body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name in names]
assert {node.name for node in nodes} == names
tree = ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*nodes],type_ignores=[])
class StreamResponse:
    def __init__(self, status=200): self.status=status; self.prepared=False; self.headers={}; self.body=bytearray()
    def set_status(self,value): self.status=value
    def force_close(self): raise AssertionError('Unexpected truncated response')
    async def prepare(self, _request): self.prepared=True; return self
    async def write(self,chunk): self.body.extend(chunk)
    async def write_eof(self): pass

pool=ThreadPoolExecutor(max_workers=2)
hdrs=SimpleNamespace(**{name:name for name in ['ACCEPT_ENCODING','ETAG','LAST_MODIFIED','CONTENT_RANGE','CONTENT_TYPE','CONTENT_ENCODING','VARY','ACCEPT_RANGES','METH_HEAD']})
namespace=dict(web=SimpleNamespace(StreamResponse=StreamResponse,Request=object),asyncio=asyncio,Path=Path,os=os,S_ISREG=S_ISREG,formatdate=formatdate,
    hdrs=hdrs,_ENCODED_SIBLINGS=(('br','.br'),('gzip','.gz')),static_asset_executor=lambda:pool,_log_unopenable=lambda *_:None,
    _close_later=lambda stream:stream.close(),is_not_modified=lambda *_a,**_kw:False,cast=lambda _type,value:value,
    _AIOHTTP_CONTENT_TYPES=None,mimetypes=mimetypes,_FALLBACK_CONTENT_TYPE='application/octet-stream',_CHUNK_SIZE=65536)
exec(compile(ast.fix_missing_locations(tree),'<official-static-http-response>','exec'),namespace)
async def run():
    result=[]
    for encoding in ['br, gzip','gzip','identity']:
        response=namespace['DistFileResponse'](Path(sys.argv[1])/'static/dist/assets/useWebSocket-DK9hitwq.js')
        request=SimpleNamespace(headers={hdrs.ACCEPT_ENCODING:encoding},if_match=None,if_unmodified_since=None,if_range=None,http_range=slice(None),method='GET')
        await response.prepare(request)
        assert response.status==200
        result.append({'requested':encoding,'encoding':response.headers.get(hdrs.CONTENT_ENCODING),'length':response.content_length,'body':base64.b64encode(response.body).decode()})
    return result
try: print(json.dumps(asyncio.run(run())))
finally: pool.shutdown()

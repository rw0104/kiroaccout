"""Evaluate the real health/version handlers with synthetic request identity."""
import ast
import asyncio
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

source=(Path(sys.argv[1])/'dashboard/handlers/core.py').read_text(encoding='utf8')
names={'_liveness_payload','api_health','api_version','api_live'}
nodes=[node for node in ast.parse(source).body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name in names]
assert {node.name for node in nodes}==names
tree=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),*nodes],type_ignores=[])
watchdog=ModuleType('kiro_crew.dashboard.loop_watchdog')
watchdog.LoopStallWatchdog=type('SyntheticWatchdog',(),{})
sys.modules[watchdog.__name__]=watchdog
scope=dict(asyncio=asyncio,web=SimpleNamespace(json_response=lambda data:data),kiro_crew=SimpleNamespace(__version__='0.12.0'),
    is_direct_local_request=lambda request:request.direct,check_host=lambda request:request.host_allowed,gateway_id=lambda:'SYNTHETIC_GATEWAY_ID')
exec(compile(ast.fix_missing_locations(tree),'<official-health-version-handlers>','exec'),scope)
async def run():
    local=SimpleNamespace(direct=True,host_allowed=True,app={})
    remote=SimpleNamespace(direct=False,host_allowed=True,app={})
    rebound=SimpleNamespace(direct=True,host_allowed=False,app={})
    return {'local':await scope['api_health'](local),'remote':await scope['api_health'](remote),
        'rebound':await scope['api_health'](rebound),'apiVersion':await scope['api_version'](local),
        'live':await scope['api_live'](local),'moduleVersion':scope['kiro_crew'].__version__}
print(json.dumps(asyncio.run(run())))

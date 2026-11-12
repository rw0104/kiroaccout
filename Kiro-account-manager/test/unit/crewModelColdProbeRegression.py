"""Keep the actual cold-probe handle alive until delayed metadata is captured."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from types import ModuleType, SimpleNamespace
import unittest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('catalog_regression',HERE/'crewModelCatalogRegression.py')
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

class ColdProbe(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h=base.Harness()
        agent_sdk=ModuleType('kiro_crew.agent_sdk')
        agent_sdk.__path__=[]
        agent_sdk.kas_model_catalog=self.h.catalog
        sys.modules[agent_sdk.__name__]=agent_sdk
        self.probe=ModuleType('native_cold_probe')
        probe_source=(base.FIXTURE/'src/kiro_crew/dashboard/handlers/models_cold_probe.py').read_text(encoding='utf8') if os.environ.get('CREW_COLD_PROBE_BASELINE')=='1' else self.h.read('src/kiro_crew/dashboard/handlers/models_cold_probe.py')
        exec(compile(probe_source,'<official-cold-probe>','exec'),self.probe.__dict__)
        self.probe.logger=base.logger
        self.probe.COLD_CATALOG_WAIT_SECS=.5
        self.tasks=[]
        self.broadcast=[]
        self.alive=True
        self.destroyed=0
        self.delivered=0
        self.drains=0
        self.handle=self.h.handle()
        self.handle._queue=asyncio.Queue()
        self.handle._mcp_report=SimpleNamespace(record_frame=lambda *_a,**_kw:None)
        self.handle._owns_mcp_frame=lambda _:True
        self.handle._apply_init_notification=lambda message,action:self.h.mcp['_apply_init_notification'](self.handle,message,action)
        self.drain=base.extract(self.h.read('src/kiro_crew/acp/session_handle_mcp.py'),['drain_init'],
            dict(asyncio=asyncio,time=time,logger=base.logger,classify_notification=lambda _: 'update',
                _MCP_DRAIN_DURATION=.16,_MCP_DRAIN_IDLE_EXIT=.01,_MCP_DRAIN_NO_REPORT_CEILING=.16,_MCP_DRAIN_REPORT_ACTIONS=set()))['drain_init']
        async def drain(**options):
            self.drains+=1
            await self.drain(self.handle,**options)
        async def destroy():
            self.alive=False
            self.destroyed+=1
        self.handle.drain_init=drain
        self.handle.destroy=destroy
        async def get(): return self.handle
        self.state=SimpleNamespace(sessions=SimpleNamespace(get_bg_session=get),broadcast_ws=lambda *args:self.broadcast.append(args))
    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done(): task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)
        await self.h.settle()
        self.h.unsubscribe()
    async def late(self,count=22,delay=.02):
        async def deliver():
            await asyncio.sleep(delay)
            if self.alive:
                self.delivered+=1
                await self.handle._queue.put(base.frame(base.config(count)))
        task=asyncio.create_task(deliver()); self.tasks.append(task)
        return task
    async def test_late_metadata_after_session_new_reaches_menu_before_destroy(self):
        self.h.selection['store_session_config'](self.handle,{})
        delivery=await self.late()
        await self.probe._probe(self.state)
        await delivery; await self.h.settle()
        self.assertEqual(await self.h.count(),22)
        self.assertEqual(self.delivered,1)
        self.assertEqual(self.destroyed,1)
        self.assertEqual(len(self.h.catalog._listeners),1,'probe subscription was removed')
        self.assertEqual(self.broadcast,[('models_changed',{})])
    async def test_initial_auto_does_not_end_probe_before_late_complete_list(self):
        self.h.selection['store_session_config'](self.handle,{'configOptions':base.config(1)})
        await self.h.settle()
        delivery=await self.late()
        await self.probe._probe(self.state)
        await delivery; await self.h.settle()
        self.assertEqual(await self.h.count(),22)
        self.assertEqual(self.destroyed,1)
        self.assertEqual(self.broadcast,[('models_changed',{})])
    async def test_initial_complete_catalog_finishes_without_an_extra_drain(self):
        self.h.selection['store_session_config'](self.handle,{'configOptions':base.config(22)})
        await self.h.settle()
        await self.probe._probe(self.state)
        self.assertEqual(await self.h.count(),22)
        self.assertEqual(self.drains,0)
        self.assertEqual(self.destroyed,1)
    async def test_real_auto_only_times_out_without_inventing_a_model_or_leaking_listener(self):
        self.h.selection['store_session_config'](self.handle,{'configOptions':base.config(1)})
        await self.h.settle()
        await asyncio.wait_for(self.probe._probe(self.state),3)
        self.assertEqual(await self.h.count(),1)
        self.assertEqual(self.destroyed,1)
        self.assertEqual(len(self.h.catalog._listeners),1)
        self.assertEqual(self.broadcast,[])
    async def test_cancelled_probe_stops_drain_unsubscribes_and_destroys(self):
        running=asyncio.create_task(self.probe._probe(self.state))
        await asyncio.sleep(.02)
        running.cancel()
        with self.assertRaises(asyncio.CancelledError): await running
        self.assertEqual(self.destroyed,1)
        self.assertEqual(len(self.h.catalog._listeners),1)
        self.assertEqual(self.broadcast,[])
    async def test_identity_switch_does_not_accept_another_accounts_catalog(self):
        running=asyncio.create_task(self.probe._probe(self.state))
        await asyncio.sleep(.02)
        self.h.vault='synthetic-b'
        await self.h.deliver('live',base.config(22),self.h.handle('synthetic-b'))
        await running
        self.assertEqual(self.destroyed,1)
        self.assertEqual(len(self.h.catalog._listeners),1)
        self.assertEqual(self.broadcast,[])
        self.assertIsNone(self.h.catalog.recorded_catalog_snapshot('synthetic-a'))
    async def test_failed_drain_is_destroyed_without_fabricated_completion(self):
        async def failed(**_options): raise RuntimeError('SYNTHETIC_METADATA_FAILURE')
        self.handle.drain_init=failed
        await self.probe._probe(self.state)
        self.assertEqual(self.destroyed,1)
        self.assertEqual(len(self.h.catalog._listeners),1)
        self.assertEqual(self.broadcast,[])
    async def test_non_kas_probe_retains_original_teardown_without_catalog_subscription(self):
        self.handle._runtime.acp_backend='synthetic-other'
        await self.probe._probe(self.state)
        self.assertEqual(self.drains,0)
        self.assertEqual(self.destroyed,1)
        self.assertEqual(len(self.h.catalog._listeners),1)
        self.assertEqual(self.broadcast,[('models_changed',{})])

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ColdProbe))
    print(json.dumps({'successful':result.wasSuccessful(),'testsRun':result.testsRun,'realInferenceRequests':0,'realCredentialsRead':0}))
    sys.exit(0 if result.wasSuccessful() else 1)

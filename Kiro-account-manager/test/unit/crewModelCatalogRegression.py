"""Run original/patched official Python entrypoints with synthetic IO only."""
import ast
import asyncio
import json
import logging
from pathlib import Path
import sys
import threading
from types import ModuleType, SimpleNamespace
import unittest

HERE = Path(__file__).resolve().parent
APP = HERE.parents[1]
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--version', choices=['0.12.0','0.12.2'], default='0.12.2')
parser.add_argument('--installed-root')
args=parser.parse_args()
VERSION=args.version
FIXTURE=HERE.parent / 'fixtures/crew-model-repair' / VERSION
PATCHED=Path(args.installed_root) if args.installed_root else APP / 'resources/crew-model-repair' / VERSION
EXPECTED_EVENT=('models_changed',{}) if VERSION=='0.12.2' else ('models_catalog_changed',{'backend':'kas'})
logger = logging.getLogger("native-crew-offline")
logger.disabled = True

def extract(text, names, ns):
    nodes = [n for n in ast.parse(text).body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    assert {n.name for n in nodes} == set(names)
    tree = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
    exec(compile(ast.fix_missing_locations(tree), "<official-selected-functions>", "exec"), ns)
    return ns

def config(count=22, label="SYNTHETIC_MODEL", current="auto", rate=1):
    return [{"id":"model", "type":"select", "currentValue":current,
        "options":[{"value":"auto", "name":"Auto"}] + [
            {"value":f"{label}_{i}", "name":f"Synthetic {i}", "_meta":{"kiro":{"rateMultiplier":rate}}} for i in range(1,count)]}]

def frame(cfg, session="synthetic-session"):
    return SimpleNamespace(params={"sessionId":session,"update":{"sessionUpdate":"config_option_update", "configOptions":cfg}})

class Harness:
    def __init__(self, patched=True):
        self.patched = patched
        self.vault = "synthetic-a"
        self.notifications = []
        self.registry = SimpleNamespace(ADVERTISED_MODEL_ID_MAX_CHARS=1024, ADVERTISED_MODELS_MAX_IDS=500,
            model_window=lambda *_:None, REFERENCE_WINDOW_TOKENS=200000, refresh_kiro_catalog=lambda *_:(False,False))
        pkg = ModuleType("kiro_crew")
        pkg.__path__ = []
        pkg.model_registry = self.registry
        sys.modules[pkg.__name__] = pkg
        backends = ModuleType("kiro_crew.agent_sdk.backends")
        backends.ACP_BACKEND_KAS = "kas"
        sys.modules[backends.__name__] = backends
        self.catalog = ModuleType("kiro_crew.agent_sdk.kas_model_catalog")
        sys.modules[self.catalog.__name__] = self.catalog
        exec(compile(self.read("src/kiro_crew/agent_sdk/kas_model_catalog.py"), "<official-catalog>", "exec"), self.catalog.__dict__)
        self.catalog.vault_identity = lambda:self.vault
        self.catalog.logger = logger
        text = self.read("src/kiro_crew/acp/session_handle_model_selection.py")
        names = ["_select_options", "_crew_agent_name", "set_config_option", "store_session_config"]
        if patched: names.append("apply_config_options")
        self.selection = extract(text, names, dict(ACP_BACKEND_KAS="kas", METHOD_SET_CONFIG_OPTION="session/set_config_option",
            schedule_catalog=getattr(self.catalog,"schedule_catalog",None), record_catalog=self.catalog.record_catalog,
            model_select_envelope=lambda _:None, session_models_envelope=lambda *_:None))
        select_module = ModuleType("kiro_crew.acp.session_handle_model_selection")
        select_module._select_options = self.selection["_select_options"]
        if patched: select_module.apply_config_options = self.selection["apply_config_options"]
        sys.modules[select_module.__name__] = select_module
        values = dict(apply_config_options=self.selection.get("apply_config_options"), logger=logger)
        self.updates = extract(self.read("src/kiro_crew/acp/session_handle_updates.py"), ["_handle_update"], values.copy())
        self.mcp = extract(self.read("src/kiro_crew/acp/session_handle_mcp.py"), ["_apply_init_notification"], values.copy())
        if patched: self.unsubscribe = self.catalog.subscribe_catalog_changes(self.notifications.append)
        else: self.unsubscribe = lambda:None
        cold = ModuleType("kiro_crew.dashboard.handlers.models_cold_probe")
        cold.start_cold_model_probe = lambda *_:False
        sys.modules[cold.__name__] = cold
        self.handler = extract((FIXTURE / "models_kas_bundle.py").read_text(encoding="utf8"),
            ["_picker_row","_cold_response","api_models_kas_bundle"], dict(asyncio=asyncio,
            web=SimpleNamespace(json_response=lambda body,status=200:dict(status=status,body=body)),
            _bundle_installed=lambda:True, _engine_installable_here=lambda:True, _vault_signed_in=lambda:True,
            kas_model_catalog=self.catalog, model_registry=self.registry, model_registry_namespace=lambda _:"acp", ACP_BACKEND_KAS="kas"))

    def read(self,path):
        directory = PATCHED if self.patched else FIXTURE / "src/kiro_crew"
        return (directory / path.removeprefix("src/kiro_crew/")).read_text(encoding="utf-8")

    def handle(self, identity="synthetic-a", backend="kas"):
        h = SimpleNamespace(_session_id="synthetic-session",_runtime=SimpleNamespace(acp_backend=backend),
            request_vault_identity=identity,_config_options=[],_sync_effort_levels=lambda:None,
            _resolved_model_id="",_available_models=[],_note_mcp_sign_in_status=lambda *_a,**_kw:None)
        h._crew_agent_name = lambda value:self.selection["_crew_agent_name"](h,value)
        return h

    async def settle(self):
        if self.patched: await self.catalog.wait_for_catalog_updates()

    async def count(self):
        result = await self.handler["api_models_kas_bundle"](SimpleNamespace(app={"state":None}))
        assert result["status"] == 200
        return len(result["body"])

    def snapshot(self): return self.catalog.recorded_catalog_snapshot(self.vault)

    async def deliver(self, route, cfg, h=None):
        h = h or self.handle()
        if route == "initial": self.selection["store_session_config"](h,{"configOptions":cfg})
        elif route == "live": self.updates["_handle_update"](h,frame(cfg))
        elif route == "init": self.mcp["_apply_init_notification"](h,frame(cfg),"update")
        elif route == "response":
            async def send(*_a,**_kw): return 1
            async def wait(*_a,**_kw): return SimpleNamespace(result={"configOptions":cfg})
            h._send_awaited, h._wait_for_response = send, wait
            await self.selection["set_config_option"](h,"model","SYNTHETIC_MODEL_1")
        await self.settle()
        return h

class Regressions(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self): self.h = Harness()
    async def asyncTearDown(self):
        await self.h.settle()
        self.h.unsubscribe()

    async def test_all_four_real_entrypoints_publish_complete_catalog(self):
        for route in ("initial","live","init","response"):
            await self.h.deliver(route,config(22, label=route))
            self.assertEqual(await self.h.count(),22)
            self.assertEqual(self.h.snapshot()[1]["model_name"],f"{route}_1")

    async def test_auto_then_late_select_recovers_without_new_workspace(self):
        handle = await self.h.deliver("initial",config(1))
        self.assertEqual(await self.h.count(),1)
        await self.h.deliver("live",config(22),handle)
        self.assertEqual(await self.h.count(),22)

    async def test_empty_or_unrelated_frames_keep_last_valid_catalog(self):
        handle = await self.h.deliver("live",config())
        for cfg in ([],None,{},[{"id":"effort","type":"select","options":[]}],config(0)[:0]):
            await self.h.deliver("live",cfg,handle)
        self.assertEqual(await self.h.count(),22)
        self.assertEqual(self.h.notifications,["kas"])

    async def test_duplicates_and_current_or_effort_changes_do_not_notify(self):
        handle = await self.h.deliver("live",config())
        await self.h.deliver("live",config(current="SYNTHETIC_MODEL_1") + [{"id":"effort","value":"high"}],handle)
        self.assertEqual(self.h.notifications,["kas"])
        await self.h.deliver("live",config(rate=2),handle)
        self.assertEqual(self.h.notifications,["kas","kas"])

    async def test_authoritative_auto_only_is_not_fabricated_into_other_models(self):
        await self.h.deliver("initial",config())
        await self.h.deliver("live",config(1))
        self.assertEqual(await self.h.count(),1)

    async def test_unknown_identity_and_non_kas_are_not_recorded(self):
        for identity,backend in [("","kas"),("synthetic-a","codex"),("synthetic-a","kiro")]:
            await self.h.deliver("initial",config(),self.h.handle(identity,backend))
        self.assertIsNone(self.h.snapshot())
        self.assertEqual(self.h.notifications,[])

    async def test_old_account_frames_do_not_replace_new_account_catalog(self):
        self.h.vault = "synthetic-b"
        await self.h.deliver("initial",config(label="B"),self.h.handle("synthetic-b"))
        await self.h.deliver("live",config(label="A"),self.h.handle())
        self.assertEqual(self.h.snapshot()[1]["model_name"],"B_1")
        self.assertIsNone(self.h.catalog.recorded_catalog_snapshot("synthetic-a"))
        self.assertEqual(self.h.notifications,["kas"])

    async def test_foreign_or_missing_session_stamp_cannot_publish_init_catalog(self):
        for sid in ("synthetic-child",""):
            self.h.mcp["_apply_init_notification"](self.h.handle(),frame(config(),sid),"update")
        await self.h.settle()
        self.assertIsNone(self.h.snapshot())

    async def test_delayed_old_identity_read_does_not_undo_newer_publication(self):
        entered,release=threading.Event(),threading.Event()
        calls=0
        def identity():
            nonlocal calls
            calls+=1
            if calls==1:
                entered.set(); release.wait(2); return "synthetic-a"
            return "synthetic-b"
        self.h.catalog.vault_identity=identity
        self.h.updates["_handle_update"](self.h.handle(),frame(config(label="A")))
        self.assertTrue(await asyncio.to_thread(entered.wait,1))
        self.h.updates["_handle_update"](self.h.handle("synthetic-b"),frame(config(label="B")))
        for _ in range(100):
            if self.h.catalog.recorded_catalog_snapshot("synthetic-b"): break
            await asyncio.sleep(.002)
        release.set()
        await self.h.settle()
        self.assertEqual(self.h.catalog.recorded_catalog_snapshot("synthetic-b")[1]["model_name"],"B_1")

    async def test_burst_is_bounded_and_latest_rows_win(self):
        entered,release=threading.Event(),threading.Event()
        def identity(): entered.set(); release.wait(2); return "synthetic-a"
        self.h.catalog.vault_identity=identity
        handle=self.h.handle()
        for i in range(200): self.h.updates["_handle_update"](handle,frame(config(2,label=f"S{i}")))
        self.assertEqual(len(self.h.catalog._tasks),1)
        release.set()
        await self.h.settle()
        self.assertEqual(self.h.snapshot()[1]["model_name"],"S199_1")

    async def test_existing_frontend_event_is_coalesced_and_disposed(self):
        ns={"asyncio":asyncio,"subscribe_catalog_changes":self.h.catalog.subscribe_catalog_changes,"_APP_KEY":"test"}
        extract(self.h.read("src/kiro_crew/dashboard/server_runtime/model_catalog_events.py"),["wire_model_catalog_events"],ns)
        class App(dict):
            def __init__(self): super().__init__(); self.on_cleanup=[]
        app=App(); events=[]
        state=SimpleNamespace(broadcast_ws=lambda event,data:events.append((event,data)))
        ns["wire_model_catalog_events"](app,state); ns["wire_model_catalog_events"](app,state)
        await self.h.deliver("live",config(2))
        await self.h.deliver("live",config(3))
        await asyncio.sleep(.08)
        self.assertEqual(events,[EXPECTED_EVENT])
        self.assertEqual(len(app.on_cleanup),1)
        await app.on_cleanup[0](app)
        await self.h.deliver("live",config(4))
        await asyncio.sleep(.08)
        self.assertEqual(events,[EXPECTED_EVENT])

async def comparison():
    results=[]
    for patched in (False,True):
        for route in ("initial","live","init","response"):
            h=Harness(patched)
            before=await h.count()
            handle=h.handle()
            if route!="initial": h.selection["store_session_config"](handle,{})
            await h.deliver(route,config(22),handle)
            after=await h.count()
            assert before==1
            assert after==(22 if patched or route=="initial" else 1)
            results.append({"patched":patched,"route":route,"beforeCount":before,"afterCount":after})
            h.unsubscribe()
    return results

if __name__=="__main__":
    before_after=asyncio.run(comparison())
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Regressions))
    report={"upstreamTag":"v"+VERSION,
        "method":"Original and patched Python functions executed with synthetic storage/network/session dependencies",
        "realClientsStarted":0,"realCredentialsRead":0,"networkRequests":0,"syntheticModelCount":22,
        "beforeAfter":before_after,"testsRun":result.testsRun,"failures":len(result.failures),"errors":len(result.errors),"successful":result.wasSuccessful()}
    print(json.dumps(report,indent=2))
    sys.exit(0 if result.wasSuccessful() else 1)

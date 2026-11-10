"""Real installed Crew function regression, all auth/IO mocked and home isolated."""
import asyncio
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
BASELINE = False
SANDBOX = tempfile.TemporaryDirectory(prefix="crew-managed-functions-")
for key in tuple(os.environ):
    if key.startswith(("KIRO", "AWS_", "AMAZON_Q")):
        os.environ.pop(key, None)
for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "KIROCREW_HOME", "KIRO_HOME", "TEMP", "TMP"):
    os.environ[key] = SANDBOX.name
from kiro_crew._ssl_compat import _ensure_ssl_certs
_ensure_ssl_certs()
spec = importlib.util.spec_from_file_location("managed_overlay", ROOT / "resources/crew-managed/overlay.py")
overlay = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = overlay
spec.loader.exec_module(overlay)
overlay.install()

from kiro_crew.agent_sdk import kas_model_catalog as catalog
from kiro_crew.acp.session_handle import AcpSessionHandle
from kiro_crew.acp.types import JsonRpcMessage
from kiro_crew.dashboard.handlers import models_kas_bundle as handler

def config(extra="synthetic-a", *, current="auto", rate=1):
    return [{"id": "model", "type": "select", "currentValue": current, "options": [
        {"value": "auto", "name": "Auto"}, {"value": extra, "name": "Synthetic", "_meta": {"kiro": {"rateMultiplier": rate}}}]}]

def frame(cfg, session="synthetic-session"):
    return JsonRpcMessage.from_dict({"method": "session/update", "params": {
        "sessionId": session, "update": {"sessionUpdate": "config_option_update", "configOptions": cfg}}})

async def settled():
    if hasattr(catalog, "wait_for_catalog_updates"):
        await catalog.wait_for_catalog_updates()

class CatalogTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.vault = "synthetic-identity-a"
        self.identity_patch = patch.object(catalog, "vault_identity", lambda: self.vault)
        self.identity_patch.start()
        catalog._recorded = None
        catalog._recorded_identity = ""
        self.events = []
        self.unsubscribe = catalog.subscribe_catalog_changes(self.events.append) if hasattr(catalog, "subscribe_catalog_changes") else lambda: None

    async def asyncTearDown(self):
        await settled()
        self.unsubscribe()
        self.identity_patch.stop()

    def handle(self, identity="synthetic-identity-a", backend="kas"):
        runtime = MagicMock()
        runtime.acp_backend = backend
        handle = AcpSessionHandle("synthetic-session", asyncio.Queue(), runtime)
        handle.request_vault_identity = identity
        handle._sync_effort_levels = MagicMock()
        return handle

    def assert_catalog(self, extra="synthetic-a", identity="synthetic-identity-a"):
        rows = catalog.recorded_catalog_snapshot(identity)
        self.assertIsNotNone(rows)
        self.assertEqual([row["model_name"] for row in rows], ["auto", extra])
        return rows

    async def test_initial_config_records_with_current_identity(self):
        h = self.handle()
        h.store_session_config({"configOptions": config()})
        await settled()
        self.assert_catalog()

    async def test_late_live_update_records_after_empty_session_new_and_http_reads_it(self):
        h = self.handle()
        h.store_session_config({"sessionId": "synthetic-session"})
        self.assertIsNone(catalog.recorded_catalog_snapshot(self.vault))
        self.assertEqual(h._handle_update(frame(config())), [])
        await settled()
        self.assert_catalog()
        with patch.object(handler, "_bundle_installed", lambda: True), patch.object(handler, "_vault_signed_in", lambda: True), \
             patch.object(handler.model_registry, "refresh_kiro_catalog", lambda *_: (False, False)), \
             patch.object(handler.model_registry, "model_window", lambda *_: None):
            response = await handler.api_models_kas_bundle(SimpleNamespace())
        self.assertEqual([row["model_name"] for row in json.loads(response.text)], ["auto", "synthetic-a"])
        self.assertEqual(self.events, ["kas"])

    async def test_init_drain_records_the_delayed_select(self):
        h = self.handle()
        h._queue.put_nowait(frame(config()))
        await h.drain_init(duration=0.01, idle_exit=0.001, no_report_ceiling=0.01)
        await settled()
        self.assert_catalog()
        self.assertTrue(h._queue.empty())
        self.assertEqual(self.events, ["kas"])

    async def test_set_config_response_records_and_repeated_notification_deduplicates(self):
        h = self.handle()
        h._send_awaited = AsyncMock(return_value=1)
        h._wait_for_response = AsyncMock(return_value=SimpleNamespace(result={"configOptions": config()}))
        await h.set_config_option("model", "synthetic-a")
        h._handle_update(frame(config(current="synthetic-a")))
        await settled()
        self.assert_catalog()
        self.assertEqual(self.events, ["kas"])

    async def test_row_dedup_ignores_effort_and_current_but_detects_price(self):
        h = self.handle()
        h._handle_update(frame(config()))
        await settled()
        h._handle_update(frame(config(current="synthetic-a") + [{"id": "effortLevel", "type": "select", "options": []}]))
        await settled()
        self.assertEqual(self.events, ["kas"])
        h._handle_update(frame(config(rate=2)))
        await settled()
        self.assertEqual(self.events, ["kas", "kas"])
        self.assertEqual(self.assert_catalog()[1]["rate_multiplier"], 2)

    async def test_empty_malformed_or_unrelated_select_does_not_clear_rows(self):
        h = self.handle()
        h._handle_update(frame(config()))
        await settled()
        for cfg in ([], {}, None, [{"id": "model", "type": "select", "options": []}], [{"id": "effortLevel", "type": "select", "options": []}]):
            h._handle_update(frame(cfg))
        await settled()
        self.assert_catalog()
        self.assertEqual(self.events, ["kas"])

    async def test_foreign_account_updates_never_replace_the_current_catalog(self):
        self.vault = "synthetic-identity-b"
        current = self.handle(identity=self.vault)
        current.store_session_config({"configOptions": config("model-b")})
        await settled()
        old = self.handle()
        old.store_session_config({"configOptions": config("model-a")})
        old._handle_update(frame(config("model-a")))
        await settled()
        self.assert_catalog("model-b", self.vault)
        self.assertEqual(self.events, ["kas"])

    async def test_inflight_older_vault_read_cannot_overwrite_later_identity_commit(self):
        first_entered = threading.Event()
        release_old = threading.Event()
        count = 0
        def delayed_identity():
            nonlocal count
            count += 1
            if count == 1:
                first_entered.set()
                release_old.wait(timeout=2)
                return "synthetic-identity-a"
            return "synthetic-identity-b"
        with patch.object(catalog, "vault_identity", delayed_identity):
            old = self.handle()
            old._handle_update(frame(config("model-a")))
            if not hasattr(catalog, "schedule_catalog"):
                self.fail("baseline drops config updates")
            await asyncio.to_thread(first_entered.wait, 1)
            newer = self.handle(identity="synthetic-identity-b")
            newer._handle_update(frame(config("model-b")))
            for _ in range(50):
                if catalog.recorded_catalog_snapshot("synthetic-identity-b"):
                    break
                await asyncio.sleep(0.002)
            release_old.set()
            await settled()
        self.assert_catalog("model-b", "synthetic-identity-b")
        self.assertEqual(self.events, ["kas"])

    async def test_missing_stamp_and_other_backend_do_not_record_or_notify(self):
        for h in (self.handle(identity=""), self.handle(backend="kiro"), self.handle(backend="codex")):
            h.store_session_config({"configOptions": config()})
            h._handle_update(frame(config()))
        await settled()
        self.assertIsNone(catalog.recorded_catalog_snapshot(self.vault))
        self.assertEqual(self.events, [])

    async def test_init_child_frame_does_not_claim_parent_catalog(self):
        h = self.handle()
        h._apply_init_notification(frame(config(), session="synthetic-child"), "update")
        await settled()
        self.assertIsNone(catalog.recorded_catalog_snapshot(self.vault))
        self.assertEqual(self.events, [])

    async def test_auth_renewal_same_identity_continues_and_auto_only_is_valid(self):
        h = self.handle()
        h._handle_update(frame(config()))
        await settled()
        h._handle_update(frame([{**config()[0], "options": [{"value": "auto", "name": "Auto"}]}]))
        await settled()
        rows = catalog.recorded_catalog_snapshot(self.vault)
        self.assertIsNotNone(rows)
        self.assertEqual([row["model_name"] for row in rows], ["auto"])
        self.assertEqual(self.events, ["kas", "kas"])

    async def test_bad_or_empty_vault_identity_fails_closed(self):
        for identity in ("", "another-account"):
            self.vault = identity
            self.handle()._handle_update(frame(config()))
            await settled()
        self.assertIsNone(catalog.recorded_catalog_snapshot("synthetic-identity-a"))
        self.assertEqual(self.events, [])

    async def test_later_identical_snapshot_supersedes_an_inflight_different_candidate(self):
        h = self.handle()
        h._handle_update(frame(config()))
        await settled()
        self.assert_catalog()
        entered = threading.Event()
        release = threading.Event()
        def delayed_identity():
            entered.set()
            release.wait(timeout=2)
            return self.vault
        with patch.object(catalog, "vault_identity", delayed_identity):
            h._handle_update(frame(config("superseded-model")))
            await asyncio.to_thread(entered.wait, 1)
            h._handle_update(frame(config()))
            release.set()
            await settled()
        self.assert_catalog()
        self.assertEqual(self.events, ["kas"])

    @unittest.skipIf(BASELINE, "bounded worker is absent in baseline")
    async def test_burst_keeps_one_worker_one_read_and_only_latest_rows(self):
        h = self.handle()
        entered = threading.Event()
        release = threading.Event()
        reads = 0
        def slow_identity():
            nonlocal reads
            reads += 1
            entered.set()
            release.wait(timeout=2)
            return self.vault
        with patch.object(catalog, "vault_identity", slow_identity):
            h._handle_update(frame(config("model-0")))
            await asyncio.to_thread(entered.wait, 1)
            for i in range(1, 1001):
                h._handle_update(frame(config(f"model-{i}")))
            self.assertEqual(reads, 1)
            self.assertEqual(len(catalog._tasks), 1)
            self.assertEqual(len(catalog._pending), 1)
            release.set()
            await settled()
        self.assert_catalog("model-1000")
        self.assertEqual(reads, 1)
        self.assertEqual(self.events, ["kas"])

    @unittest.skipIf(BASELINE, "bounded worker is absent in baseline")
    async def test_late_other_identity_cannot_advance_an_old_read_past_current_commit(self):
        old = self.handle()
        entered = threading.Event()
        release = threading.Event()
        reads = 0
        def changing_identity():
            nonlocal reads
            reads += 1
            if reads == 1:
                entered.set()
                release.wait(timeout=2)
                return "synthetic-identity-a"
            return "synthetic-identity-b"
        with patch.object(catalog, "vault_identity", changing_identity):
            old._handle_update(frame(config("old-a")))
            await asyncio.to_thread(entered.wait, 1)
            current = self.handle(identity="synthetic-identity-b")
            current._handle_update(frame(config("current-b")))
            for _ in range(50):
                if catalog.recorded_catalog_snapshot("synthetic-identity-b"):
                    break
                await asyncio.sleep(0.002)
            for i in range(100):
                old._handle_update(frame(config(f"late-old-a-{i}")))
            release.set()
            await settled()
        self.assert_catalog("current-b", "synthetic-identity-b")
        self.assertEqual(self.events, ["kas"])

    @unittest.skipIf(BASELINE, "bounded worker is absent in baseline")
    async def test_distinct_stamp_admission_has_a_finite_task_and_candidate_bound(self):
        release = threading.Event()
        def held_identity():
            release.wait(timeout=2)
            return "synthetic-identity-a"
        with patch.object(catalog, "vault_identity", held_identity):
            for i in range(100):
                identity = "synthetic-identity-a" if i == 0 else f"synthetic-other-{i}"
                self.handle(identity=identity)._handle_update(frame(config()))
            self.assertLessEqual(len(catalog._tasks), catalog._MAX_PENDING_IDENTITIES)
            self.assertLessEqual(len(catalog._pending), catalog._MAX_PENDING_IDENTITIES)
            release.set()
            await settled()
        self.assert_catalog()

    @unittest.skipIf(BASELINE, "new gateway wiring is absent in baseline")
    async def test_both_gateway_entry_modules_import_with_overlay_without_starting_server(self):
        import importlib
        for name in ("kiro_crew.dashboard.server", "kiro_crew.dashboard.server_runtime.api_entrypoint"):
            module = importlib.import_module(name)
            self.assertIsInstance(module.__loader__, overlay.FrozenLoader)
            self.assertTrue(Path(module.__file__).is_relative_to(overlay.installation_root()))

    @unittest.skipIf(BASELINE, "new gateway wiring is absent in baseline")
    async def test_gateway_wiring_is_idempotent_coalesces_and_unsubscribes(self):
        from kiro_crew.dashboard.server_runtime.model_catalog_events import wire_model_catalog_events
        class App(dict):
            on_cleanup = None
        app = App()
        app.on_cleanup = []
        broadcasts = []
        state = SimpleNamespace(broadcast_ws=lambda kind, data: broadcasts.append((kind, data)))
        wire_model_catalog_events(app, state)
        wire_model_catalog_events(app, state)
        self.assertEqual(len(app.on_cleanup), 1)
        h = self.handle()
        h._handle_update(frame(config()))
        await settled()
        h._handle_update(frame(config("synthetic-b")))
        await settled()
        await asyncio.sleep(0.08)
        self.assertEqual(broadcasts, [("models_catalog_changed", {"backend": "kas"})])
        await app.on_cleanup[0](app)
        h._handle_update(frame(config("synthetic-c")))
        await settled()
        await asyncio.sleep(0.08)
        self.assertEqual(len(broadcasts), 1)

    @unittest.skipIf(BASELINE, "new gateway wiring is absent in baseline")
    async def test_gateway_cleanup_cancels_a_queued_invalidation(self):
        from kiro_crew.dashboard.server_runtime.model_catalog_events import wire_model_catalog_events
        class App(dict):
            on_cleanup = None
        app = App()
        app.on_cleanup = []
        state = SimpleNamespace(broadcast_ws=MagicMock())
        wire_model_catalog_events(app, state)
        self.handle()._handle_update(frame(config()))
        await settled()
        await app.on_cleanup[0](app)
        await asyncio.sleep(0.08)
        state.broadcast_ws.assert_not_called()


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        SANDBOX.cleanup()

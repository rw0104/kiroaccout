"""Gateway lifecycle wiring for asynchronously learned KAS model catalogs."""
from __future__ import annotations

import asyncio
from typing import Any

from kiro_crew.agent_sdk.kas_model_catalog import subscribe_catalog_changes

_APP_KEY = "kas_model_catalog_events"


def wire_model_catalog_events(app: Any, state: Any) -> None:
    """One bounded invalidation sink per gateway, removed during cleanup.

    Model rows and account stamps stay in the catalog. This signal only tells
    authenticated dashboard clients to read the existing identity-fenced API.
    """
    if app.get(_APP_KEY):
        return
    app[_APP_KEY] = True
    loop = asyncio.get_running_loop()
    closed = False
    pending: set[str] = set()
    timer: asyncio.TimerHandle | None = None

    def flush() -> None:
        nonlocal timer
        timer = None
        if closed:
            return
        backends = tuple(pending)
        pending.clear()
        if backends:
            state.broadcast_ws("models_changed", {})

    def enqueue(backend: str) -> None:
        nonlocal timer
        if closed or backend != "kas":
            return
        pending.add(backend)
        if timer is None:
            timer = loop.call_later(0.05, flush)

    def changed(backend: str) -> None:
        if not closed and not loop.is_closed():
            loop.call_soon_threadsafe(enqueue, backend)

    unsubscribe = subscribe_catalog_changes(changed)

    async def cleanup(_app: Any) -> None:
        nonlocal closed, timer
        closed = True
        unsubscribe()
        if timer is not None:
            timer.cancel()
            timer = None
        pending.clear()
        app[_APP_KEY] = False

    app.on_cleanup.append(cleanup)

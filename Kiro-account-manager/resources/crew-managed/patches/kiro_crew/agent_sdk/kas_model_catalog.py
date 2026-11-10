# Modified by kiroaccout contributors: asynchronous model catalog synchronization.
# Derived from KiroCrew 0.12.0; licensed under Apache-2.0, see LICENSE.KiroCrew.
"""The KAS engine's model catalog, read off the ``model`` select it advertises.

Measured on the bundled engine (KAS 0.66.33, run from Kiro Crew's own install
with no kiro-cli on the host; the frame is
``test/fixtures/acp_frames/kas/bundle-session-live.jsonl``): a ``session/new``
response carries NO ``models`` object. The model list is the ``configOptions``
``model`` select alone, one option per served model --
``{value, name, description, _meta.kiro.{rateMultiplier, rateUnit, hasEffort,
...}}`` -- and no option carries a structured context-window field.

On kiro-cli's relay route the dashboard picker reads ``kiro-cli chat
--list-models`` (``dashboard/handlers/agents.py``), a catalog kiro-cli prints
from its account API. On the bundle route there is no kiro-cli to ask, so the
select IS the catalog. This module turns the select into rows shaped like that
``--list-models`` catalog (``model_id`` / ``model_name`` / ``display_name`` /
``description`` / ``rate_multiplier``), so the readers that already consume
catalog rows -- ``model_registry.refresh_kiro_catalog`` for the ``acp``
vocabulary bucket and the credit multipliers, the picker for its rows --
consume ONE shape whichever route fed them. The select never becomes a
session's advertised (entitlement) list; see model-selection.md, "KAS sends no
``models`` object". It is a catalog, read the way the kiro-cli catalog is.

The last select a KAS session advertised is kept in memory, process-wide, for
``GET /api/models`` on the bundle route (``dashboard/handlers/models_kas_bundle.py``).
In memory only, like the catalog's prices: what the engine serves is a fact
about the account signed in NOW, so a cold process has no catalog until a
session advertises one. A select is what ONE account is served, so the
recording carries the vault identity fingerprint its request went out under
(:func:`vault_identity`, read by the KAS harness as the session payload is built),
and the reader serves it only while the vault still names that account
(:func:`recorded_catalog_snapshot`). The fingerprint is read from the vault
file itself, so the fence holds whichever process changed the account -- the
dashboard's sign-in card, or ``kirocrew kas login`` / ``kas logout`` in a shell
-- and needs no notice from the writer.
Recorded by the shared-runtime driver (``AcpSessionHandle.store_session_config``;
KAS runs on ``AcpRuntime`` only, ``ACP_BACKENDS_ACP_RUNTIME``) on a positive KAS
identity, so a KAS session on either route records; only the bundle-route picker
READS it.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable
from typing import Any

from kiro_crew import model_registry
from kiro_crew.agent_sdk.backends import ACP_BACKEND_KAS

logger = logging.getLogger(__name__)

#: Longest string kept on a catalog row besides its id -- the same bound the
#: advertised-id store applies, so a row cannot carry more than the id store would
#: admit for its name.
_ROW_TEXT_MAX_CHARS = model_registry.ADVERTISED_MODEL_ID_MAX_CHARS

#: The rows of the last non-empty select a KAS session advertised. Guarded by
#: ``_LOCK``: the recorders run on the event loop, the reader may run on a worker
#: thread, and a torn read would serve half a catalog.
_recorded: list[dict[str, Any]] | None = None
#: The vault identity fingerprint (``auth.bridge.vault_identity_fingerprint``)
#: read as the recording's request went out: WHICH account the rows are. Under
#: ``_LOCK`` with the rows, as one state.
_recorded_identity = ""
_LOCK = threading.Lock()
_sequence = 0
_committed_sequence = 0
_pending: dict[str, tuple[int, list[dict[str, Any]]]] = {}
_tasks: set[asyncio.Task[None]] = set()
_workers: dict[str, asyncio.Task[None]] = {}
# One latest candidate and one vault read per in-flight identity. This is a
# process-local admission bound, not an account/model entitlement limit.
_MAX_PENDING_IDENTITIES = 16
_listeners: set[Callable[[str], None]] = set()


def subscribe_catalog_changes(listener: Callable[[str], None]) -> Callable[[], None]:
    """Attach a gateway-owned invalidation sink; no identity or rows leave here."""
    _listeners.add(listener)

    def unsubscribe() -> None:
        _listeners.discard(listener)

    return unsubscribe


def _next_sequence() -> int:
    global _sequence
    with _LOCK:
        _sequence += 1
        return _sequence


def _record_rows(
    rows: list[dict[str, Any]], identity: str, sequence: int, *, fence_sequence: int | None = None
) -> bool:
    global _recorded, _recorded_identity, _committed_sequence
    with _LOCK:
        # A vault check that was already in flight must not replace a catalog
        # committed by a later update while that check awaited its worker.
        if (sequence if fence_sequence is None else fence_sequence) < _committed_sequence:
            return False
        _committed_sequence = sequence
        if _recorded_identity == identity and _recorded == rows:
            return False
        _recorded = [dict(row) for row in rows]
        _recorded_identity = identity
    for listener in tuple(_listeners):
        try:
            listener(ACP_BACKEND_KAS)
        except Exception:
            logger.debug("KAS catalog invalidation sink failed")
    return True


def schedule_catalog(resp: dict[str, Any], backend: str, *, identity: object) -> bool:
    """Capture a KAS select now and commit only for its still-current identity.

    Used by all session config entrypoints, including init drains that produce
    no AcpEvent. Vault IO stays off the event loop. A callback signals an actual
    catalog-row change, not an effort/currentValue update or a repeated frame.
    """
    if backend != ACP_BACKEND_KAS or not isinstance(identity, str) or not identity:
        return False
    rows = catalog_rows_from_session(resp)
    if not rows:
        return False
    previous = _pending.get(identity)
    with _LOCK:
        if _recorded_identity == identity and _recorded == rows:
            # A later select can return to the currently recorded rows while a
            # different candidate is awaiting its vault read. Supersede that
            # candidate even though this latest select needs no publication.
            _pending.pop(identity, None)
            return False
    if previous is not None and previous[1] == rows:
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Production session creation/config updates run on the runtime loop.
        # Never replace the identity fence with a blocking read or a guess.
        return False
    worker = _workers.get(identity)
    if worker is None or worker.done():
        # Repeated updates of one identity never allocate another worker. An
        # unexpected stream of distinct stamps must also remain bounded.
        if sum(not task.done() for task in _workers.values()) >= _MAX_PENDING_IDENTITIES:
            logger.debug("KAS catalog update not scheduled: identity admission is busy")
            return False
    sequence = _next_sequence()
    _pending[identity] = (sequence, rows)
    if worker is not None and not worker.done():
        return True

    async def commit() -> None:
        try:
            while (candidate := _pending.get(identity)) is not None:
                read_sequence = candidate[0]
                current = await asyncio.to_thread(vault_identity)
                latest = _pending.get(identity)
                if current != identity or latest is None:
                    return
                # Coalesce a burst to its newest rows, but keep the ordering
                # fence from BEFORE this vault read. A late old-identity frame
                # cannot buy a fresh fence merely by advancing its candidate id.
                with _LOCK:
                    superseded = read_sequence < _committed_sequence
                if superseded:
                    if latest[0] > read_sequence:
                        # The newer candidate deserves a new identity read;
                        # at most this one worker exists for the identity.
                        continue
                    return
                _record_rows(latest[1], identity, latest[0], fence_sequence=read_sequence)
                if _pending.get(identity) is latest:
                    _pending.pop(identity, None)
        except Exception:
            logger.debug("KAS catalog identity could not be confirmed")
        finally:
            _pending.pop(identity, None)

    task = loop.create_task(commit(), name="kas-model-catalog")
    _workers[identity] = task
    _tasks.add(task)
    def finished(done: asyncio.Task[None]) -> None:
        _tasks.discard(done)
        if _workers.get(identity) is done:
            _workers.pop(identity, None)
    task.add_done_callback(finished)
    return True


async def wait_for_catalog_updates() -> None:
    """Drain captured updates at a test/shutdown boundary; never starts a fetch."""
    while _tasks:
        await asyncio.gather(*tuple(_tasks), return_exceptions=True)


def _clamp(value: object) -> str:
    text = value if isinstance(value, str) else ""
    return text[:_ROW_TEXT_MAX_CHARS]


def _multiplier(option: dict[str, Any]) -> float | None:
    """``_meta.kiro.rateMultiplier`` as a number, or ``None`` when absent / not one.

    ``bool`` is refused (``True`` would read as a 1.0x price). The picker and
    ``model_registry._catalog_rates`` apply their own positive-finite test; this
    only decides whether the row carries the field at all.
    """
    meta = option.get("_meta")
    kiro = meta.get("kiro") if isinstance(meta, dict) else None
    rate = kiro.get("rateMultiplier") if isinstance(kiro, dict) else None
    if isinstance(rate, bool) or not isinstance(rate, (int, float)):
        return None
    return float(rate)


def catalog_rows_from_session(resp: dict[str, Any]) -> list[dict[str, Any]]:
    """The ``model`` select of a session response as ``--list-models``-shaped rows.

    ``[]`` when the response advertises no such select or an empty one. Row order
    is the select's order (the engine lists its routing entry first). A row whose
    ``value`` is over the id bound is refused, never truncated, the same rule
    :func:`model_registry.admit_catalog_rows` applies, and the list is cut at
    ``ADVERTISED_MODELS_MAX_IDS`` rows so what is retained is never more than the
    id store will admit; both refusals are counted and logged once per call. ``rate_multiplier`` is
    present only on a row whose option carried a numeric ``rateMultiplier``; a
    reader that finds it absent knows the price, not just the number, is unknown.
    No ``context_window_tokens`` is ever synthesized: the select carries none.
    """
    # Lazy: acp.session_handle imports model_registry-adjacent modules at import
    # time, and this module is imported by the session drivers themselves.
    from kiro_crew.acp.session_handle_model_selection import _select_options

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    # Refused, and said so ONCE per call like ``model_registry._admit_ids``: an
    # option cut for the count or the id length would otherwise look exactly like
    # a model the engine never served, in the picker, the vocabulary and the
    # prices alike. A blank or non-string ``value`` and a duplicate are malformed
    # or redundant, not refused, and are skipped silently as there.
    refused = 0
    for opt in resp.get("configOptions") or []:
        if not isinstance(opt, dict) or opt.get("id") != "model" or opt.get("type") != "select":
            continue
        for option in _select_options(opt.get("options")):
            value = option.get("value")
            if not isinstance(value, str) or not value.strip() or value in seen:
                continue
            if (
                len(value) > model_registry.ADVERTISED_MODEL_ID_MAX_CHARS
                or len(rows) >= model_registry.ADVERTISED_MODELS_MAX_IDS
            ):
                refused += 1
                continue
            seen.add(value)
            row: dict[str, Any] = {
                "model_id": value,
                "model_name": value,
                "display_name": _clamp(option.get("name")) or value,
                "description": _clamp(option.get("description")),
            }
            rate = _multiplier(option)
            if rate is not None:
                row["rate_multiplier"] = rate
            rows.append(row)
        break
    if refused:
        logger.warning(
            "KAS model select refused %d option(s): over %d ids or over %d chars",
            refused,
            model_registry.ADVERTISED_MODELS_MAX_IDS,
            model_registry.ADVERTISED_MODEL_ID_MAX_CHARS,
        )
    return rows


def vault_identity() -> str:
    """The vault identity fingerprint now; ``""`` when empty or unreadable.

    Blocking (reads the vault); call off the loop. Never raises. The one read
    both the KAS harness's stamp (``acp/harness/kas.py``, ``SessionExtras.vault_identity``)
    and the picker's match go through.
    """
    # Deferred: kiro_crew.auth pulls the ``cryptography`` wheel, which must not
    # load on the session drivers' import path (see kiro_crew.acp.kas_host_auth).
    from kiro_crew.auth.bridge import vault_identity_fingerprint

    return vault_identity_fingerprint()


def record_catalog(resp: dict[str, Any], backend: str, *, identity: object) -> bool:
    """Record an already identity-fenced select; ``True`` only when rows changed.

    Session entrypoints use ``schedule_catalog`` to validate the current vault
    off-loop before committing. This synchronous seam is retained for callers
    that already own an identity-fenced snapshot and for parser-level tests.

    Positive on KAS identity: the fact recorded here -- that the ``model`` select
    is the engine's catalog -- is a KAS wire fact, and no other harness's select
    is read as one. Another backend records nothing and nothing is cleared: a
    response that advertises no select (a ``session/load`` on some engines) must
    not wipe a catalog a ``session/new`` recorded a moment ago.

    *identity* is the vault fingerprint read as the producing session's request
    went out (``AcpSessionHandle.request_vault_identity``), kept with the rows.
    Anything but a non-empty ``str`` -- an unstamped request, an empty vault --
    is refused, so an unknown origin can never pass as the signed-in account. A
    response that lands after an account switch is recorded under the account it
    was asked for, and the reader does not serve it to the next one.
    """
    if backend == ACP_BACKEND_KAS:
        rows = catalog_rows_from_session(resp)
        if rows:
            if not (isinstance(identity, str) and identity):
                logger.debug(
                    "KAS model catalog not recorded: the request carried no vault identity"
                )
                return False
            return _record_rows(rows, identity, _next_sequence())
    return False


def recorded_catalog_snapshot(identity: str) -> list[dict[str, Any]] | None:
    """A copy of the last recorded select's rows, if they belong to *identity*.

    *identity* is the vault fingerprint the caller just read. The rows are
    ``None`` unless they were recorded for exactly that account: when the vault
    names another one, the recording is the previous account's and cold is the
    honest answer. ``""`` (an empty or unreadable vault) never matches. Nothing
    is forgotten on a mismatch: if the vault comes back to that account, its rows
    serve again. A reader that awaits between taking this copy and serving it
    reads the vault again afterwards and discards the copy if the account moved.
    """
    with _LOCK:
        if _recorded is None or not identity or identity != _recorded_identity:
            return None
        return [dict(row) for row in _recorded]

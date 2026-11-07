"""Access-only KAS projection through the installed official Crew TokenStore.

Input is JSON on stdin. Output contains only a revision or a fixed error code.
No network request, refresh-token handling, or proprietary vault implementation.
"""

import contextlib
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import stat
import sys
from datetime import datetime, timezone


FILES = ("kas/.vault/secrets.enc", "kas/.vault/.vault_key", "kas/signed-in", "kas/signed-out")
MAX_BYTES = 16 * 1024 * 1024
MAX_INPUT = 1024 * 1024
MAX_CONFIG = 2 * 1024 * 1024


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def unlinked(path, directory=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode) or (hasattr(path, "is_junction") and path.is_junction()):
        raise Refusal("target-changed")
    if directory and not stat.S_ISDIR(info.st_mode):
        raise Refusal("target-changed")
    if not directory and not stat.S_ISREG(info.st_mode):
        raise Refusal("target-changed")
    return info


def auth_revision(home):
    for directory in (home, home / "kas", home / "kas" / ".vault"):
        unlinked(directory, True)
    digest = hashlib.sha256(b"crew-access-v1\0")
    for relative in FILES:
        digest.update(relative.encode("utf-8") + b"\0")
        path = home / relative
        info = unlinked(path)
        if info is None:
            digest.update(b"missing\0")
            continue
        if info.st_size > MAX_BYTES:
            raise Refusal("target-changed")
        content = path.read_bytes()
        if len(content) != info.st_size:
            raise Refusal("target-changed")
        digest.update(b"file\0" + str(len(content)).encode("ascii") + b"\0" + content + b"\0")
    return digest.hexdigest()


def read_config_document(path):
    info = unlinked(path)
    if info is None:
        return {}
    if info.st_size > MAX_CONFIG:
        raise Refusal("target-changed")
    content = path.read_bytes()
    if len(content) != info.st_size:
        raise Refusal("target-changed")
    document = json.loads(content.decode("utf-8-sig"))
    if not isinstance(document, dict):
        raise Refusal("target-changed")
    agent_section(document)
    return document


def agent_section(document):
    agent = document.get("agent", {})
    if not isinstance(agent, dict):
        raise Refusal("target-changed")
    return agent


def engine_settings(base, overlay):
    agent = {**agent_section(base), **agent_section(overlay)}
    provider = agent.get("provider", "acp")
    backend = agent.get("acp_backend", "kas")
    if backend == "":
        backend = "kas"
    bundle = agent.get("kas_bundle", False)
    if not isinstance(provider, str) or not isinstance(backend, str) or not isinstance(bundle, bool):
        raise Refusal("target-changed")
    return [provider, backend, bundle]


def read_engine(home):
    return engine_settings(read_config_document(home / "config.json"), read_config_document(home / "config.local.json"))


def combine_revision(auth_stamp, engine):
    encoded = json.dumps(engine, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(b"crew-access-v2\0" + auth_stamp.encode("ascii") + b"\0" + encoded + b"\0").hexdigest()


def revision(home):
    return combine_revision(auth_revision(home), read_engine(home))


def ensure_engine(data, home, expected_auth):
    """Only explicit switching may enable the official own-bundle auth route.

    Official config RMW owns its sidecar lock, fresh read, atomic replace and ACL.
    The config and credential vault are separate transactions. A later auth failure
    leaves this safe engine setting in place; no stale config snapshot is restored.
    """
    from kiro_crew.config.loader_document import update_config_locked

    base = read_config_document(home / "config.json")
    overlay = read_config_document(home / "config.local.json")
    selected = engine_settings(base, overlay)
    if selected[:2] != ["acp", "kas"] or agent_section(overlay).get("kas_bundle") is False:
        raise Refusal("unsupported-engine")
    if selected[2]:
        return False
    if not data["explicit"]:
        raise Refusal("target-changed")

    def mutate(fresh):
        agent_section(fresh)
        current_overlay = read_config_document(home / "config.local.json")
        current_engine = engine_settings(fresh, current_overlay)
        if (current_engine[:2] != ["acp", "kas"]
                or agent_section(current_overlay).get("kas_bundle") is False):
            raise Refusal("unsupported-engine")
        if (auth_revision(home) != expected_auth
                or combine_revision(expected_auth, current_engine) != data["expectedRevision"]):
            raise Refusal("target-changed")
        if current_engine[2]:
            return None
        return {**fresh, "agent": {**agent_section(fresh), "kas_bundle": True}}

    # Refuse symlinked configs even though the official primitive supports following them.
    unlinked(home / "config.json")
    update_config_locked(home / "config.json", mutate=mutate, fsync=True,
                         stamp_meta=False, on_corrupt="fail", wait_for_lock=True)
    if read_engine(home) != ["acp", "kas", True]:
        raise Refusal("target-changed")
    return True


def parse(raw):
    if len(raw) > MAX_INPUT:
        raise Refusal("invalid-request")
    data = json.loads(raw)
    expected_keys = {"version", "dataHome", "expectedRevision", "accountIdentity", "explicit", "access"}
    if not isinstance(data, dict) or set(data) != expected_keys or data["version"] != 1:
        raise Refusal("invalid-request")
    if not isinstance(data["dataHome"], str) or not os.path.isabs(data["dataHome"]) or "\0" in data["dataHome"]:
        raise Refusal("invalid-request")
    for key in ("expectedRevision", "accountIdentity"):
        if not isinstance(data[key], str) or re.fullmatch(r"[a-f0-9]{64}", data[key]) is None:
            raise Refusal("invalid-request")
    if not isinstance(data["explicit"], bool):
        raise Refusal("invalid-request")
    access = data["access"]
    if not isinstance(access, dict) or set(access) - {"accessToken", "expiresAt", "provider", "authMethod", "profileArn", "region"}:
        raise Refusal("invalid-request")
    if not {"accessToken", "expiresAt", "provider"}.issubset(access):
        raise Refusal("invalid-request")
    bearer = access["accessToken"]
    if not isinstance(bearer, str) or not bearer.strip() or len(bearer) > 512 * 1024 or "\0" in bearer:
        raise Refusal("credential-unusable")
    expiry = access["expiresAt"]
    if isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry):
        raise Refusal("credential-unusable")
    provider = access["provider"]
    identities = {"Google": "social", "Github": "social", "BuilderId": "builder_id", "Enterprise": "identity_center"}
    if provider not in identities:
        raise Refusal("credential-unusable")
    auth_method = access.get("authMethod")
    if auth_method is not None and auth_method != ("social" if identities[provider] == "social" else "IdC"):
        raise Refusal("credential-unusable")
    profile = access.get("profileArn")
    if profile is not None and (not isinstance(profile, str) or not profile or len(profile) > 4096):
        raise Refusal("credential-unusable")
    if provider != "BuilderId" and not profile:
        raise Refusal("credential-unusable")
    region = access.get("region")
    if region is not None and (not isinstance(region, str) or re.fullmatch(r"[a-z]{2}(?:-[a-z]+){1,3}-\d+", region) is None):
        raise Refusal("credential-unusable")
    data["identity"] = identities[provider]
    return data


def project(data):
    # These are the official installed modules; their locks, encryption and ACLs are retained.
    from kiro_crew.auth.store import KasToken, TokenStore, KNOWN_IDENTITIES

    home = Path(data["dataHome"])
    if revision(home) != data["expectedRevision"]:
        raise Refusal("target-changed")
    expected_auth = auth_revision(home)
    access = data["access"]
    token = KasToken(
        access_token=access["accessToken"],
        expires_at=datetime.fromtimestamp(access["expiresAt"] / 1000, timezone.utc),
        provider=access["provider"], identity=data["identity"],
        profile_arn=access.get("profileArn"), auth_method=access.get("authMethod"),
        region=access.get("region"),
        extra={"manager_account_identity": data["accountIdentity"]},
    )
    if not token.is_storable() or token.refresh_token is not None or token.client_secret is not None:
        raise Refusal("credential-unusable")
    if token.is_expired():
        raise Refusal("credential-unusable")
    backend_configured = ensure_engine(data, home, expected_auth)
    data["_backend_configured"] = backend_configured
    store = TokenStore(home)
    if not all(callable(getattr(store, name, None)) for name in
               ("with_signout_lock", "save", "load", "delete", "bump_signout_generation", "bump_signin_generation")):
        raise Refusal("unsupported-runtime")

    committed_revision = None

    def commit():
        nonlocal committed_revision
        if auth_revision(home) != expected_auth or read_engine(home) != ["acp", "kas", True]:
            raise Refusal("target-changed")
        if token.is_expired():
            raise Refusal("credential-unusable")
        previous = store.load(token.identity)
        # A surviving lower-priority slot does not prove that it is the identity
        # Crew currently resolves. Explicit replacement must retire every other
        # live identity; a background update must refuse this changed auth domain.
        other_identity_present = any(
            store.load(identity) is not None
            for identity in KNOWN_IDENTITIES if identity != token.identity
        )
        same_account = (previous is not None and isinstance(previous.extra, dict)
                        and not other_identity_present
                        and previous.extra.get("manager_account_identity") == data["accountIdentity"]
                        and previous.provider == token.provider
                        and previous.auth_method == token.auth_method
                        and previous.profile_arn == token.profile_arn
                        and previous.region == token.region
                        and previous.refresh_token is None)
        if not same_account and not data["explicit"]:
            raise Refusal("target-changed")
        # A new identity retires cached sessions and fences an earlier pending login.
        # Routine access rotations preserve both identity generation markers.
        # Set this BEFORE the first possible auth mutation. An exception or timeout
        # cannot prove which marker/save/delete already committed; never auto-retry it.
        data["_auth_write_attempted"] = True
        if not same_account:
            store.bump_signout_generation()
            store.bump_signin_generation()
        store.save(token)  # Own refresh lock then vault lock; do not take either twice.
        if not same_account:
            for identity in KNOWN_IDENTITIES:
                if identity != token.identity:
                    store.delete(identity)
        written = store.load(token.identity)
        if written is None or written.access_token != token.access_token or written.refresh_token is not None:
            raise Refusal("write-failed")
        if read_engine(home) != ["acp", "kas", True]:
            raise Refusal("target-changed")
        committed_revision = revision(home)

    store.with_signout_lock(commit)
    return {"ok": True, "revision": committed_revision, "backendConfigured": backend_configured}


def main():
    logging.disable(logging.CRITICAL)
    data = None
    try:
        data = parse(sys.stdin.buffer.read(MAX_INPUT + 1))
        # Official libraries must not leak logs/tracebacks into the helper protocol.
        with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = project(data)
    except Refusal as error:
        result = {"ok": False, "error": error.code}
    except Exception:
        result = {"ok": False, "error": "write-failed"}
    if not result.get("ok"):
        result["writeUncertain"] = isinstance(data, dict) and data.get("_auth_write_attempted") is True
        if isinstance(data, dict) and data.get("_backend_configured") is True:
            result["backendConfigured"] = True
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()

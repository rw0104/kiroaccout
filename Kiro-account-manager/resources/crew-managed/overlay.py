"""Load the version-scoped Crew catalog correction without modifying its install.

KiroCrew-derived modules retain their upstream Apache-2.0 notices. This loader
and its manifest are part of kiroaccout's managed-workspace integration.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.abc
import importlib.util
import json
from pathlib import Path
import stat
import sys

HERE = Path(__file__).resolve().parent
UPSTREAM_COMMIT = "f315771db6a95704d129c7b722340a676d6bb8a4"
ASSET = "useWebSocket-DK9hitwq.js"
MODULES = frozenset((
    "kiro_crew.agent_sdk.kas_model_catalog",
    "kiro_crew.acp.session_handle_model_selection",
    "kiro_crew.acp.session_handle_updates",
    "kiro_crew.acp.session_handle_mcp",
    "kiro_crew.dashboard.server",
    "kiro_crew.dashboard.server_runtime.api_entrypoint",
    "kiro_crew.dashboard.server_runtime.model_catalog_events",
))
SUPPORT_FILES = frozenset(("launcher.py", "overlay.py", "LICENSE.KiroCrew", "NOTICE.KiroCrew"))


class ManagedCrewError(RuntimeError):
    """A fixed local category. Raw exceptions must not cross the control pipe."""


def reject_links(path: Path) -> None:
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ManagedCrewError("linked-path")


def read_regular(path: Path, maximum=16 * 1024 * 1024) -> bytes:
    reject_links(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
        raise ManagedCrewError("invalid-file")
    result = path.read_bytes()
    after = path.lstat()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
    if identity(before) != identity(after) or len(result) != before.st_size:
        raise ManagedCrewError("file-changed")
    return result


def sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _resource(relative: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ManagedCrewError("invalid-resource")
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise ManagedCrewError("invalid-resource")
    return HERE / path


def resource_manifest() -> dict:
    manifest = json.loads(read_regular(HERE / "manifest.json", 128 * 1024))
    if not isinstance(manifest, dict) or type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1:
        raise ManagedCrewError("unsupported-resources")
    upstream = manifest.get("upstream", {})
    if upstream.get("version") != "0.12.0" or upstream.get("commit") != UPSTREAM_COMMIT or upstream.get("license") != "Apache-2.0":
        raise ManagedCrewError("unsupported-resources")
    files = manifest.get("files")
    support = manifest.get("supportFiles")
    if not isinstance(files, list) or not isinstance(support, list):
        raise ManagedCrewError("unsupported-resources")
    if len(files) != len(MODULES) or {item.get("module") for item in files} != MODULES:
        raise ManagedCrewError("unsupported-resources")
    if len(support) != len(SUPPORT_FILES) or {item.get("path") for item in support} != SUPPORT_FILES:
        raise ManagedCrewError("unsupported-resources")
    for item in files + support:
        content = read_regular(_resource(item["path"]))
        if sha(content) != item.get("sha256"):
            raise ManagedCrewError("resource-hash-mismatch")
    frontend = manifest.get("frontend", {})
    if frontend.get("asset") != ASSET or frontend.get("path") != "frontend/" + ASSET or frontend.get("sourcePath") != "frontend/useWebSocket.ts":
        raise ManagedCrewError("unsupported-resources")
    if sha(read_regular(_resource(frontend["path"]))) != frontend.get("sha256") or sha(read_regular(_resource(frontend["sourcePath"]))) != frontend.get("sourceSha256"):
        raise ManagedCrewError("resource-hash-mismatch")
    return manifest


def installation_root() -> Path:
    spec = importlib.util.find_spec("kiro_crew")
    if spec is None or not spec.origin:
        raise ManagedCrewError("official-package-unavailable")
    package = Path(spec.origin).resolve().parent
    expected = Path(sys.executable).resolve().parent / "Lib" / "site-packages" / "kiro_crew"
    if package != expected.resolve():
        raise ManagedCrewError("official-interpreter-required")
    metadata = package.parent / "kirocrew-0.12.0.dist-info" / "METADATA"
    if "\nVersion: 0.12.0\n" not in "\n" + read_regular(metadata, 1024 * 1024).decode("utf-8").replace("\r\n", "\n"):
        raise ManagedCrewError("unsupported-client-version")
    return package


def verified_entries(manifest: dict, installed: Path):
    entries = {}
    for item in manifest["files"]:
        name = item["module"]
        relative = name.removeprefix("kiro_crew.").replace(".", "/") + ".py"
        if item["path"] != "patches/kiro_crew/" + relative:
            raise ManagedCrewError("unsupported-resources")
        original = installed / relative
        before = item.get("originalNormalizedSha256")
        if before is None:
            if name != "kiro_crew.dashboard.server_runtime.model_catalog_events" or original.exists():
                raise ManagedCrewError("unsupported-client-source")
            origin = _resource(item["path"])
        else:
            normalized = read_regular(original).decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
            if sha(normalized) != before:
                raise ManagedCrewError("unsupported-client-source")
            origin = original
        source = read_regular(_resource(item["path"]))
        if sha(source) != item["sha256"]:
            raise ManagedCrewError("resource-hash-mismatch")
        compile(source, str(origin), "exec")
        entries[name] = (source, origin)
    frontend = manifest["frontend"]
    dist = installed / "static/dist"
    if sha(read_regular(dist / "assets" / ASSET)) != frontend["originalSha256"]:
        raise ManagedCrewError("unsupported-client-source")
    return entries, dist


class FrozenLoader(importlib.abc.Loader):
    def __init__(self, source, origin):
        self.source, self.origin = source, str(origin)

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        # Keep official relative-resource discovery at the installed package.
        module.__file__ = self.origin
        exec(compile(self.source, self.origin, "exec"), module.__dict__)

    def get_source(self, _fullname):
        return self.source.decode("utf-8")

    def get_filename(self, _fullname):
        return self.origin


class ExactFinder(importlib.abc.MetaPathFinder):
    def __init__(self, entries):
        self.entries = entries

    def find_spec(self, fullname, path=None, target=None):
        entry = self.entries.get(fullname)
        if entry is None:
            return None
        source, origin = entry
        result = importlib.util.spec_from_loader(fullname, FrozenLoader(source, origin), origin=str(origin))
        result.has_location = True
        return result


def verify() -> dict:
    manifest = resource_manifest()
    verified_entries(manifest, installation_root())
    return {"version": "0.12.0", "modules": len(MODULES), "sourceHashesVerified": True}


def install() -> dict:
    manifest = resource_manifest()
    if any(name in sys.modules for name in MODULES):
        raise ManagedCrewError("late-overlay-installation")
    entries, dist = verified_entries(manifest, installation_root())
    replacement = read_regular(_resource(manifest["frontend"]["path"]))
    digest = sha(replacement)
    sys.meta_path.insert(0, ExactFinder(entries))
    server = importlib.import_module("kiro_crew.dashboard.server")
    original_factory = server._dist_file_handler

    def factory(dist_dir, subdir):
        original = original_factory(dist_dir, subdir)
        if subdir != "assets" or Path(dist_dir).resolve() != dist.resolve():
            return original

        async def serve(request):
            response = await original(request)
            if request.method in ("GET", "HEAD") and request.path == "/assets/" + ASSET and request.match_info.get("tail") == ASSET and response.status == 200 and not response.prepared:
                from aiohttp import web
                return web.Response(body=replacement, content_type="application/javascript", headers={
                    "Cache-Control": "no-store", "ETag": '"' + digest + '"'})
            return response
        return serve

    # Existing authenticated routes remain in control; no new route bypasses
    # the original handler, authentication, origin or permission middleware.
    server._dist_file_handler = factory
    return {"version": "0.12.0", "modules": len(entries), "sourceHashesVerified": True}

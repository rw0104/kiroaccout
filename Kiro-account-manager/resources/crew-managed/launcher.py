"""Controlled lifecycle for an independent, access-only Crew workspace.

Only kiroaccout owns this root. The official installation and default Crew/CLI
homes are never changed. Authentication output is confined to the parent pipe.
"""
from __future__ import annotations

import argparse
import contextlib
import ctypes
from ctypes import wintypes
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import runpy
import socket
import struct
import sys
import threading
import time
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("kiroaccout_crew_overlay", HERE / "overlay.py")
overlay = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = overlay
spec.loader.exec_module(overlay)
ManagedCrewError = overlay.ManagedCrewError
MARKER = ".kiroaccout-crew-managed.json"
RUNTIME = ".kiroaccout-runtime.json"
LOCK = ".kiroaccout-launch.lock"
_output = sys.stdout
_output_lock = threading.Lock()
_job_handle = None
# faulthandler and other native diagnostics require a real descriptor. Keep a
# private null device open for the full interpreter lifetime; never hand them
# the parent control pipe or a credential-bearing log destination.
_null_output = open(os.devnull, "wb", buffering=0)


def emit(message):
    with _output_lock:
        try:
            _output.write(json.dumps(message, separators=(",", ":"), ensure_ascii=True) + "\n")
            _output.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass


def canonical_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def context(root_value, owner, session=None):
    path = Path(root_value)
    if not path.is_absolute() or not canonical_uuid(owner) or session is not None and not canonical_uuid(session):
        raise ManagedCrewError("invalid-request")
    overlay.reject_links(path)
    root = path.resolve(strict=True)
    if root.name != "workspace-v1" or root.parent.name != "managed-crew" or any(part.lower() in (".kiro", ".kirocrew", ".aws", "kiro-cli") for part in root.parts):
        raise ManagedCrewError("invalid-workspace")
    marker = json.loads(overlay.read_regular(root / MARKER, 4096))
    if not isinstance(marker, dict) or type(marker.get("schemaVersion")) is not int or marker["schemaVersion"] != 1 or marker.get("ownerId") != owner:
        raise ManagedCrewError("workspace-owner-mismatch")
    paths = {"root": root, "data": root / "data", "home": root / "home", "workspace": root / "workspace", "temp": root / "temp"}
    for candidate in (*paths.values(), root / RUNTIME, root / LOCK):
        overlay.reject_links(candidate)
    return {**paths, "ownerId": owner, "sessionId": session}


def configure_environment(ctx, *, create=False):
    # Preserve execution/locale/proxy configuration, not ambient cloud or model
    # credentials. The manager remains the only source of the projected access.
    allowed = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
               "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"}
    kept = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    home, data, root = ctx["home"], ctx["data"], ctx["root"]
    backend = Path(sys.executable).resolve().parent.parent
    additions = {"HOME": home, "USERPROFILE": home, "APPDATA": home / "AppData/Roaming", "LOCALAPPDATA": home / "AppData/Local",
                 "TEMP": ctx["temp"], "TMP": ctx["temp"], "KIROCREW_HOME": data, "KIROCREW_OS_HOME": home,
                 "KIRO_HOME": data / "kiro", "KIROCREW_WORKSPACE": ctx["workspace"], "KIROCREW_BUNDLED_KAS_DIR": backend / "kas",
                 "KIROCREW_HARNESS_ADOPTION_PINS": root / "no-adoption-pins.json", "XDG_CONFIG_HOME": home / ".config",
                 "XDG_DATA_HOME": home / ".local/share", "AWS_CONFIG_FILE": home / ".aws/config",
                 "AWS_SHARED_CREDENTIALS_FILE": home / ".aws/credentials"}
    directories = [ctx["home"], ctx["data"], ctx["workspace"], ctx["temp"], additions["APPDATA"], additions["LOCALAPPDATA"],
                   additions["KIRO_HOME"], additions["XDG_CONFIG_HOME"], additions["XDG_DATA_HOME"], home / ".aws/sso/cache"]
    for directory in directories:
        overlay.reject_links(directory)
        if create:
            directory.mkdir(parents=True, exist_ok=True)
    os.environ.clear()
    os.environ.update(kept)
    os.environ.update({key: str(value) for key, value in additions.items()})
    os.environ.update({"KIROCREW_SKIP_MODEL_DOWNLOAD": "1", "KIROCREW_SKIP_APP_STORE_FETCH": "1", "PYTHONUNBUFFERED": "1",
                       "PYTHONDONTWRITEBYTECODE": "1", "AWS_EC2_METADATA_DISABLED": "true"})
    if create:
        for key in ("AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"):
            path = Path(os.environ[key])
            overlay.reject_links(path)
            if not path.exists():
                with path.open("x", encoding="utf-8"):
                    pass
        os.chdir(ctx["workspace"])


def pid_exists(pid):
    """A terminated process can briefly deny OpenProcess while a handle remains."""
    class Entry(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("usage", wintypes.DWORD), ("pid", wintypes.DWORD),
                    ("heap", ctypes.c_size_t), ("module", wintypes.DWORD), ("threads", wintypes.DWORD),
                    ("parent", wintypes.DWORD), ("priority", wintypes.LONG), ("flags", wintypes.DWORD),
                    ("exe", wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(Entry))
    kernel.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(Entry))
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    if not handle or handle == ctypes.c_void_p(-1).value:
        raise ManagedCrewError("process-identity-unavailable")
    try:
        row = Entry()
        row.size = ctypes.sizeof(row)
        found = kernel.Process32FirstW(handle, ctypes.byref(row))
        while found:
            if row.pid == pid:
                return True
            found = kernel.Process32NextW(handle, ctypes.byref(row))
        return False
    finally:
        kernel.CloseHandle(handle)


def process_identity(pid):
    if sys.platform != "win32" or type(pid) is not int or pid <= 0:
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.QueryFullProcessImageNameW.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
    kernel.GetProcessTimes.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME))
    handle = kernel.OpenProcess(0x1000 | 0x00100000, False, pid)
    if not handle:
        # ERROR_INVALID_PARAMETER means that this PID no longer exists. Access
        # refusal is not evidence that it stopped.
        if ctypes.get_last_error() == 87 or not pid_exists(pid):
            return None
        raise ManagedCrewError("process-identity-unavailable")
    try:
        # A terminated process may retain a PID and an open handle, even though
        # Windows has already discarded its image name. Test the process object
        # itself first, and repeat the check if it exits during the query.
        def has_exited():
            state = kernel.WaitForSingleObject(handle, 0)
            if state == 0:  # WAIT_OBJECT_0
                return True
            if state == 258:  # WAIT_TIMEOUT; the process is still running
                return False
            raise ManagedCrewError("process-identity-unavailable")

        if has_exited():
            return None
        capacity = wintypes.DWORD(32768)
        path = ctypes.create_unicode_buffer(capacity.value)
        created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(capacity)) or not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)):
            if has_exited():
                return None
            raise ManagedCrewError("process-identity-unavailable")
        if has_exited():
            return None
        return {"pid": pid, "executable": os.path.normcase(str(Path(path.value).resolve())), "creationTime": str((created.dwHighDateTime << 32) | created.dwLowDateTime)}
    finally:
        kernel.CloseHandle(handle)


def contain_process_tree():
    """A process-private Job Object closes every descendant when this host exits."""
    global _job_handle
    if _job_handle is not None:
        return
    if sys.platform != "win32":
        raise ManagedCrewError("unsupported-platform")
    class BasicLimits(ctypes.Structure):
        _fields_ = [("processTime", ctypes.c_int64), ("jobTime", ctypes.c_int64), ("flags", wintypes.DWORD),
                    ("minimum", ctypes.c_size_t), ("maximum", ctypes.c_size_t), ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ("readOps", "writeOps", "otherOps", "readBytes", "writeBytes", "otherBytes")]
    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("io", IoCounters), ("processMemory", ctypes.c_size_t),
                    ("jobMemory", ctypes.c_size_t), ("peakProcessMemory", ctypes.c_size_t), ("peakJobMemory", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        if handle:
            kernel.CloseHandle(handle)
        raise ManagedCrewError("process-containment-unavailable")
    # Non-inheritable and deliberately kept alive until this process exits.
    _job_handle = handle


def terminate_owned(record):
    """Terminate only a still-matching managed host; its Job closes descendants."""
    if record.get("jobOwned") is not True:
        raise ManagedCrewError("process-containment-unavailable")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.OpenProcess(0x1000 | 0x0001 | 0x00100000, False, record["pid"])
    if not handle:
        if process_identity(record["pid"]) is None:
            return
        raise ManagedCrewError("process-stop-unavailable")
    try:
        # The opened process remains the same object even if its PID exits and
        # becomes reusable. Recheck creation/path before acting on that handle.
        if process_identity(record["pid"]) != record["process"]:
            raise ManagedCrewError("runtime-identity-mismatch")
        if not kernel.TerminateProcess(handle, 0):
            raise ManagedCrewError("process-stop-failed")
        if kernel.WaitForSingleObject(handle, 5000) != 0:
            raise ManagedCrewError("process-stop-unconfirmed")
    finally:
        kernel.CloseHandle(handle)


def listener_owned(pid, port):
    if sys.platform != "win32" or type(port) is not int or not 0 < port < 65536:
        return False
    api = ctypes.WinDLL("iphlpapi", use_last_error=True).GetExtendedTcpTable
    api.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG)
    size = wintypes.DWORD()
    code = api(None, ctypes.byref(size), False, 2, 3, 0)
    if code not in (0, 122) or size.value < 4 or size.value > 2 * 1024 * 1024:
        raise ManagedCrewError("listener-identity-unavailable")
    buffer = ctypes.create_string_buffer(size.value)
    if api(buffer, ctypes.byref(size), False, 2, 3, 0) != 0:
        raise ManagedCrewError("listener-identity-unavailable")
    raw = buffer.raw[:size.value]
    count = struct.unpack_from("<I", raw)[0]
    if 4 + count * 24 > len(raw):
        raise ManagedCrewError("listener-identity-unavailable")
    for index in range(count):
        state, address, local_port, _remote, _remote_port, owner = struct.unpack_from("<6I", raw, 4 + index * 24)
        if owner == pid and socket.ntohs(local_port & 0xFFFF) == port and socket.inet_ntoa(struct.pack("<I", address)) == "127.0.0.1":
            return True
    return False


def read_runtime(ctx):
    path = ctx["root"] / RUNTIME
    if not path.exists():
        return None
    value = json.loads(overlay.read_regular(path, 8192))
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1 or value.get("ownerId") != ctx["ownerId"] or not canonical_uuid(value.get("sessionId")) or type(value.get("pid")) is not int or value["pid"] <= 0 or type(value.get("port")) is not int or not 0 <= value["port"] < 65536 or not isinstance(value.get("process"), dict) or value.get("phase") not in ("starting", "ready") or value.get("jobOwned") is not True:
        raise ManagedCrewError("invalid-runtime-record")
    if (value["phase"] == "starting") != (value["port"] == 0):
        raise ManagedCrewError("invalid-runtime-record")
    identity = value["process"]
    if identity.get("pid") != value["pid"] or identity.get("executable") != os.path.normcase(str(Path(sys.executable).resolve())) or not str(identity.get("creationTime", "")).isdigit():
        raise ManagedCrewError("runtime-identity-mismatch")
    return value


def current_runtime(ctx):
    record = read_runtime(ctx)
    if record is None:
        return None
    actual = process_identity(record["pid"])
    if actual is None:
        return None
    if actual != record["process"]:
        # A reused PID is no longer this workspace's child. It must never be
        # contacted or terminated, and its old record can be superseded.
        return None
    return record


def lock_held(ctx):
    path = ctx["root"] / LOCK
    if not path.exists():
        return False
    overlay.reject_links(path)
    if sys.platform != "win32":
        raise ManagedCrewError("unsupported-platform")
    import msvcrt
    with path.open("rb") as stream:
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBRLCK, 1)
        except OSError:
            return True
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
    return False


def status(ctx):
    record = current_runtime(ctx)
    if record is None and lock_held(ctx):
        # The first few instructions between taking the launch lock and atomic
        # publication must never look like an idle target to another app.
        raise ManagedCrewError("workspace-starting")
    result = {"type": "state", "running": record is not None, "ownerId": ctx["ownerId"]}
    if record:
        result.update({key: record[key] for key in ("sessionId", "pid", "port")})
        result["starting"] = record["phase"] == "starting"
    return result


def shutdown(ctx, pid, port, *, require_record=True):
    if type(pid) is not int or type(port) is not int or pid <= 0 or not 0 <= port < 65536:
        raise ManagedCrewError("invalid-request")
    if require_record:
        record = read_runtime(ctx)
        if record is None:
            return
        if record["sessionId"] != ctx["sessionId"] or record["pid"] != pid or record["port"] != port:
            raise ManagedCrewError("runtime-identity-mismatch")
        actual = process_identity(pid)
        if actual is None or actual != record["process"]:
            return
        if record["phase"] == "starting":
            terminate_owned(record)
            return
    if not listener_owned(pid, port):
        raise ManagedCrewError("listener-identity-mismatch")
    from kiro_crew.config.loader_locations import read_local_secret
    secret = read_local_secret(port, "127.0.0.1")
    if not isinstance(secret, str) or not secret:
        raise ManagedCrewError("shutdown-auth-unavailable")
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown", data=b"{}", method="POST", headers={
        "Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}", "X-Local-Secret": secret})
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=8) as response:
            response.read(4096)
            if response.status != 200:
                raise ManagedCrewError("shutdown-rejected")
    except ManagedCrewError:
        raise
    except Exception:
        raise ManagedCrewError("shutdown-failed") from None


@contextlib.contextmanager
def launch_lock(ctx):
    import msvcrt
    path = ctx["root"] / LOCK
    overlay.reject_links(path)
    stream = path.open("a+b")
    try:
        if stream.seek(0, 2) == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise ManagedCrewError("workspace-busy") from None
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        stream.close()


def write_runtime(ctx, pid, port, phase="ready"):
    identity = process_identity(pid)
    if identity is None or identity["executable"] != os.path.normcase(str(Path(sys.executable).resolve())):
        raise ManagedCrewError("process-identity-unavailable")
    record = {"schemaVersion": 1, "ownerId": ctx["ownerId"], "sessionId": ctx["sessionId"], "pid": pid, "port": port,
              "phase": phase, "jobOwned": True, "process": identity}
    target = ctx["root"] / RUNTIME
    overlay.reject_links(target)
    temporary = ctx["root"] / (RUNTIME + "." + ctx["sessionId"] + ".tmp")
    overlay.reject_links(temporary)
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)


class QuietOutput(io.TextIOBase):
    @property
    def encoding(self):
        return "utf-8"

    def write(self, text):
        return len(text)

    def fileno(self):
        return _null_output.fileno()

    def isatty(self):
        return False

    def flush(self):
        pass


class ReadyOutput(QuietOutput):
    def __init__(self, callback):
        self.callback, self.pending = callback, ""

    def write(self, text):
        self.pending += str(text)
        if len(self.pending) > 65536:
            self.pending = ""
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            if line.startswith("KIROCREW_READY:"):
                self.callback(line[len("KIROCREW_READY:"):])
        return len(text)


def detach_control_input():
    """Keep the parent pipe private and leave CRT stdin safe for native DLLs.

    OpenBLAS/libgfortran can inspect fd 0 while importing NumPy on Windows.
    A background read holding that descriptor's CRT lock can deadlock the DLL
    loader. Duplicate the control pipe BEFORE starting its reader, then give
    ordinary stdin NUL. Descendants must never inherit the manager control pipe.
    """
    control_fd = os.dup(0)
    try:
        os.set_inheritable(control_fd, False)
        null_fd = os.open(os.devnull, os.O_RDONLY)
        try:
            os.dup2(null_fd, 0)
        finally:
            os.close(null_fd)
        return os.fdopen(control_fd, "r", encoding="utf-8", errors="strict")
    except BaseException:
        os.close(control_fd)
        raise


def serve_locked(ctx):
    contain_process_tree()
    write_runtime(ctx, os.getpid(), 0, "starting")
    control_input = detach_control_input()
    stopped = threading.Event()
    ready = {}
    stopping = threading.Lock()
    errors = []

    def request_stop():
        stopped.set()
        if not ready:
            emit({"type": "stopped", "sessionId": ctx["sessionId"], "forced": True})
            os._exit(0)  # Closing the current Job kills only this managed tree.
        if not stopping.acquire(blocking=False):
            return
        def finish_deadline():
            emit({"type": "stopped", "sessionId": ctx["sessionId"], "forced": True})
            os._exit(0)
        timer = threading.Timer(15, finish_deadline)
        timer.daemon = True
        timer.start()
        try:
            shutdown(ctx, ready["pid"], ready["port"])
        except ManagedCrewError as error:
            errors.append(str(error))
            emit({"type": "error", "code": str(error)})
        finally:
            stopping.release()

    def on_ready(raw):
        if ready:
            return
        try:
            value = json.loads(raw)
            if type(value.get("pid")) is not int or value["pid"] != os.getpid() or type(value.get("port")) is not int or not 0 < value["port"] < 65536 or Path(value.get("home", "")).resolve() != ctx["data"] or not isinstance(value.get("token"), str) or not 16 <= len(value["token"]) <= 16384 or any(ord(ch) < 32 for ch in value["token"]):
                raise ManagedCrewError("invalid-gateway-ready")
            if not listener_owned(value["pid"], value["port"]):
                raise ManagedCrewError("listener-identity-mismatch")
            write_runtime(ctx, value["pid"], value["port"])
            ready.update({"pid": value["pid"], "port": value["port"]})
            if stopped.is_set():
                threading.Thread(target=request_stop, daemon=True).start()
                return
            emit({"type": "ready", "ownerId": ctx["ownerId"], "sessionId": ctx["sessionId"], "pid": value["pid"], "port": value["port"], "urlToken": value["token"]})
        except Exception:
            errors.append("invalid-gateway-ready")
            emit({"type": "error", "code": "invalid-gateway-ready"})

    def control():
        try:
            while True:
                line = control_input.readline(4097)
                if not line:
                    request_stop()
                    return
                if len(line) > 4096:
                    request_stop()
                    return
                try:
                    message = json.loads(line)
                except ValueError:
                    emit({"type": "error", "code": "invalid-control"})
                    continue
                if message == {"type": "stop"}:
                    request_stop()
                    return
                emit({"type": "error", "code": "invalid-control"})
        except (OSError, ValueError):
            request_stop()

    sys.stdout, sys.stderr = ReadyOutput(on_ready), QuietOutput()
    logging.disable(logging.CRITICAL)
    threading.Thread(target=control, daemon=True).start()
    configure_environment(ctx, create=True)
    from kiro_crew._ssl_compat import _ensure_ssl_certs
    _ensure_ssl_certs()
    overlay.install()
    from kiro_crew.platform_compat import restrict_dir_to_owner
    restrict_dir_to_owner(ctx["root"])
    from kiro_crew.auth.store import TokenStore
    token = TokenStore(ctx["data"]).resolve()
    if token is None or token.refresh_token or token.client_secret or not token.is_usable():
        raise ManagedCrewError("access-only-credential-required")
    sys.argv = ["kiro_crew", "gateway", "--test-mode", "--no-crons", "--no-open", "--no-tunnel", "--port", "auto", "--json-ready"]
    try:
        runpy.run_module("kiro_crew", run_name="__main__")
    except SystemExit as error:
        if error.code not in (0, None) and not stopped.is_set():
            errors.append("gateway-failed")
    finally:
        sys.stdout, sys.stderr = _output, QuietOutput()
    if errors or not ready:
        raise ManagedCrewError("gateway-failed")
    emit({"type": "stopped", "sessionId": ctx["sessionId"]})


def serve(ctx):
    with launch_lock(ctx):
        if current_runtime(ctx):
            raise ManagedCrewError("workspace-running")
        serve_locked(ctx)


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise ManagedCrewError("invalid-request")


def main():
    try:
        parser = Parser(add_help=False)
        parser.add_argument("operation", choices=("serve", "stop", "status", "verify"))
        parser.add_argument("--root", required=True)
        parser.add_argument("--owner", required=True)
        parser.add_argument("--session")
        parser.add_argument("--pid", type=int)
        parser.add_argument("--port", type=int)
        args = parser.parse_args()
        if sys.platform != "win32":
            raise ManagedCrewError("unsupported-platform")
        if args.operation in ("serve", "stop") and not canonical_uuid(args.session):
            raise ManagedCrewError("invalid-request")
        ctx = context(args.root, args.owner, args.session)
        if args.operation == "status":
            emit(status(ctx))
        elif args.operation == "verify":
            configure_environment(ctx)
            emit({"type": "verified", **overlay.verify()})
        elif args.operation == "stop":
            configure_environment(ctx)
            record = current_runtime(ctx)
            if record and (record["sessionId"] != args.session or record["pid"] != args.pid or record["port"] != args.port):
                raise ManagedCrewError("runtime-identity-mismatch")
            if record:
                try:
                    shutdown(ctx, args.pid, args.port)
                except ManagedCrewError:
                    terminate_owned(record)
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline and process_identity(record["pid"]) == record["process"]:
                    time.sleep(0.1)
                if process_identity(record["pid"]) == record["process"]:
                    terminate_owned(record)
            emit({"type": "stopped", "sessionId": args.session})
        else:
            serve(ctx)
        return 0
    except ManagedCrewError as error:
        emit({"type": "error", "code": str(error)})
        return 1
    except BaseException:
        emit({"type": "error", "code": "managed-crew-failed"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

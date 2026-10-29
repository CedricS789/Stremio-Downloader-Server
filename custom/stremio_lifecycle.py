"""Start CrossWatch + Nuvi-Flow with Stremio; drain active downloads/syncs safely before stopping."""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import http.cookiejar
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
STATUS = ROOT / "lifecycle-status.json"
CONFIG = ROOT / "lifecycle-settings.json"
TEMP = ROOT / ".tmp"
LOG = logging.getLogger("stremio-lifecycle")


def to_wsl_path(path: Path) -> str:
    r"""Convert a Windows Path to its WSL equivalent (e.g. C:\Dir -> /mnt/c/Dir)."""
    p = path.resolve()
    drive = p.drive.rstrip(":").lower()
    if drive:
        rest = p.as_posix().split(":", 1)[-1]
        return f"/mnt/{drive}{rest}"
    return p.as_posix()



def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default


def save_status(**fields):
    TEMP.mkdir(exist_ok=True)
    fields["checkedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    draft = TEMP / "lifecycle-status.json.tmp"
    draft.write_text(json.dumps(fields, indent=2), encoding="utf-8")
    os.replace(draft, STATUS)


def command(args, timeout=30, check=True):
    result = subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if check and result.returncode:
        raise RuntimeError("Local command failed")
    return result


def stremio_running():
    """Observe the desktop app in our session, excluding its background runtime."""
    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
        ]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    my_session = wintypes.DWORD()
    if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(my_session)):
        raise ctypes.WinError(ctypes.get_last_error())
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        row = ProcessEntry()
        row.dwSize = ctypes.sizeof(row)
        more = kernel.Process32FirstW(snapshot, ctypes.byref(row))
        while more:
            if row.szExeFile.lower() in {"stremio-shell-ng.exe", "stremio.exe"}:
                session = wintypes.DWORD()
                if kernel.ProcessIdToSessionId(row.th32ProcessID, ctypes.byref(session)):
                    if session.value == my_session.value:
                        return True
            more = kernel.Process32NextW(snapshot, ctypes.byref(row))
        return False
    finally:
        kernel.CloseHandle(snapshot)


class Api:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

    def request(self, url, body=None, method=None, headers=None, as_json=True, timeout=12):
        headers = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        with self.opener.open(request, timeout=timeout) as response:
            content = response.read().decode("utf-8")
        return json.loads(content) if as_json and content else content


def inspect_work():
    """Check active Nuvi-Flow manual downloads/scans and CrossWatch tracker sync."""
    private = load_json(ROOT / "private-settings.json")
    snapshot = {"downloads": 0, "importQueue": 0, "commands": 0,
                "syncRunning": False, "scanning": False, "libraryProblems": 0}
    api = Api()
    dl_status = api.request("http://127.0.0.1:60500/downloads/status")
    if not isinstance(dl_status, dict) or "activeDownloads" not in dl_status:
        raise ValueError("Invalid download status response")
    snapshot["downloads"] = int(dl_status["activeDownloads"])

    health = api.request("http://127.0.0.1:60500/health")
    if health.get("status") != "ok" or "scanning" not in health:
        raise ValueError("Library service is not healthy")
    snapshot["scanning"] = bool(health["scanning"])
    library = health["library"]
    snapshot["libraryProblems"] = max(0, int(library["files"]) - int(library["matched"])) + int(library["errors"])
    return snapshot


def pending(snapshot):
    return any(snapshot[key] for key in (
        "downloads", "importQueue", "commands", "syncRunning", "scanning", "libraryProblems",
    ))


class DrainGate:
    """Require a final scan and a continuous quiet period, not a time-based cutoff."""
    def __init__(self, quiet_seconds):
        self.quiet_seconds = quiet_seconds
        self.idle_since = None
        self.scan_requested = False

    def reset(self):
        self.idle_since = None
        self.scan_requested = False

    def observe(self, snapshot, now):
        if pending(snapshot):
            self.idle_since = None
            if any(snapshot[k] for k in ("downloads", "importQueue", "commands", "syncRunning")):
                self.scan_requested = False
            return "wait"
        if not self.scan_requested:
            return "scan"
        if self.idle_since is None:
            self.idle_since = now
        return "stop" if now - self.idle_since >= self.quiet_seconds else "wait"


def final_scan():
    env = dict(line.split("=", 1) for line in (ROOT / ".env").read_text().splitlines()
               if "=" in line and not line.startswith("#"))
    api = Api()
    base = "http://127.0.0.1:60500"
    api.request(base + "/admin/login", {"username": "admin", "password": env["NUVI_ADMIN_PASSWORD"]},
                as_json=False)
    html = api.request(base + "/admin", as_json=False)
    token = re.search(r'name="csrf-token" content="([^"]+)"', html)
    if not token:
        raise ValueError("Missing library scan authorization")
    api.request(base + "/admin/api/scan", {"mode": "full"}, headers={"X-CSRF-Token": token[1]})


def sync_and_refresh():
    """CrossWatch runs and schedules synchronization independently on the home server."""
    LOG.info("Tracker synchronization is managed by the home server")


class Controller:
    def __init__(self, settings):
        self.settings = settings
        self.use_wsl = bool(settings.get("useWsl", False))
        self.wsl_distro = settings.get("wslDistro", "Ubuntu-24.04")
        self.docker = settings.get("dockerExecutable", "docker")
        self.wsl_holder = None
        self.wsl_work_dir = settings.get("wslWorkDir") or to_wsl_path(ROOT)
        if self.use_wsl:
            self.compose = ["wsl.exe", "-d", self.wsl_distro, "--", "bash", "-c",
                            f"cd '{self.wsl_work_dir}' && docker compose"]
        else:
            self.compose = [self.docker, "compose", "-f", str(ROOT / "compose.yaml")]

    def engine_ready(self):
        try:
            if self.use_wsl:
                return command(["wsl.exe", "-d", self.wsl_distro, "--", "docker", "info", "--format", "{{.ServerVersion}}"],
                               timeout=10, check=False).returncode == 0
            return command([self.docker, "info", "--format", "{{.ServerVersion}}"], timeout=10,
                           check=False).returncode == 0
        except subprocess.TimeoutExpired:
            return False

    def running_services(self):
        if not self.engine_ready():
            return set()
        if self.use_wsl:
            result = command(["wsl.exe", "-d", self.wsl_distro, "--", "bash", "-c",
                              f"cd '{self.wsl_work_dir}' && docker compose ps --status running --services"])
            return set(result.stdout.split())
        result = command(self.compose + ["ps", "--status", "running", "--services"])
        return set(result.stdout.split())

    def start(self):
        if not self.engine_ready():
            if self.use_wsl:
                LOG.info("Starting WSL Docker daemon for Stremio")
                command(["wsl.exe", "-d", self.wsl_distro, "-u", "root", "--", "systemctl", "start", "docker"], timeout=30)
            else:
                LOG.info("Starting Docker Desktop for Stremio")
                startup = subprocess.STARTUPINFO()
                startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startup.wShowWindow = 0
                subprocess.Popen([self.settings["dockerDesktopExecutable"]], startupinfo=startup,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 180
            while not self.engine_ready():
                if time.monotonic() > deadline:
                    raise TimeoutError("Docker startup timed out")
                time.sleep(3)
        if self.use_wsl:
            if self.wsl_holder is None or self.wsl_holder.poll() is not None:
                self.wsl_holder = subprocess.Popen(
                    ["wsl.exe", "-d", self.wsl_distro, "--", "sleep", "infinity"],
                    creationflags=subprocess.CREATE_NO_WINDOW,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            command(["wsl.exe", "-d", self.wsl_distro, "--", "bash", "-c",
                     f"cd '{self.wsl_work_dir}' && docker compose up -d --no-build --pull never"], timeout=180)
        else:
            command(self.compose + ["up", "-d", "--no-build", "--pull", "never"], timeout=180)
        LOG.info("Media services started")

    def stop(self):
        if self.use_wsl:
            command(["wsl.exe", "-d", self.wsl_distro, "--", "bash", "-c",
                     f"cd '{self.wsl_work_dir}' && docker compose stop --timeout 60"], timeout=150)
            if self.wsl_holder and self.wsl_holder.poll() is None:
                self.wsl_holder.terminate()
                self.wsl_holder = None
        else:
            command(self.compose + ["stop", "--timeout", "60"], timeout=150)
        LOG.info("Media services stopped after all work completed")
        if stremio_running():
            self.start()
            LOG.info("Stremio reopened during shutdown; services restarted")
            return False
        if self.settings.get("stopDockerWhenUnused", True):
            if self.use_wsl:
                others = command(["wsl.exe", "-d", self.wsl_distro, "--", "docker", "ps", "-q"]).stdout.strip()
                if not others:
                    command(["wsl.exe", "-d", self.wsl_distro, "-u", "root", "--", "systemctl", "stop", "docker"], timeout=60)
                    LOG.info("WSL Docker stopped; no other containers were running")
                else:
                    LOG.info("WSL Docker kept running for other containers")
            else:
                others = command([self.docker, "ps", "-q"]).stdout.strip()
                if not others:
                    command([self.docker, "desktop", "stop", "--timeout", "90"], timeout=100)
                    LOG.info("Docker Desktop stopped; no other containers were running")
                else:
                    LOG.info("Docker Desktop kept running for other containers")
        return True


def keep_awake(enabled):
    flags = 0x80000000 | (0x00000001 if enabled else 0)
    ctypes.windll.kernel32.SetThreadExecutionState(flags)


def run_monitor(settings):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    mutex = kernel.CreateMutexW(None, False, "Local\\StremioAutomationLifecycle")
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        return
    controller = Controller(settings)
    previous = load_json(STATUS, {})
    engaged = previous.get("phase") in {"watching", "starting", "draining", "waiting", "checking", "error"}
    gate = DrainGate(settings.get("quietSeconds", 90))
    ready = False
    refreshed = False
    last_phase = None
    last_inspection = 0.0
    last_sync = time.monotonic()
    last_dl_trigger = 0
    inspect_every = settings.get("drainCheckSeconds", 15)
    LOG.info("Stremio lifecycle watcher started")
    try:
        if not engaged and not stremio_running():
            engaged = bool(controller.running_services())
        while not (ROOT / "lifecycle.disabled").exists():
            try:
                opened = stremio_running()
                if opened or engaged:
                    if not ready:
                        save_status(phase="starting", stremioOpen=opened, message="Starting local services")
                        controller.start()
                        ready = True
                        engaged = True
                        refreshed = False
                    if opened:
                        gate.reset()
                        keep_awake(False)
                        phase = "watching"
                        if phase != last_phase:
                            save_status(phase=phase, stremioOpen=True, message="Services active while Stremio is open")
                            LOG.info("Stremio is open; services remain active")
                        if time.monotonic() - last_sync >= settings.get("librarySyncSeconds", 3600):
                            sync_and_refresh()
                            last_sync = time.monotonic()
                        try:
                            dl_info = Api().request("http://127.0.0.1:60500/downloads/status", timeout=3)
                            trig = int(dl_info.get("lastDownloadTriggeredAt") or 0)
                            if last_dl_trigger == 0:
                                last_dl_trigger = trig or -1
                            elif trig > 0 and trig != last_dl_trigger:
                                last_dl_trigger = trig
                                prompt_url = str(dl_info.get("promptUrl") or "http://127.0.0.1:60500/downloads")
                                os.startfile(prompt_url)
                        except Exception:
                            pass
                        refreshed = False
                    else:
                        phase = "draining"
                        if settings.get("preventSleepWhileDraining", True):
                            keep_awake(True)
                        if not refreshed:
                            sync_and_refresh()
                            refreshed = True
                        if time.monotonic() - last_inspection >= inspect_every:
                            last_inspection = time.monotonic()
                            snapshot = inspect_work()
                            action = gate.observe(snapshot, last_inspection)
                            save_status(phase=phase, stremioOpen=False, pending=snapshot,
                                        message="Waiting for active downloads, tracker sync and final library scan")
                            if action == "scan":
                                final_scan()
                                gate.scan_requested = True
                                LOG.info("Queues empty; requested final local library scan")
                            elif action == "stop":
                                if not stremio_running() and not pending(inspect_work()):
                                    stopped = controller.stop()
                                    ready = not stopped
                                    engaged = not stopped
                                    gate.reset()
                                    keep_awake(False)
                                    phase = "idle" if stopped else "watching"
                                    save_status(phase=phase, stremioOpen=not stopped,
                                                message="Stopped after verified completion" if stopped else "Stremio reopened; services active")
                                else:
                                    gate.reset()
                    last_phase = phase
                else:
                    keep_awake(False)
                    if last_phase != "idle":
                        save_status(phase="idle", stremioOpen=False, message="Waiting for Stremio")
                        last_phase = "idle"
                time.sleep(settings.get("pollSeconds", 5))
            except Exception as error:
                gate.reset()
                save_status(phase="error", stremioOpen=stremio_running(),
                            message="Completion could not be verified; services kept running",
                            errorType=type(error).__name__)
                LOG.warning("Keeping services running because a check failed (%s)", type(error).__name__)
                ready = False
                time.sleep(15)
    finally:
        keep_awake(False)
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle(mutex)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true", help="Read-only live completion check")
    args = parser.parse_args()
    default_settings = {
        "useWsl": True,
        "wslDistro": "Ubuntu-24.04",
        "dockerExecutable": "wsl.exe",
        "pollSeconds": 2,
        "drainCheckSeconds": 15,
        "quietSeconds": 90,
        "librarySyncSeconds": 3600,
        "stopDockerWhenUnused": False,
        "preventSleepWhileDraining": True,
    }
    loaded = load_json(CONFIG)
    settings = {**default_settings, **(loaded or {})}
    if args.probe:
        work = inspect_work()
        print(json.dumps({"stremioOpen": stremio_running(), "pending": work,
                          "allWorkComplete": not pending(work)}, indent=2))
        return
    (ROOT / "logs").mkdir(exist_ok=True)
    handler = RotatingFileHandler(ROOT / "logs" / "lifecycle.log", maxBytes=500_000, backupCount=2)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    run_monitor(settings)


if __name__ == "__main__":
    main()

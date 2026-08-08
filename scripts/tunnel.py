#!/usr/bin/env python3
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DISCOVERY_PATH = ROOT / "api.json"
LOCAL_BASE = f"http://{os.getenv('GDBGC_HOST', '127.0.0.1')}:{os.getenv('GDBGC_PORT', '4317')}"
TUNNEL_PATTERN = re.compile(r"https://[a-zA-Z0-9.-]+\.trycloudflare\.com")
STOPPING = False
BACKEND = None
TUNNEL = None


def run(*args, check=True, quiet=False):
    return subprocess.run(args, cwd=ROOT, check=check, text=True, stdout=subprocess.DEVNULL if quiet else None)


def wait_for_health(url, timeout):
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=4) as response:
                if response.status == 200:
                    return
        except Exception as error:
            last_error = str(error)
        time.sleep(0.6)
    raise RuntimeError(f"Health check failed for {url}: {last_error}")


def write_discovery(online, api_base=""):
    DISCOVERY_PATH.write_text(json.dumps({
        "online": online,
        "apiBase": api_base,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }, indent=2) + "\n", encoding="utf-8")


def publish(message):
    run("git", "add", "api.json")
    changed = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode != 0
    if not changed:
        return
    run("git", "commit", "-m", message)
    run("git", "push", "origin", "main")


def stream_tunnel(process, url_queue, log_path):
    with log_path.open("a", encoding="utf-8") as log:
        for line in process.stdout:
            log.write(line)
            log.flush()
            match = TUNNEL_PATTERN.search(line)
            if match:
                url_queue.put(match.group(0))


def stop_process(process, timeout=8):
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def shutdown(signum=None, frame=None):
    global STOPPING
    if STOPPING:
        return
    STOPPING = True
    print("Stopping GDBGC Quiz…", flush=True)
    stop_process(TUNNEL)
    stop_process(BACKEND)
    try:
        write_discovery(False)
        publish("site: mark WSL quiz backend offline")
    except Exception as error:
        print(f"Could not publish offline state: {error}", file=sys.stderr, flush=True)
    try:
        (DATA_DIR / "tunnel.pid").unlink(missing_ok=True)
    finally:
        raise SystemExit(0)


def main():
    global BACKEND, TUNNEL
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "tunnel.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    backend_log = (DATA_DIR / "backend.log").open("a", encoding="utf-8")
    BACKEND = subprocess.Popen([sys.executable, "backend/server.py"], cwd=ROOT, stdout=backend_log, stderr=subprocess.STDOUT)
    wait_for_health(LOCAL_BASE, 20)

    url_queue = queue.Queue()
    TUNNEL = subprocess.Popen(
        ["cloudflared", "tunnel", "--no-autoupdate", "--url", LOCAL_BASE],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    threading.Thread(target=stream_tunnel, args=(TUNNEL, url_queue, DATA_DIR / "cloudflared.log"), daemon=True).start()
    try:
        public_url = url_queue.get(timeout=60)
    except queue.Empty as error:
        raise RuntimeError("Timed out waiting for a Cloudflare Quick Tunnel URL") from error
    wait_for_health(public_url, 70)
    write_discovery(True, public_url)
    publish("site: publish live WSL quiz backend")
    print(f"GDBGC Quiz is online:\n  App: https://tfjk2114.github.io/GDBGC-QUIZ/\n  API: {public_url}", flush=True)

    while not STOPPING:
        if BACKEND.poll() is not None:
            raise RuntimeError(f"Backend exited with status {BACKEND.returncode}")
        if TUNNEL.poll() is not None:
            raise RuntimeError(f"cloudflared exited with status {TUNNEL.returncode}")
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        shutdown()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        if not STOPPING:
            stop_process(TUNNEL)
            stop_process(BACKEND)
        raise

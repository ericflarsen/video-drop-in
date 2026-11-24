#!/usr/bin/env python3
"""Family call pages, WebRTC signaling, and Fire TV ADB orchestration."""

from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import os
import secrets
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parent
OPTIONS_PATH = Path("/data/options.json")
OPTIONS = json.loads(OPTIONS_PATH.read_text()) if OPTIONS_PATH.exists() else {}
ROOM = secrets.token_urlsafe(18)
TV_ADB = OPTIONS.get("tv_adb", "").strip()
PORT = 8765
LOCK = threading.Lock()
ADB_LOCK = threading.Lock()
QUEUES = defaultdict(lambda: {"caller": [], "tv": [], "mom": []})


def adb(*args, timeout=20):
    """Run ADB with persistent home storage for its host key."""
    env = os.environ.copy()
    env["HOME"] = "/config"
    Path("/config/.android").mkdir(parents=True, exist_ok=True)
    return subprocess.run(
        ["adb", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        check=False,
    )


def adb_device(*args):
    result = adb("-s", TV_ADB, *args)
    if result.returncode:
        detail = (result.stderr or result.stdout or "ADB command failed").strip()
        if "unauthorized" in detail.lower():
            raise RuntimeError(
                "Fire TV has not authorized this app's ADB key yet. "
                "Wake the TV with its remote, accept the ADB prompt, then retry."
            )
        raise RuntimeError(detail)
    return result


def prepare_tv():
    """Connect ADB, establish TV-local receiver routing, wake, and open Silk."""
    if not TV_ADB:
        raise RuntimeError("Set the Fire TV ADB address in Video Drop In app configuration.")
    with ADB_LOCK:
        connection = adb("connect", TV_ADB, timeout=15)
        if connection.returncode:
            raise RuntimeError((connection.stderr or connection.stdout).strip())

        state = adb("-s", TV_ADB, "get-state")
        current_state = state.stdout.strip()
        if state.returncode or current_state != "device":
            detail = (state.stderr or current_state or "unknown").strip()
            if "unauthorized" in detail.lower():
                raise RuntimeError(
                    "Fire TV has not authorized this app's ADB key yet. "
                    "Wake the TV with its remote, accept the ADB prompt, then retry."
                )
            raise RuntimeError(f"Fire TV ADB state is {detail}.")

        adb_device("reverse", f"tcp:{PORT}", f"tcp:{PORT}")
        adb_device("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        receiver_url = f"http://localhost:{PORT}/tv?room={ROOM}"
        adb_device(
            "shell", "am", "start", "-a", "android.intent.action.VIEW",
            "-d", receiver_url,
        )
        # A full-screen button overlay receives this simulated user gesture.
        time.sleep(5)
        adb_device("shell", "input", "tap", "280", "616")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Never log query strings; they contain the per-run room token.
        print(f"{self.client_address[0]} {self.command} {urlparse(self.path).path}", flush=True)

    def send_headers(self, status, content_type, length):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; media-src 'self' blob:; connect-src 'self'",
        )
        self.send_header("Permissions-Policy", "camera=(self), microphone=(self)")
        self.send_header("Content-Length", str(length))
        self.end_headers()

    def send_json(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_headers(status, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)

    def read_json(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size < 1 or size > 262144:
            raise ValueError("invalid request size")
        return json.loads(self.rfile.read(size))

    def serve_page(self, role):
        if role == "tv":
            query = parse_qs(urlparse(self.path).query)
            if query.get("room", [""])[0] != ROOM:
                return self.send_json({"error": "unknown room"}, 403)
        body = (ROOT / "index.html").read_text().replace("__ROOM__", ROOM).encode()
        self.send_headers(200, "text/html; charset=utf-8", len(body))
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            return self.send_json({"ok": True})
        static_files = {"/style.css": ("style.css", "text/css; charset=utf-8"),
                        "/app.js": ("app.js", "text/javascript; charset=utf-8")}
        if parsed.path in static_files:
            filename, content_type = static_files[parsed.path]
            body = (ROOT / filename).read_bytes()
            self.send_headers(200, content_type, len(body))
            self.wfile.write(body)
            return
        if parsed.path in ("/", "/caller"):
            return self.serve_page("caller")
        if parsed.path == "/tv":
            return self.serve_page("tv")
        if parsed.path == "/mom":
            return self.serve_page("mom")
        if parsed.path == "/api/poll":
            query = parse_qs(parsed.query)
            peer = query.get("peer", [""])[0]
            if query.get("room", [""])[0] != ROOM or peer not in ("caller", "tv", "mom"):
                return self.send_json({"error": "unknown room or peer"}, 403)
            with LOCK:
                messages = QUEUES[ROOM][peer]
                QUEUES[ROOM][peer] = []
            return self.send_json({"messages": messages})
        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/send", "/api/prepare-tv", "/api/play-tv"):
            return self.send_json({"error": "not found"}, 404)
        try:
            data = self.read_json()
        except (ValueError, json.JSONDecodeError):
            return self.send_json({"error": "invalid JSON"}, 400)
        if data.get("room") != ROOM:
            return self.send_json({"error": "unknown room"}, 403)

        if path == "/api/prepare-tv":
            try:
                prepare_tv()
                return self.send_json({"ok": True, "tv": "awake; Silk receiver opened"})
            except (RuntimeError, subprocess.TimeoutExpired, FileNotFoundError) as error:
                return self.send_json({"error": str(error)}, 502)

        if path == "/api/play-tv":
            try:
                with ADB_LOCK:
                    time.sleep(0.5)
                    adb_device("shell", "input", "tap", "960", "540")
                return self.send_json({"ok": True})
            except (RuntimeError, subprocess.TimeoutExpired, FileNotFoundError) as error:
                return self.send_json({"error": str(error)}, 502)

        if data.get("to") not in ("caller", "tv", "mom") or not isinstance(data.get("message"), dict):
            return self.send_json({"error": "invalid signaling message"}, 400)
        with LOCK:
            if data["to"] == "caller" and data["message"].get("type") == "join":
                # A newly opened or refreshed Mom page requests a fresh offer; discard stale messages.
                QUEUES[ROOM]["mom"] = []
                QUEUES[ROOM]["caller"] = [
                    item for item in QUEUES[ROOM]["caller"]
                    if item.get("channel") != "mom" and item.get("type") != "join"
                ]
            QUEUES[ROOM][data["to"]].append(data["message"])
        return self.send_json({"ok": True})


if __name__ == "__main__":
    os.environ["HOME"] = "/config"
    Path("/config/.android").mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Video Drop In is listening on the home network.")
    print(f"Caller page: http://<home-assistant-address>:{PORT}/")
    print(f"Fire TV ADB target: {TV_ADB}")
    print("Video and audio are exchanged directly between browsers.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

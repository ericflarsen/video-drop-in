#!/usr/bin/env python3
"""Family call pages, WebRTC signaling, and Fire TV ADB orchestration."""

from collections import defaultdict, deque
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen
import hashlib
import hmac
import re
import json
import os
import secrets
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("VDI_DATA", "/data"))
CONFIG = Path(os.environ.get("VDI_CONFIG", "/config"))
OPTIONS_PATH = DATA / "options.json"
OPTIONS = json.loads(OPTIONS_PATH.read_text()) if OPTIONS_PATH.exists() else {}
PORT = int(os.environ.get("VDI_PORT", "8765"))

TV_ADB = str(OPTIONS.get("tv_adb", "")).strip()
PASSPHRASE = str(OPTIONS.get("family_passphrase", "")).strip()
QUIET_START = str(OPTIONS.get("quiet_start", "22:00")).strip()
QUIET_END = str(OPTIONS.get("quiet_end", "08:00")).strip()
MAX_WAKES_PER_HOUR = int(OPTIONS.get("max_wakes_per_hour", 3))

# Per-run token for the TV only. It reaches the TV through the ADB intent and is
# never put in a page served to the public.
ROOM = secrets.token_urlsafe(18)

LOCK = threading.Lock()
ADB_LOCK = threading.Lock()
LIMIT_LOCK = threading.Lock()
QUEUES = defaultdict(list)  # "tv", "mom", or a caller's page id -> pending messages
MAX_CALLERS = 4
STALE_SECONDS = 45          # a caller page that stops polling this long has left
MAX_QUEUE = 300
CALL = {"active": False, "starting": False, "callers": {}}  # id -> {"name", "seen"}
PEER_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

YEAR = 365 * 24 * 3600
HOUR = 3600
GLOBAL_FAIL_LIMIT = 10      # wrong passphrases or bad Mom links per hour, all visitors
PER_VISITOR_FAIL_LIMIT = 5  # per visitor, when the relay tells us who the visitor is
FAILS_ALL = deque()
FAILS_BY_VISITOR = defaultdict(deque)
WAKES = deque()
LOCKOUT_NOTIFIED_AT = 0.0
FORWARDING_REPORTED = False


def load_secret(name, size=32):
    """A random value kept in the app's private data folder across restarts."""
    path = DATA / name
    try:
        value = path.read_text().strip()
        if value:
            return value
    except FileNotFoundError:
        pass
    value = secrets.token_urlsafe(size)
    DATA.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    path.chmod(0o600)
    return value


SIGNING_KEY = load_secret("signing.key").encode()
MOM_KEY = load_secret("mom_link.key", 24)


def sign(label):
    return hmac.new(SIGNING_KEY, label.encode(), hashlib.sha256).hexdigest()


def family_token():
    # Includes the passphrase, so changing it signs every family device out.
    return sign("family|" + PASSPHRASE) if PASSPHRASE else None


def mom_token():
    return sign("mom|" + MOM_KEY)


def prune(window, now, seconds=HOUR):
    while window and now - window[0] > seconds:
        window.popleft()


def notify(title, message):
    """Show a Home Assistant notification. Best effort; never blocks a call."""
    token = os.environ.get("SUPERVISOR_TOKEN")
    print(f"NOTICE: {title}: {message}", flush=True)
    if not token:
        return

    def post():
        try:
            request = Request(
                "http://supervisor/core/api/services/persistent_notification/create",
                data=json.dumps({"title": title, "message": message}).encode(),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                method="POST",
            )
            urlopen(request, timeout=10).close()
        except Exception as error:  # noqa: BLE001
            print(f"Could not send Home Assistant notification: {error}", flush=True)

    threading.Thread(target=post, daemon=True).start()


def local_now():
    tz = os.environ.get("TZ")
    if tz:
        try:
            from zoneinfo import ZoneInfo
            return datetime.now(ZoneInfo(tz))
        except Exception:  # noqa: BLE001
            pass
    return datetime.now()


def minutes(hhmm):
    hours, mins = hhmm.split(":")
    return int(hours) * 60 + int(mins)


def in_quiet_hours():
    try:
        start, end = minutes(QUIET_START), minutes(QUIET_END)
    except ValueError:
        return False
    if start == end:
        return False
    now = local_now()
    current = now.hour * 60 + now.minute
    return start <= current < end if start < end else current >= start or current < end


def roster():
    return [{"id": cid, "name": info["name"]} for cid, info in CALL["callers"].items()]


def push(key, message):
    queue = QUEUES[key]
    queue.append(message)
    del queue[:-MAX_QUEUE]


def push_roster():
    message = {"type": "roster", "callers": roster()}
    for key in ("tv", "mom", *CALL["callers"]):
        push(key, dict(message))


def remove_caller(cid):
    """Call with LOCK held. Ends the call when the last caller leaves."""
    if cid not in CALL["callers"]:
        return
    del CALL["callers"][cid]
    QUEUES.pop(cid, None)
    for key in ("tv", "mom", *CALL["callers"]):
        push(key, {"type": "left", "from": cid})
    if CALL["callers"]:
        push_roster()
    else:
        CALL["active"] = False
        QUEUES["tv"] = [{"type": "hangup"}]
        QUEUES["mom"] = [{"type": "roster", "callers": []}, {"type": "hangup"}]
        print("Call ended.", flush=True)


def sweep():
    """Call with LOCK held."""
    now = time.time()
    for cid, info in list(CALL["callers"].items()):
        if now - info["seen"] > STALE_SECONDS:
            print(f"{info['name'] or 'A caller'} stopped responding and was removed.", flush=True)
            remove_caller(cid)


def add_caller(cid, name):
    """Call with LOCK held."""
    CALL["callers"][cid] = {"name": name or "Family", "seen": time.time()}
    push_roster()


def adb(*args, timeout=20):
    """Run ADB with persistent home storage for its host key."""
    env = os.environ.copy()
    env["HOME"] = str(CONFIG)
    (CONFIG / ".android").mkdir(parents=True, exist_ok=True)
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
    if os.environ.get("VDI_FAKE_TV") == "1":
        # Local testing only: no ADB, just print where a receiver page would open.
        print(f"FAKE TV: receiver at http://localhost:{PORT}/tv?room={ROOM}", flush=True)
        return
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
        # Never log query strings or Mom's link key.
        path = urlparse(self.path).path
        if path.startswith("/mom/"):
            path = "/mom/<link>"
        print(f"{self.visitor() or self.client_address[0]} {self.command} {path}", flush=True)

    # ---------- who is asking ----------

    def visitor(self):
        """The real visitor address, only when it came from the local relay."""
        global FORWARDING_REPORTED
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return self.client_address[0]
        # The last entry is the one our relay's proxy added; earlier ones can be faked.
        forwarded = self.headers.get("X-Forwarded-For", "").split(",")[-1].strip()
        if not FORWARDING_REPORTED and forwarded:
            FORWARDING_REPORTED = True
            print("Relay passes visitor addresses; per-visitor limits are active.", flush=True)
        return forwarded or None

    def cookies(self):
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except Exception:  # noqa: BLE001
            return {}
        return {key: morsel.value for key, morsel in jar.items()}

    def roles(self, room=""):
        """Which pages this request may act as."""
        jar = self.cookies()
        roles = set()
        family = family_token()
        if family and hmac.compare_digest(jar.get("vdi_family", ""), family):
            roles.update(("caller", "mom"))  # family may open Mom's page to test it
        if hmac.compare_digest(jar.get("vdi_mom", ""), mom_token()):
            roles.add("mom")
        if room and hmac.compare_digest(room, ROOM):
            roles.add("tv")
        return roles

    def caller_name(self):
        name = unquote(self.cookies().get("vdi_name", "")).strip()
        return " ".join(name.split())[:40]

    # ---------- attempt limiting ----------

    def locked_out(self):
        now = time.time()
        who = self.visitor()
        with LIMIT_LOCK:
            prune(FAILS_ALL, now)
            if len(FAILS_ALL) >= GLOBAL_FAIL_LIMIT:
                return True
            if who:
                prune(FAILS_BY_VISITOR[who], now)
                if len(FAILS_BY_VISITOR[who]) >= PER_VISITOR_FAIL_LIMIT:
                    return True
        return False

    def record_failure(self, what):
        global LOCKOUT_NOTIFIED_AT
        now = time.time()
        who = self.visitor()
        with LIMIT_LOCK:
            FAILS_ALL.append(now)
            prune(FAILS_ALL, now)
            count = len(FAILS_ALL)
            if who:
                FAILS_BY_VISITOR[who].append(now)
            notify_now = count >= GLOBAL_FAIL_LIMIT and now - LOCKOUT_NOTIFIED_AT > HOUR
            if notify_now:
                LOCKOUT_NOTIFIED_AT = now
        print(f"Failed {what} from {who or 'unknown visitor'} ({count} in the last hour)", flush=True)
        if notify_now:
            notify(
                "Video Drop In: sign-in locked",
                f"{count} wrong passphrases or bad Mom links in the last hour. New devices "
                "cannot sign in for an hour. Devices already signed in are not affected.",
            )
        # Each wrong try answers more slowly: 1, 2, 4, then 8 seconds.
        time.sleep(min(8, 2 ** max(0, count - 1)))

    # ---------- responses ----------

    def send_headers(self, status, content_type, length, extra=()):
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
        for name, value in extra:
            self.send_header(name, value)
        self.send_header("Content-Length", str(length))
        self.end_headers()

    def send_json(self, value, status=200, extra=()):
        body = json.dumps(value).encode()
        self.send_headers(status, "application/json; charset=utf-8", len(body), extra)
        self.wfile.write(body)

    def read_json(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size < 1 or size > 262144:
            raise ValueError("invalid request size")
        return json.loads(self.rfile.read(size))

    @staticmethod
    def cookie(name, value, http_only=True):
        parts = [f"{name}={value}", "Path=/", f"Max-Age={YEAR}", "Secure", "SameSite=Lax"]
        if http_only:
            parts.append("HttpOnly")
        return ("Set-Cookie", "; ".join(parts))

    def serve_page(self, view, room=""):
        body = (
            (ROOT / "index.html").read_text()
            .replace("__ROOM__", room)
            .replace("__VIEW__", view)
            .encode()
        )
        self.send_headers(200, "text/html; charset=utf-8", len(body))
        self.wfile.write(body)

    # ---------- routes ----------

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/healthz":
            return self.send_json({"ok": True})
        static_files = {
            "/style.css": ("style.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "text/javascript; charset=utf-8"),
            "/mom.webmanifest": ("mom.webmanifest", "application/manifest+json; charset=utf-8"),
            "/icon-192.png": ("icon-192.png", "image/png"),
            "/icon-512.png": ("icon-512.png", "image/png"),
        }
        if parsed.path in static_files:
            filename, content_type = static_files[parsed.path]
            body = (ROOT / filename).read_bytes()
            self.send_headers(200, content_type, len(body))
            self.wfile.write(body)
            return

        if parsed.path in ("/", "/caller"):
            if not PASSPHRASE:
                return self.serve_page("setup")
            return self.serve_page("caller" if "caller" in self.roles() else "login")

        if parsed.path == "/tv":
            room = query.get("room", [""])[0]
            if "tv" not in self.roles(room):
                return self.send_json({"error": "unknown room"}, 403)
            return self.serve_page("tv", ROOM)

        if parsed.path == "/mom":
            return self.serve_page("mom" if "mom" in self.roles() else "nolink")

        if parsed.path.startswith("/mom/"):
            if self.locked_out():
                return self.serve_page("nolink")
            key = parsed.path[len("/mom/"):].strip("/")
            if not hmac.compare_digest(key, MOM_KEY):
                self.record_failure("Mom link")
                return self.serve_page("nolink")
            # Swap the link for a cookie so the key leaves the address bar and the
            # home-screen app (which always opens /mom) stays signed in.
            self.send_response(303)
            self.send_header("Location", "/mom")
            self.send_header("Cache-Control", "no-store")
            self.send_header(*self.cookie("vdi_mom", mom_token()))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if parsed.path == "/api/mom-link":
            if "caller" not in self.roles():
                return self.send_json({"error": "sign in first"}, 403)
            return self.send_json({"path": "/mom/" + MOM_KEY})

        if parsed.path == "/api/state":
            roles = self.roles()
            if not roles & {"caller", "mom"}:
                return self.send_json({"error": "not signed in"}, 403)
            with LOCK:
                sweep()
                return self.send_json({"active": CALL["active"], "callers": roster(), "max": MAX_CALLERS})

        if parsed.path == "/api/poll":
            peer = query.get("peer", [""])[0]
            if peer not in self.roles(query.get("room", [""])[0]):
                return self.send_json({"error": "not signed in"}, 403)
            with LOCK:
                sweep()
                if peer == "caller":
                    cid = query.get("id", [""])[0]
                    if cid not in CALL["callers"]:
                        return self.send_json({"messages": [], "gone": True})
                    CALL["callers"][cid]["seen"] = time.time()
                    key = cid
                else:
                    key = peer
                messages = QUEUES[key]
                QUEUES[key] = []
            return self.send_json({"messages": messages})

        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/login", "/api/name", "/api/send", "/api/start", "/api/join",
                        "/api/leave", "/api/play-tv"):
            return self.send_json({"error": "not found"}, 404)
        try:
            data = self.read_json()
        except (ValueError, json.JSONDecodeError):
            return self.send_json({"error": "invalid JSON"}, 400)

        if path == "/api/login":
            if not PASSPHRASE:
                return self.send_json({"error": "No family passphrase is set yet."}, 503)
            if self.locked_out():
                return self.send_json({"error": "Too many wrong tries. Please wait an hour and try again."}, 429)
            given = " ".join(str(data.get("passphrase", "")).lower().split())
            expected = " ".join(PASSPHRASE.lower().split())
            if not hmac.compare_digest(given.encode(), expected.encode()):
                self.record_failure("passphrase")
                return self.send_json({"error": "That passphrase is not right."}, 403)
            name = " ".join(str(data.get("name", "")).split())[:40]
            return self.send_json({"ok": True}, extra=(
                self.cookie("vdi_family", family_token()),
                self.cookie("vdi_name", quote(name), http_only=False),
            ))

        roles = self.roles(str(data.get("room", "")))

        if path == "/api/name":
            if "caller" not in roles:
                return self.send_json({"error": "sign in first"}, 403)
            name = " ".join(str(data.get("name", "")).split())[:40]
            return self.send_json({"ok": True}, extra=(self.cookie("vdi_name", quote(name), http_only=False),))

        cid = str(data.get("id", ""))

        if path in ("/api/start", "/api/join", "/api/leave"):
            if "caller" not in roles:
                return self.send_json({"error": "sign in first"}, 403)
            if not PEER_ID.match(cid):
                return self.send_json({"error": "invalid page id"}, 400)
            name = self.caller_name()

        if path == "/api/leave":
            with LOCK:
                remove_caller(cid)
            return self.send_json({"ok": True})

        if path == "/api/join" or path == "/api/start":
            with LOCK:
                sweep()
                if CALL["active"] or path == "/api/join":
                    if not CALL["active"]:
                        return self.send_json({"error": "No call right now."}, 409)
                    if cid not in CALL["callers"] and len(CALL["callers"]) >= MAX_CALLERS:
                        return self.send_json({"error": f"The call is full ({MAX_CALLERS} callers)."}, 409)
                    add_caller(cid, name)
                    print(f"{name or 'Someone'} joined the call.", flush=True)
                    return self.send_json({"callers": roster()})
                if CALL["starting"]:
                    return self.send_json({"error": "Someone is starting a call. Try Join in a moment."}, 409)
                now = time.time()
                with LIMIT_LOCK:
                    prune(WAKES, now)
                    if len(WAKES) >= MAX_WAKES_PER_HOUR:
                        return self.send_json({"error": (
                            f"The TV has been woken {len(WAKES)} times in the last hour. "
                            "Please wait a bit before calling again."
                        )}, 429)
                quiet = in_quiet_hours()
                if quiet and not data.get("urgent"):
                    return self.send_json({
                        "quiet": True,
                        "error": f"It is quiet hours ({QUIET_START} to {QUIET_END}). Mom may be asleep.",
                    }, 409)
                with LIMIT_LOCK:
                    WAKES.append(now)
                CALL["starting"] = True
                QUEUES.clear()
            who = name or "Someone"
            print(f"{who} is waking the TV{' during quiet hours' if quiet else ''}.", flush=True)
            if quiet:
                notify("Video Drop In: quiet-hours call", f"{who} woke Mom's TV during quiet hours.")
            try:
                prepare_tv()
            except (RuntimeError, subprocess.TimeoutExpired, FileNotFoundError) as error:
                with LOCK:
                    CALL["starting"] = False
                return self.send_json({"error": str(error)}, 502)
            with LOCK:
                CALL["starting"] = False
                CALL["active"] = True
                add_caller(cid, name)
            return self.send_json({"callers": roster()})

        if path == "/api/play-tv":
            if "tv" not in roles:
                return self.send_json({"error": "unknown room"}, 403)
            try:
                with ADB_LOCK:
                    time.sleep(0.5)
                    adb_device("shell", "input", "tap", "960", "540")
                return self.send_json({"ok": True})
            except (RuntimeError, subprocess.TimeoutExpired, FileNotFoundError) as error:
                return self.send_json({"error": str(error)}, 502)

        # /api/send: signaling between pages, addressed by page id.
        sender, to, message = data.get("peer"), str(data.get("to", "")), data.get("message")
        if sender not in roles or not isinstance(message, dict):
            return self.send_json({"error": "invalid signaling message"}, 403)
        with LOCK:
            callers = CALL["callers"]
            if sender == "caller":
                allowed = cid in callers and (to in ("tv", "mom") or (to in callers and to != cid))
                message["from"] = cid
                message["fromName"] = callers.get(cid, {}).get("name", "")
            else:
                allowed = to in callers
                message["from"] = sender
            if not allowed:
                return self.send_json({"error": "that page is not on the call"}, 409)
            push(to, message)
        return self.send_json({"ok": True})

if __name__ == "__main__":
    os.environ["HOME"] = str(CONFIG)
    (CONFIG / ".android").mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Video Drop In is listening on the home network.")
    print(f"Caller page: http://<home-assistant-address>:{PORT}/")
    print(f"Fire TV ADB target: {TV_ADB or '(not set)'}")
    if not PASSPHRASE:
        print("No family passphrase is set. The caller page stays locked until one is set.")
    print(f"Quiet hours: {QUIET_START} to {QUIET_END}; at most {MAX_WAKES_PER_HOUR} TV wakes per hour.")
    print("Video and audio are exchanged directly between browsers.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

"""HTTP-Server: Board-Manager-Schnittstelle (/api/…) für n4-darts und Einrichtungsseite (/, /hd/…)."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .app import HeimDarts
from .ws import WebSocketConnection, accept_key

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
API_VERSION = "2.0.2-heimdarts"


def make_handler(app: HeimDarts):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "HeimDarts/0.2"

        def log_message(self, fmt, *args):  # ruhig bleiben
            pass

        # -------------------------------------------------------- Antworten
        def _send(self, code: int, body: bytes = b"", ctype: str = "application/json", head_only=False):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head_only and body:
                self.wfile.write(body)

        def _json(self, obj, code: int = 200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

        def _text(self, text: str, code: int = 200):
            self._send(code, text.encode("utf-8"), "text/plain; charset=utf-8")

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            if not raw:
                return {}
            try:
                return json.loads(raw)
            except ValueError:
                return {}

        # -------------------------------------------------------- Verteilung
        def do_HEAD(self):
            path = urlparse(self.path).path
            if path == "/api/ping":
                self._send(200, b"", "text/plain", head_only=True)
            else:
                self._send(404, b"", head_only=True)

        def do_GET(self):
            url = urlparse(self.path)
            path, q = url.path, parse_qs(url.query)
            try:
                if path == "/api/events":
                    return self._websocket()
                if path == "/api/state":
                    return self._json(app.bridge.snapshot())
                if path == "/api/version":
                    return self._text(API_VERSION)
                if path == "/api/config":
                    return self._json({"auth": {"api_key": "", "board_id": "heimdarts"},
                                       "heimdarts": {"cameras": [c["source"] for c in app.config["cameras"]]}})
                if path == "/api/ping":
                    return self._text("")
                if path == "/hd/status":
                    return self._json(app.status())
                if path == "/hd/probe":
                    return self._json({"cameras": app.probe()})
                m = re.fullmatch(r"/hd/camera/(\d+)\.jpg", path)
                if m:
                    data = app.jpeg(int(m.group(1)), overlay=q.get("overlay", ["1"])[0] == "1",
                                    debug=q.get("debug", ["0"])[0] == "1", quality=90)
                    return self._send(200, data, "image/jpeg") if data else self._send(503, b"")
                m = re.fullmatch(r"/hd/camera/(\d+)/stream", path)
                if m:
                    return self._mjpeg(int(m.group(1)), q.get("overlay", ["1"])[0] == "1",
                                       q.get("debug", ["0"])[0] == "1")
                if path == "/":
                    path = "/index.html"
                return self._static(path)
            except BrokenPipeError:
                pass

        def do_PUT(self):
            path = urlparse(self.path).path
            self._body()
            if path == "/api/start":
                app.bridge.start()
                return self._json({})
            if path == "/api/stop":
                app.bridge.stop()
                return self._json({})
            self._send(404)

        def do_POST(self):
            path = urlparse(self.path).path
            body = self._body()
            try:
                if path == "/api/reset":
                    app.bridge.reset()
                    return self._json({})
                if path == "/api/config/calibration/auto":
                    app.remote_calibrate()
                    return self._json({})
                if path == "/hd/cameras":
                    app.set_sources(list(body.get("sources") or []))
                    return self._json({"ok": True})
                if path == "/hd/calibrate":
                    cal = app.calibrate(int(body["cam"]), body["points"])
                    return self._json({"ok": True, "error_px": round(cal.reprojection_error, 2)})
                if path == "/hd/calibration/clear":
                    app.clear_calibration(int(body["cam"]))
                    return self._json({"ok": True})
                if path == "/hd/autocalibrate":
                    if body.get("cam") is None:
                        return self._json({"results": app.autocalibrate_all()})
                    return self._json(app.autocalibrate(int(body["cam"])))
                if path == "/hd/calibration/rotate":
                    app.rotate(int(body["cam"]), int(body.get("steps", 1)))
                    return self._json({"ok": True})
                if path == "/hd/calibration/twenty":
                    app.twenty(int(body["cam"]), float(body["x"]), float(body["y"]))
                    return self._json({"ok": True})
                if path == "/hd/fps":
                    return self._json({"fps": app.set_fps(int(body["fps"]))})
                if path == "/hd/reference":
                    app.recapture_reference()
                    return self._json({"ok": True})
                if path == "/hd/settings":
                    app.set_detector_settings(body.get("detector") or {})
                    return self._json({"ok": True})
                if path in ("/hd/board/reset", "/hd/board/start", "/hd/board/stop"):
                    getattr(app.bridge, path.rsplit("/", 1)[1])()
                    return self._json({"ok": True})
                if path == "/hd/sim/throw":
                    if not app.has_sim:
                        return self._json({"error": "Keine simulierte Kamera eingerichtet"}, 400)
                    return self._json(app.sim_throw(body.get("x"), body.get("y"), body.get("label"),
                                                    float(body.get("spread") or 0)))
                if path == "/hd/sim/takeout":
                    app.sim_takeout()
                    return self._json({"ok": True})
                return self._send(404)
            except (ValueError, KeyError, IndexError, TypeError) as e:
                return self._json({"error": str(e)}, 400)

        # -------------------------------------------------------- Besondere Antworten
        def _static(self, path: str):
            rel = os.path.normpath(path.lstrip("/")).replace("\\", "/")
            if rel.startswith("..") or rel.startswith("/"):
                return self._send(404)
            full = os.path.join(STATIC_DIR, rel)
            if not os.path.isfile(full):
                return self._send(404, b"Nicht gefunden", "text/plain; charset=utf-8")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript",):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                self._send(200, f.read(), ctype)

        def _websocket(self):
            key = self.headers.get("Sec-WebSocket-Key")
            if "websocket" not in (self.headers.get("Upgrade") or "").lower() or not key:
                return self._send(400, b"WebSocket erwartet", "text/plain")
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept_key(key))
            self.end_headers()
            self.wfile.flush()
            conn = WebSocketConnection(self.connection)
            app.bridge.subscribe(conn.send_text)
            try:
                conn.serve_forever()
            finally:
                app.bridge.unsubscribe(conn.send_text)
                self.close_connection = True

        def _mjpeg(self, cam: int, overlay: bool, debug: bool):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                while True:
                    data = app.jpeg(cam, overlay=overlay, debug=debug, quality=70)
                    if data:
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                         + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n")
                        self.wfile.flush()
                    time.sleep(1.0 / min(10, app.fps))   # Vorschau höchstens 10 Bilder/s
            except (BrokenPipeError, ConnectionError, OSError):
                pass

    return Handler


def serve(app: HeimDarts, host: str = "127.0.0.1", port: int = 3180) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(app))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, name="http", daemon=True).start()
    return httpd

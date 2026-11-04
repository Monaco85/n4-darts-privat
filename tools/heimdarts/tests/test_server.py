"""Board-Manager-Schnittstelle über echtes HTTP und WebSocket, wie n4-darts sie nutzt."""
import base64
import json
import os
import socket
import struct
import time
import urllib.request

import pytest

from heimdarts.app import HeimDarts
from heimdarts.server import serve


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    app = HeimDarts(str(tmp_path_factory.mktemp("data")), force_sim=True)
    httpd = serve(app, "127.0.0.1", 0)
    port = httpd.server_address[1]
    yield app, f"http://127.0.0.1:{port}", port
    httpd.shutdown()
    app.close()


def http(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        raw = r.read()
        return r.status, (json.loads(raw) if r.headers.get_content_type() == "application/json" else raw.decode())


class WsClient:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.sock.recv(1)
        assert b" 101 " in head.split(b"\r\n")[0]

    def recv(self, timeout=5.0):
        self.sock.settimeout(timeout)
        b1, b2 = self._exact(2)
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack("!H", self._exact(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", self._exact(8))[0]
        return json.loads(self._exact(n))

    def _exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            assert chunk, "Verbindung beendet"
            buf += chunk
        return buf

    def until(self, event, timeout=8.0):
        end = time.time() + timeout
        seen = []
        while time.time() < end:
            msg = self.recv(max(0.1, end - time.time()))
            seen.append(msg["data"]["event"])
            if msg["data"]["event"] == event:
                return msg["data"], seen
        raise AssertionError(f"{event} nicht erhalten, nur {seen}")


def test_basic_endpoints(server):
    _, base, _ = server
    status, state = http(base, "GET", "/api/state")
    assert status == 200 and state["connected"] and state["running"]
    assert {"event", "status", "numThrows"} <= state.keys()
    assert http(base, "GET", "/api/version")[1].startswith("2.0.2")
    assert http(base, "GET", "/api/config")[1]["auth"]["api_key"] == ""
    req = urllib.request.Request(base + "/api/ping", method="HEAD")
    assert urllib.request.urlopen(req, timeout=5).status == 200


def test_visit_lifecycle_over_websocket(server):
    app, base, port = server
    time.sleep(1.0)  # Referenzbilder
    ws = WsClient(port)
    names = []
    for label in ["T20", "D16", "S5"]:
        http(base, "POST", "/hd/sim/throw", {"label": label})
        data, _ = ws.until("Throw detected")
        names = [t["segment"]["name"] for t in data["throws"]]
    assert names == ["T20", "D16", "S5"]
    assert data["status"] == "Takeout" and data["numThrows"] == 3

    http(base, "POST", "/hd/sim/takeout", {})
    data, seen = ws.until("Takeout finished")
    assert "Takeout started" in seen
    assert data["numThrows"] == 0 and "throws" not in data and data["status"] == "Throw"


def test_commands(server):
    _, base, port = server
    ws = WsClient(port)
    http(base, "POST", "/api/reset")
    data, _ = ws.until("Manual reset")
    assert data["numThrows"] == 0
    assert http(base, "PUT", "/api/stop")[0] == 200
    data, _ = ws.until("Stopped")
    assert data["running"] is False
    http(base, "PUT", "/api/start")
    data, _ = ws.until("Started")
    assert data["running"] is True and data["status"] == "Throw"


def test_autocalibrate_rotate_and_fps(server):
    _, base, _ = server
    _, r = http(base, "POST", "/hd/autocalibrate", {"cam": 0})
    assert r["ok"] and r["rotation_source"] == "vorher"
    _, all_r = http(base, "POST", "/hd/autocalibrate", {})
    assert len(all_r["results"]) == 3 and all(x["ok"] for x in all_r["results"])
    assert http(base, "POST", "/hd/calibration/rotate", {"cam": 0, "steps": 1})[0] == 200
    assert http(base, "POST", "/hd/calibration/rotate", {"cam": 0, "steps": -1})[0] == 200
    assert http(base, "POST", "/hd/fps", {"fps": 50})[1]["fps"] == 30     # begrenzt
    assert http(base, "POST", "/hd/fps", {"fps": 2})[1]["fps"] == 5
    assert http(base, "POST", "/hd/fps", {"fps": 12})[1]["fps"] == 12
    status = http(base, "GET", "/hd/status")[1]
    assert status["fps"]["value"] == 12 and status["fps"]["min"] == 5 and status["fps"]["max"] == 30
    assert status["cameras"][0]["autocal"]["rotation_source"] == "klick"


def test_setup_page_and_camera_image(server):
    _, base, _ = server
    with urllib.request.urlopen(base + "/", timeout=5) as r:
        assert b"HeimDarts" in r.read()
    with urllib.request.urlopen(base + "/hd/camera/0.jpg", timeout=5) as r:
        assert r.headers.get_content_type() == "image/jpeg"
        assert r.read()[:2] == b"\xff\xd8"
    status = http(base, "GET", "/hd/status")[1]
    assert len(status["cameras"]) == 3 and all(c["calibrated"] for c in status["cameras"])

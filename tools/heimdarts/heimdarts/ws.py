"""Minimaler WebSocket-Server (RFC 6455) für http.server – nur das, was /api/events braucht."""
from __future__ import annotations

import base64
import hashlib
import socket
import struct
import threading

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()


class WebSocketConnection:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self._send_lock = threading.Lock()
        self.closed = False

    def send_text(self, text: str) -> None:
        self._send(0x1, text.encode("utf-8"))

    def _send(self, opcode: int, payload: bytes) -> None:
        if self.closed:
            raise ConnectionError("geschlossen")
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        with self._send_lock:
            try:
                self.sock.sendall(header + payload)
            except OSError:
                self.closed = True
                raise

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("Verbindung beendet")
            buf += chunk
        return buf

    def serve_forever(self) -> None:
        """Liest Nachrichten des Clients (Ping, Close) bis zum Ende der Verbindung."""
        try:
            while not self.closed:
                b1, b2 = self._recv_exact(2)
                opcode = b1 & 0x0F
                masked = b2 & 0x80
                n = b2 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", self._recv_exact(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", self._recv_exact(8))[0]
                mask = self._recv_exact(4) if masked else b"\0\0\0\0"
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(self._recv_exact(n)))
                if opcode == 0x8:      # Close
                    try:
                        self._send(0x8, data[:2])
                    except OSError:
                        pass
                    break
                if opcode == 0x9:      # Ping
                    self._send(0xA, data)
        except (ConnectionError, OSError):
            pass
        finally:
            self.closed = True
            try:
                self.sock.close()
            except OSError:
                pass

    def close(self) -> None:
        if not self.closed:
            try:
                self._send(0x8, struct.pack("!H", 1001))
            except OSError:
                pass
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

import http.client
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOKEN = "broker-test-token-0000000000000000000000000000"


class Backend(BaseHTTPRequestHandler):
    requests = []
    response_body = b'{"status":"ok"}'

    def log_message(self, *_args):
        pass

    def do_GET(self): self.record()
    def do_POST(self): self.record()
    def do_PUT(self): self.record()
    def do_DELETE(self): self.record()

    def record(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.__class__.requests.append((self.command, self.path, dict(self.headers), self.rfile.read(length)))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.response_body)))
        self.end_headers()
        self.wfile.write(self.response_body)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        Backend.requests = []
        self.backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        threading.Thread(target=self.backend.serve_forever, daemon=True).start()
        self.temp = tempfile.TemporaryDirectory()
        env_file = Path(self.temp.name) / "backend.env"
        env_file.write_text(f"PICKLESHELL_MEMORY_BACKEND_TOKEN='{TOKEN}'\n")
        self.port = self.free_port()
        env = {**os.environ, "PYTHONPATH": str(ROOT / "pickleshell-memory-broker"),
               "PICKLESHELL_MEMORY_BROKER_PORT": str(self.port),
               "PICKLESHELL_MEMORY_BROKER_BACKEND_URL": f"http://127.0.0.1:{self.backend.server_port}",
               "PICKLESHELL_MEMORY_BACKEND_ENV_FILE": str(env_file)}
        # The production config deliberately requires 8766; use the module handler
        # directly for this deterministic protocol test with a test backend port.
        self.proc = subprocess.Popen(["python3", "-c", (
            "from pickleshell_memory_broker.server import BrokerHandler,BoundedHTTPServer; "
            f"s=BoundedHTTPServer(('127.0.0.1',{self.port}),BrokerHandler,max_connections=4); s.read_deadline=0.4; "
            f"s.broker_config=('127.0.0.1',{self.port},'http://127.0.0.1:{self.backend.server_port}','{TOKEN}'); s.serve_forever()"
        )], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.wait_ready()

    def tearDown(self):
        self.proc.terminate(); self.proc.wait(timeout=3)
        self.proc.stdout.close(); self.proc.stderr.close()
        self.temp.cleanup(); self.backend.shutdown(); self.backend.server_close()

    @staticmethod
    def free_port():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); return sock.getsockname()[1]

    def wait_ready(self):
        for _ in range(100):
            try:
                self.request("GET", "/health"); return
            except OSError: pass
            time.sleep(0.02)
        stderr = self.proc.stderr.read().decode(errors="replace") if self.proc.poll() is not None else ""
        self.fail(f"broker did not start ({self.proc.returncode}): {stderr}")

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse(); data = response.read(); connection.close()
        return response.status, data

    def test_health_forwarding_and_credential_injection(self):
        status, _ = self.request("GET", "/health")
        self.assertEqual(status, 200)
        status, _ = self.request("POST", "/search", json.dumps({"query": "secret"}), {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        method, path, headers, body = Backend.requests[-1]
        self.assertEqual((method, path), ("POST", "/search"))
        self.assertEqual(json.loads(body)["user_id"], "codex-bos-v1")
        self.assertEqual(headers["Authorization"], f"Bearer {TOKEN}")

    def test_scope_and_authorization_policy(self):
        for body in ({"query": "x", "user_id": "other"},):
            status, _ = self.request("POST", "/search", json.dumps(body), {"Content-Type": "application/json"})
            self.assertEqual(status, 403)
        self.assertEqual(self.request("GET", "/memories?user_id=other")[0], 403)
        self.assertEqual(self.request("GET", "/health", headers={"Authorization": "Bearer client"})[0], 400)
        self.assertEqual(self.request("PATCH", "/health")[0], 405)
        self.assertEqual(self.request("GET", "/not-allowed")[0], 404)

    def test_partial_clients_and_absolute_deadline(self):
        for partial in (b"", b"GET /health HTTP/1.1\r\nHost: x", b"POST /search HTTP/1.1\r\nHost: x\r\nContent-Length: 20\r\n\r\n{"):
            with socket.create_connection(("127.0.0.1", self.port), timeout=2) as sock:
                sock.sendall(partial)
                started = time.monotonic()
                while time.monotonic() - started < 0.8:
                    try:
                        sock.sendall(b" ")
                    except OSError:
                        break
                    time.sleep(0.05)
                try:
                    self.assertEqual(sock.recv(4096), b"")
                except ConnectionResetError:
                    pass
                self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(self.request("GET", "/health")[0], 200)

    def test_concurrency_is_bounded_and_recovers(self):
        sockets = [socket.create_connection(("127.0.0.1", self.port), timeout=2) for _ in range(4)]
        try:
            time.sleep(0.05)
            with socket.create_connection(("127.0.0.1", self.port), timeout=2) as extra:
                try:
                    self.assertEqual(extra.recv(1), b"")
                except ConnectionResetError:
                    pass
            task_count = len(list(Path(f"/proc/{self.proc.pid}/task").iterdir()))
            self.assertLessEqual(task_count, 5)
            time.sleep(0.5)
            self.assertEqual(self.request("GET", "/health")[0], 200)
        finally:
            for sock in sockets:
                sock.close()

    def test_size_bounds_and_no_local_leakage(self):
        status, _ = self.request("POST", "/search", b"x" * (64 * 1024 + 1), {"Content-Length": str(64 * 1024 + 1)})
        self.assertEqual(status, 413)
        self.assertIsNone(self.proc.poll())


if __name__ == "__main__": unittest.main()

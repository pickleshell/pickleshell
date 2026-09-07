import io
import hashlib
from .policy import load_policy, PrincipalPolicy
import socket
import threading
import time
import json
import os
import re
import shlex
from http.client import HTTPConnection, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

MAX_BODY_BYTES = 64 * 1024
MAX_HEADER_BYTES = 16 * 1024
MAX_TARGET_BYTES = 4 * 1024
MAX_RESPONSE_BYTES = 256 * 1024
FIXED_USER_ID = "codex-bos-v1"
MEMORY_ID = r"[A-Za-z0-9][A-Za-z0-9_-]{0,199}"


def env_file_token(path: str) -> str:
    """Read only the backend bearer token; never include file contents in errors."""
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:].lstrip()
            if line.startswith("PICKLESHELL_MEMORY_BACKEND_TOKEN="):
                value = line.split("=", 1)[1].strip()
                try:
                    parsed = shlex.split(value, comments=False, posix=True)
                except ValueError:
                    raise ValueError("backend credential is invalid") from None
                token = parsed[0] if len(parsed) == 1 else ""
                if 32 <= len(token) <= 4096:
                    return token
                raise ValueError("backend credential is invalid")
    except OSError as error:
        raise ValueError("backend credential file is unavailable") from error
    raise ValueError("backend credential is missing")


def config(env=os.environ):
    host = env.get("PICKLESHELL_MEMORY_BROKER_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1"}:
        raise ValueError("broker host must be a literal loopback address")
    try:
        port = int(env.get("PICKLESHELL_MEMORY_BROKER_PORT", "8767"))
    except ValueError:
        raise ValueError("broker port is invalid") from None
    if not 1 <= port <= 65535 or port == 8766:
        raise ValueError("broker port is invalid")
    backend = env.get("PICKLESHELL_MEMORY_BROKER_BACKEND_URL", "http://127.0.0.1:8766")
    parsed = urlsplit(backend)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port != 8766 or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("broker backend must be the authenticated loopback backend")
    token = env_file_token(env.get("PICKLESHELL_MEMORY_BACKEND_ENV_FILE", "/etc/pickleshell-memory/backend.env"))
    return host, port, backend.rstrip("/"), token


READ_DEADLINE_SECONDS = 5
MAX_CONNECTIONS = 16


class DeadlineReader(io.RawIOBase):
    """An absolute deadline, including clients that continuously trickle bytes."""
    def __init__(self, connection, seconds):
        self.connection = connection
        self.deadline = time.monotonic() + seconds

    def readable(self):
        return True

    def readinto(self, buffer):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request deadline exceeded")
        self.connection.settimeout(remaining)
        return self.connection.recv_into(buffer)


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = MAX_CONNECTIONS
    read_deadline = READ_DEADLINE_SECONDS
    upstream_timeout = 10

    def __init__(self, *args, max_connections=MAX_CONNECTIONS, **kwargs):
        self.slots = threading.BoundedSemaphore(max_connections)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Disconnects and partial requests must not produce unbounded logs.
        return


class BrokerHandler(BaseHTTPRequestHandler):
    server_version = "PickleShellMemoryBroker/1"
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.rfile.close()
        self.rfile = io.BufferedReader(DeadlineReader(self.connection, self.server.read_deadline))

    def handle(self):
        # One request per connection bounds idle keep-alive occupancy as well.
        try:
            self.handle_one_request()
        except (OSError, ValueError):
            pass
        finally:
            self.close_connection = True

    def log_message(self, *_args):
        return

    def send_response(self, code, message=None):
        self.audit_status = code
        super().send_response(code, message)

    def send_error_json(self, status, error):
        body = json.dumps({"error": error, "status": status}, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        parsed = urlsplit(self.path)
        if parsed.scheme or parsed.netloc or parsed.fragment:
            return None
        if len(self.path.encode()) > MAX_TARGET_BYTES:
            return None
        query = parse_qs(parsed.query, keep_blank_values=True)
        path = parsed.path
        if path == "/health": return (self.command, "/health", None, {"GET"}, query)
        if path == "/memories":
            return (self.command, path, None, {"GET", "POST"}, query)
        match = re.fullmatch(r"/memories/(" + MEMORY_ID + r")", path)
        if match: return (self.command, path, match.group(1), {"GET", "PUT", "DELETE"}, query)
        match = re.fullmatch(r"/memories/(" + MEMORY_ID + r")/history", path)
        if match: return (self.command, path, match.group(1), {"GET"}, query)
        if path == "/search": return (self.command, path, None, {"POST"}, query)
        return None

    def read_body(self):
        if self.headers.get("Transfer-Encoding") is not None:
            raise ValueError("invalid_request")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != (1 if self.command in {"POST", "PUT"} else 0):
            raise ValueError("invalid_request")
        if not lengths:
            return b""
        try: length = int(lengths[0])
        except ValueError: raise ValueError("invalid_request") from None
        if length < 0 or length > MAX_BODY_BYTES: raise ValueError("request_too_large")
        body = self.rfile.read(length)
        if len(body) != length: raise ValueError("invalid_request")
        return body

    def do_REQUEST(self):
        if sum(len(k.encode()) + len(v.encode()) + 4 for k, v in self.headers.items()) > MAX_HEADER_BYTES:
            return self.send_error_json(431, "request_headers_too_large")
        policy = getattr(self.server, "principal_policy", None)
        if policy is not None:
            return self.principal_request(policy)
        if self.headers.get("Authorization") is not None:
            return self.send_error_json(400, "client_authorization_forbidden")
        route = self.route()
        if route is None: return self.send_error_json(404, "route_not_found")
        method, path, memory_id, methods, query = route
        if method not in methods:
            return self.send_error_json(405, "method_not_allowed")
        allowed_query = {"user_id", "limit"} if path == "/memories" and method == "GET" else ({"user_id"} if memory_id else set())
        if set(query) - allowed_query:
            return self.send_error_json(400, "invalid_request")
        supplied = query.get("user_id", [])
        if supplied and (len(supplied) != 1 or supplied[0] != FIXED_USER_ID):
            return self.send_error_json(403, "scope_override_denied")
        try:
            body = self.read_body()
        except ValueError as error:
            return self.send_error_json(413 if str(error) == "request_too_large" else 400, str(error))
        if method in {"POST", "PUT"}:
            try: payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError): return self.send_error_json(400, "invalid_request")
            if not isinstance(payload, dict): return self.send_error_json(400, "invalid_request")
            if "user_id" in payload and payload["user_id"] != FIXED_USER_ID:
                return self.send_error_json(403, "scope_override_denied")
            payload["user_id"] = FIXED_USER_ID
            body = json.dumps(payload, separators=(",", ":")).encode()
            if len(body) > MAX_BODY_BYTES: return self.send_error_json(413, "request_too_large")
        if method in {"GET", "DELETE"} and "user_id" not in query and path != "/health":
            query["user_id"] = [FIXED_USER_ID]
        self.connection.settimeout(10)
        self.forward(method, path, query, body)

    def principal_request(self, policy):
        self.principal = None
        target, scope, operation = None, None, None
        try:
            credentials = self.headers.get_all("Authorization", [])
            if len(credentials) != 1:
                return self.send_error_json(401, "principal_unauthorized")
            self.principal = policy.authenticate(credentials[0])
            if self.principal is None:
                return self.send_error_json(401, "principal_unauthorized")
            route = self.route()
            if route is None:
                return self.send_error_json(404, "route_not_found")
            method, path, memory_id, methods, query = route
            if method not in methods:
                return self.send_error_json(405, "method_not_allowed")
            operation = ("health" if path == "/health" else "search" if path == "/search" else
                         "history" if path.endswith("/history") else
                         {"POST": "add", "PUT": "update", "DELETE": "delete", "GET": "get" if memory_id else "list"}[method])
            if any(self.headers.get(h) is not None for h in ("X-Agent", "X-Principal")):
                return self.send_error_json(403, "principal_override_denied")
            allowed_query = {"target", "limit"} if path == "/memories" and method == "GET" else ({"target"} if memory_id else set())
            if set(query) - allowed_query or any(len(v) != 1 for v in query.values()):
                return self.send_error_json(403, "scope_override_denied")
            try:
                body = self.read_body()
            except ValueError as error:
                return self.send_error_json(413 if str(error) == "request_too_large" else 400, str(error))
            payload = None
            if method in {"POST", "PUT"}:
                try:
                    payload = json.loads(body.decode("utf-8"), object_pairs_hook=unique_payload)
                except (ValueError, UnicodeError, RecursionError):
                    return self.send_error_json(400, "invalid_request")
                allowed = {"target", "query", "limit"} if path == "/search" else ({"target", "text", "infer"} if method == "POST" else {"target", "text"})
                if not isinstance(payload, dict) or set(payload) - allowed:
                    return self.send_error_json(403, "scope_override_denied")
                target = payload.pop("target", "private")
            else:
                target = query.pop("target", ["private"])[0]
            write = method in {"PUT", "DELETE"} or (method == "POST" and path == "/memories")
            scope = policy.resolve(self.principal, target, write)
            if scope is None:
                return self.send_error_json(403, "target_access_denied")
            if payload is not None:
                payload["user_id"] = scope
                body = json.dumps(payload, separators=(",", ":")).encode()
                if len(body) > MAX_BODY_BYTES:
                    return self.send_error_json(413, "request_too_large")
            elif path != "/health":
                query["user_id"] = [scope]
            self.connection.settimeout(10)
            self.forward(method, path, query, body)
        finally:
            # Broker-owned identity, no client text/IDs/credentials in the audit.
            event = {"principal": self.principal["name"] if self.principal else None,
                     "target": target if isinstance(target, str) and (target == "private" or target in (self.principal or {}).get("shared", {})) else None,
                     "scope": scope, "operation": operation, "method": self.command, "status": getattr(self, "audit_status", 400)}
            print(json.dumps(event, separators=(",", ":")), flush=True)

    def forward(self, method, path, query, body):
        target = path
        if query:
            from urllib.parse import urlencode
            target += "?" + urlencode([(key, value) for key, values in query.items() for value in values])
        _, _, backend, token = self.server.broker_config
        parsed = urlsplit(backend)
        connection = HTTPConnection(parsed.hostname, parsed.port, timeout=self.server.upstream_timeout)
        response_started = False
        try:
            connection.request(method, target, body=body or None, headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                response_started = True
                return self.send_error_json(502, "response_too_large")
            if response.length not in (None, 0):
                raise ValueError("incomplete upstream response")
            # Mark before any headers can reach the client, including partial writes.
            if 300 <= response.status < 400:
                raise ValueError("upstream redirect denied")
            if path == "/health" and response.status == 200 and getattr(self, "principal", None):
                health = json.loads(data)
                # Never disclose arbitrary backend health fields through broker discovery.
                health = {k: v for k, v in health.items() if k in {"status", "provider", "version"} and isinstance(v, str) and len(v) <= 64}
                health["broker"] = PrincipalPolicy.public(self.principal)
                data = json.dumps(health, separators=(",", ":")).encode()
            response_started = True
            self.send_response(response.status)
            content_type = response.getheader("Content-Type")
            if content_type: self.send_header("Content-Type", content_type)
            self.send_header("Connection", "close")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self.close_connection = True
            if not response_started:
                self.send_error_json(503, "backend_unavailable")
        finally: connection.close()

    do_GET = do_REQUEST
    do_POST = do_REQUEST
    do_PUT = do_REQUEST
    do_DELETE = do_REQUEST
    do_PATCH = do_REQUEST
    do_OPTIONS = do_REQUEST
    do_HEAD = do_REQUEST
    do_CONNECT = do_REQUEST
    do_TRACE = do_REQUEST


def unique_payload(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate request key")
        result[key] = value
    return result


def main():
    try: host, port, backend, token = config()
    except ValueError as error: raise SystemExit(f"pickleshell-memory-broker: configuration error: {error}") from None
    mode = os.environ.get("PICKLESHELL_MEMORY_BROKER_MODE")
    policy_path = os.environ.get("PICKLESHELL_MEMORY_BROKER_POLICY_FILE")
    try:
        if mode == "principals" and policy_path:
            policy = load_policy(policy_path)
            if hashlib.sha256(token.encode()).hexdigest() in policy.by_digest:
                raise ValueError("principal credential must differ from backend credential")
        elif mode == "legacy-codex" and not policy_path:
            policy = None
        else:
            raise ValueError("explicit broker mode and principal policy are required")
    except ValueError as error:
        raise SystemExit(f"pickleshell-memory-broker: configuration error: {error}") from None
    if host == "::1":
        BoundedHTTPServer.address_family = socket.AF_INET6
    server = BoundedHTTPServer((host, port), BrokerHandler)
    server.broker_config = (host, port, backend, token)
    server.principal_policy = policy
    server.serve_forever()


if __name__ == "__main__": main()

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


class NoRedirect:
    pass


class BrokerHandler(BaseHTTPRequestHandler):
    server_version = "PickleShellMemoryBroker/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        return

    def send_error_json(self, status, error):
        body = json.dumps({"error": error, "status": status}, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        parsed = urlsplit(self.path)
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
        self.forward(method, path, query, body)

    def forward(self, method, path, query, body):
        target = path
        if query:
            from urllib.parse import urlencode
            target += "?" + urlencode([(key, value) for key, values in query.items() for value in values])
        _, _, backend, token = self.server.broker_config
        parsed = urlsplit(backend)
        connection = HTTPConnection(parsed.hostname, parsed.port, timeout=10)
        try:
            connection.request(method, target, body=body or None, headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES: return self.send_error_json(502, "response_too_large")
            self.send_response(response.status)
            content_type = response.getheader("Content-Type")
            if content_type: self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
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


def main():
    try: host, port, backend, token = config()
    except ValueError as error: raise SystemExit(f"pickleshell-memory-broker: configuration error: {error}") from None
    server = ThreadingHTTPServer((host, port), BrokerHandler)
    server.broker_config = (host, port, backend, token)
    server.serve_forever()


if __name__ == "__main__": main()

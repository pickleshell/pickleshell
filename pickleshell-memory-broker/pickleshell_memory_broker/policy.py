"""Operator policy. Credential digests identify principals; callers never name them."""
import hashlib
import json
import os
import re
import stat
from pathlib import Path

MAX_POLICY_BYTES = 128 * 1024
NAME = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
TARGET = re.compile(r"shared/[a-z][a-z0-9_/-]{0,120}\Z")
SCOPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_:./-]{0,199}\Z")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate policy key")
        result[key] = value
    return result


def keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("invalid policy fields")


class PrincipalPolicy:
    def __init__(self, document):
        keys(document, {"version", "principals"})
        if type(document["version"]) is not int or document["version"] != 1:
            raise ValueError("unsupported policy version")
        entries = document["principals"]
        if not isinstance(entries, list) or not 1 <= len(entries) <= 64:
            raise ValueError("policy requires 1 to 64 principals")
        self.by_digest = {}
        names, private_scopes, shared_scopes, aliases = set(), set(), set(), {}
        for entry in entries:
            keys(entry, {"name", "token_sha256", "private_scope", "shared"})
            name, digest, private = entry["name"], entry["token_sha256"], entry["private_scope"]
            if not isinstance(name, str) or not NAME.fullmatch(name) or name in names:
                raise ValueError("invalid or duplicate principal")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or digest in self.by_digest:
                raise ValueError("invalid or duplicate credential digest")
            if not isinstance(private, str) or not SCOPE.fullmatch(private) or private in private_scopes:
                raise ValueError("invalid or duplicate private scope")
            grants = entry["shared"]
            if not isinstance(grants, dict) or len(grants) > 64:
                raise ValueError("invalid shared grants")
            for target, grant in grants.items():
                if not TARGET.fullmatch(target) or "//" in target or target.endswith("/"):
                    raise ValueError("invalid shared target")
                keys(grant, {"scope", "read", "write"})
                scope = grant["scope"]
                if not isinstance(scope, str) or not SCOPE.fullmatch(scope):
                    raise ValueError("invalid shared scope")
                if type(grant["read"]) is not bool or type(grant["write"]) is not bool:
                    raise ValueError("permissions must be explicit booleans")
                if target in aliases and aliases[target] != scope:
                    raise ValueError("conflicting shared target")
                if scope in aliases.values() and aliases.get(target) != scope:
                    raise ValueError("duplicate shared scope alias")
                aliases[target] = scope
                shared_scopes.add(scope)
            names.add(name)
            private_scopes.add(private)
            self.by_digest[digest] = entry
        if private_scopes & shared_scopes:
            raise ValueError("private scopes cannot be shared")

    def authenticate(self, authorization):
        if not isinstance(authorization, str) or not re.fullmatch(r"Bearer [A-Za-z0-9_-]{43,128}", authorization):
            return None
        digest = hashlib.sha256(authorization[7:].encode("ascii")).hexdigest()
        return self.by_digest.get(digest)

    @staticmethod
    def resolve(principal, target, write):
        if target == "private":
            return principal["private_scope"]
        if not isinstance(target, str):
            return None
        grant = principal["shared"].get(target)
        return grant["scope"] if grant and grant["write" if write else "read"] else None

    @staticmethod
    def public(principal):
        return {"principal": principal["name"], "targets": [
            {"target": "private", "read": True, "write": True},
            *({"target": target, "read": grant["read"], "write": grant["write"]}
              for target, grant in principal["shared"].items())]}


def load_policy(path):
    """Read a root/operator-owned source or private systemd credential, no symlinks."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid not in {0, os.geteuid()} or stat.S_IMODE(info.st_mode) not in {0o400, 0o600}:
                raise ValueError("policy ownership or mode is unsafe")
            data = stream.read(MAX_POLICY_BYTES + 1)
        if len(data) > MAX_POLICY_BYTES:
            raise ValueError("policy is too large")
        return PrincipalPolicy(json.loads(data, object_pairs_hook=unique_object))
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError, TypeError) as error:
        raise ValueError("policy is unreadable or malformed") from None


if __name__ == "__main__":
    import sys
    try:
        load_policy(sys.argv[1])
    except (ValueError, IndexError):
        raise SystemExit("invalid broker principal policy") from None
    print("broker principal policy: valid")

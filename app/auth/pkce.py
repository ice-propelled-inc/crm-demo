"""PKCE helpers (RFC 7636, S256)."""

import hashlib
import secrets
from base64 import urlsafe_b64encode


def new_code_verifier() -> str:
    return secrets.token_urlsafe(48)


def code_challenge_s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode()

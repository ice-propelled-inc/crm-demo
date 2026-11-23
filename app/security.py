"""Encryption of credentials kept in the database, and webhook signatures."""

import hashlib
import hmac

from cryptography.fernet import Fernet

from app.settings import get_settings


def _fernet() -> Fernet:
    return Fernet(get_settings().encryption_key.encode())


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


def hmac_sha256_signature(secret: str, body: bytes) -> str:
    """Signature header value: `sha256=<hex digest>`."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def verify_hmac_sha256(secret: str, body: bytes, header_value: str | None) -> bool:
    if not header_value:
        return False
    return hmac.compare_digest(hmac_sha256_signature(secret, body), header_value)

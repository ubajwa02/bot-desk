"""Minimal Web Push sender (RFC 8291 aes128gcm payloads + RFC 8292 VAPID), using only `cryptography` and the stdlib.

Works with Apple's push service (iOS 16.4+ Home Screen web apps) and the others.
"""
import base64
import json
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, hmac, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s: str) -> bytes:
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _hmac(key: bytes, data: bytes) -> bytes:
    h = hmac.HMAC(key, hashes.SHA256())
    h.update(data)
    return h.finalize()


def encrypt(payload: bytes, p256dh: str, auth: str, *, salt: bytes = None, as_key=None, rs: int = 4096) -> bytes:
    """Return an aes128gcm body for one subscription (RFC 8291 section 3.4)."""
    ua_pub = b64u_dec(p256dh)
    auth_secret = b64u_dec(auth)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub)
    as_key = as_key or ec.generate_private_key(ec.SECP256R1())
    as_pub = as_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ecdh = as_key.exchange(ec.ECDH(), ua_key)
    prk_key = _hmac(auth_secret, ecdh)
    ikm = _hmac(prk_key, b"WebPush: info\x00" + ua_pub + as_pub + b"\x01")
    salt = salt or os.urandom(16)
    prk = _hmac(salt, ikm)
    cek = _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16]
    nonce = _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12]
    if len(payload) + 1 + 16 > rs:
        raise ValueError("payload too large for one record")
    ct = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack(">IB", rs, len(as_pub)) + as_pub + ct


def vapid_headers(endpoint: str, private_pem: bytes, subject: str, ttl_hours: int = 12) -> dict:
    key = serialization.load_pem_private_key(private_pem, None)
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    u = urllib.parse.urlsplit(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int(time.time()) + ttl_hours * 3600, "sub": subject},
                             separators=(",", ":")).encode())
    signing_input = f"{head}.{claims}".encode()
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    jwt = f"{head}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
    return {"Authorization": f"vapid t={jwt}, k={b64u(pub)}"}


def send(subscription: dict, data: dict, private_pem: bytes, subject: str, ttl: int = 6 * 3600, urgency: str = "high"):
    """Send one push. Returns (status, reason). 404/410 mean the subscription is gone and should be dropped."""
    endpoint = subscription["endpoint"]
    if not endpoint.startswith("https://"):
        raise ValueError("endpoint must be https")
    body = encrypt(json.dumps(data, separators=(",", ":")).encode(), subscription["keys"]["p256dh"], subscription["keys"]["auth"])
    headers = {"Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(ttl), "Urgency": urgency}
    headers.update(vapid_headers(endpoint, private_pem, subject))
    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.reason
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:200].decode("utf-8", "replace")

"""Run: python3 -m unittest discover -s tests"""
import base64, json, pathlib, sys, tempfile, unittest, struct
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
import webpush, publish  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def ua_decrypt(body, ua_key, auth):
    """Receiver side of RFC 8291, written independently of the sender."""
    salt, rs, idlen = body[:16], struct.unpack(">I", body[16:20])[0], body[20]
    as_pub = body[21:21 + idlen]; ct = body[21 + idlen:]
    ua_pub = ua_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    ecdh = ua_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    ikm = HKDF(hashes.SHA256(), 32, auth, b"WebPush: info\x00" + ua_pub + as_pub).derive(ecdh)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    pt = AESGCM(cek).decrypt(nonce, ct, None)
    assert rs == 4096 and pt.endswith(b"\x02")
    return pt[:-1]


class WebPushTest(unittest.TestCase):
    def test_roundtrip(self):
        ua = ec.generate_private_key(ec.SECP256R1())
        pub = ua.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        auth = b"0123456789abcdef"
        body = webpush.encrypt(b'{"title":"hi"}', webpush.b64u(pub), webpush.b64u(auth))
        self.assertEqual(ua_decrypt(body, ua, auth), b'{"title":"hi"}')

    def test_vapid_jwt_verifies(self):
        k = ec.generate_private_key(ec.SECP256R1())
        pem = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        h = webpush.vapid_headers("https://web.push.apple.com/abc", pem, "https://example.org/")["Authorization"]
        t = h.split("t=")[1].split(",")[0]; kk = h.split("k=")[1]
        head, claims, sig = t.split(".")
        c = json.loads(webpush.b64u_dec(claims))
        self.assertEqual(c["aud"], "https://web.push.apple.com")
        raw = webpush.b64u_dec(sig)
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), webpush.b64u_dec(kk)).verify(
            der, f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))


LATEST = {
    "generated_at": "2026-11-10T03:09:33Z",
    "alerts": [{"id": "a", "level": "error", "project": "x", "title": "Signals did not run", "detail": "d", "url": "https://x"}],
    "new_alerts": [{"id": "a", "title": "Signals did not run"}, {"id": "b", "title": "Other"}],
    "projects": [
        {"id": "tradebot", "name": "T", "status": "error", "lines": ["a", "b", "c"], "url": "u"},
        {"id": "prs", "name": "PRs", "status": "info", "lines": ["1"]},
        {"id": "spy", "name": "S", "status": "ok", "lines": ["Paused: no schedule"]},
        {"id": "nba", "name": "N", "status": "ok", "lines": ["fine"]},
        {"id": "w", "name": "W", "status": "warn", "lines": ["x"]},
    ],
    "strategies": [{"id": "signals", "trades": [{"pnl": 3.1}]},
                   {"id": "nba", "trades": [{"pnl": 1}], "tonight": [{"key": "p-1", "kind": "pick", "pick": "X", "dk_url": "https://dk", "slate": "s"}]}],
}


class PublishTest(unittest.TestCase):
    def test_payload_groups_and_no_trading(self):
        p = publish.payload(LATEST)
        self.assertEqual([x["group"] for x in p["projects"]], ["broken", "needs", "paused", "running", "needs"])
        self.assertEqual(len(p["projects"][0]["lines"]), 2)
        self.assertNotIn("pnl", json.dumps(p))
        self.assertNotIn("trades", json.dumps(p))
        self.assertEqual(p["nba_tonight"][0]["pick"], "X")

    def test_seal_opens_with_key(self):
        key = b"k" * 32
        box = publish.seal({"a": 1}, key)
        pt = AESGCM(key).decrypt(webpush.b64u_dec(box["iv"]), webpush.b64u_dec(box["ct"]), None)
        self.assertEqual(json.loads(pt), {"a": 1})

    def test_alert_message(self):
        m = publish.alert_message(LATEST)
        self.assertEqual(m["title"], "Bot Desk: 2 new problems")
        self.assertEqual(m["body"], "Signals did not run (+1 more)")
        self.assertEqual(m["count"], 3)
        self.assertIsNone(publish.alert_message({"new_alerts": []}))

    def test_add_sub(self):
        with tempfile.TemporaryDirectory() as d:
            sub = {"endpoint": "https://web.push.apple.com/x", "keys": {"p256dh": "p", "auth": "a"}}
            code = "botdesk-alerts:" + base64.b64encode(json.dumps(sub).encode()).decode()
            class A: pass
            a = A(); a.secrets = d; a.code = code
            publish.cmd_add_sub(a); publish.cmd_add_sub(a)
            self.assertEqual(len(json.loads((pathlib.Path(d) / "push-subs.json").read_text())), 1)


if __name__ == "__main__":
    unittest.main()

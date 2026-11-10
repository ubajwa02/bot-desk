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
    def test_payload_groups_and_status_has_no_numbers(self):
        p = publish.payload(LATEST)
        self.assertEqual([x["group"] for x in p["projects"]], ["broken", "needs", "paused", "running", "needs"])
        self.assertEqual(len(p["projects"][0]["lines"]), 2)
        status_only = json.dumps({k: p[k] for k in ("alerts", "projects")})
        self.assertNotIn("pnl", status_only)
        self.assertNotIn("usd", status_only)
        self.assertEqual(p["nba_tonight"][0]["pick"], "X")
        self.assertIsNone(p["nba"])
        self.assertIsNone(p["jobs"])

    def test_trading_in_dollars(self):
        latest = dict(LATEST, today="2026-11-10", strategies=[
            {"id": "signals", "unit": "%", "summary": {"open": 1}, "trades": [
                {"date": "2026-11-04", "time": "10:00", "symbol": "MU", "state": "closed", "pnl": 3.05, "stop": 1, "entry": 2},
                {"date": "2026-10-01", "time": "10:00", "symbol": "AMD", "state": "closed", "pnl": -1.0}]},
            {"id": "spy-a", "name": "SPY a", "unit": "$", "trades": [{"date": "2026-11-04", "state": "closed", "pnl": 20.0}]},
            {"id": "spy-b", "name": "SPY b", "unit": "$", "trades": [{"date": "2026-11-05", "state": "closed", "pnl": -5.0}]}])
        t = publish.payload(latest)["trading"]
        orb, spy = t["systems"]
        self.assertEqual((orb["usd"], orb["usd_7d"], orb["wins"], orb["losses"], orb["open"]), (205.0, 305.0, 1, 1, 1))
        self.assertNotIn("stop", orb["trades"][0])           # no raw order levels, just results
        self.assertEqual((spy["usd"], spy["line"][-1], spy["trades"][0]["variant"]), (15.0, ["2026-11-05", 15.0], "SPY b"))
        self.assertEqual((t["total"]["usd"], t["total"]["last_day"], t["total"]["usd_last"]), (220.0, "2026-11-05", -5.0))

    def test_every_pick_gets_fd(self):
        fd = "https://sportsbook.fanduel.com/addToBetslip?marketId=42.{}&selectionId={}"
        rows = [{"kind": "all", "pick": "All 3"},
                {"kind": "pick", "pick": "A", "fd_url": fd.format(1, 11), "fd_label": "FD slip"},
                {"kind": "pick", "pick": "B", "fd_url": fd.format(2, 22), "fd_label": "FD slip"},
                {"kind": "pick", "pick": "C"}]
        out = publish.fill_fd(rows)
        self.assertTrue(all(r["fd_url"] for r in out))
        self.assertEqual(out[0]["fd_label"], "FD 2 of 3 on slip")
        self.assertIn("marketId[1]=42.2&selectionId[1]=22", out[0]["fd_url"])
        self.assertEqual((out[3]["fd_url"], out[3]["fd_missing"]), (publish.FD_NBA, True))
        self.assertNotIn("fd_missing", out[1])

    def test_all_straights_dk_built_when_missing(self):
        dk = "https://sportsbook.draftkings.com/?outcomes={}"
        rows = [{"kind": "pick", "pick": "A", "dk_url": dk.format("a%231"), "dk_label": "DK slip"},
                {"kind": "pick", "pick": "B", "dk_url": dk.format("b%232"), "dk_label": "DK slip"},
                {"kind": "pick", "pick": "C", "dk_url": "https://sportsbook.draftkings.com/event/1", "dk_label": "DK game"}]
        out = publish.fill_fd(rows)
        self.assertEqual(out[0]["kind"], "all")
        self.assertEqual(out[0]["dk_label"], "DK 2 of 3 on slip")
        self.assertEqual(out[0]["dk_url"], "https://sportsbook.draftkings.com/?outcomes=a%231+b%232")

    def test_jobs_whitelist(self):
        j = publish.jobs({"generated_at": "t", "applications": {"submitted_total": 2, "by_status": {"x": 1}},
                          "needs_you": {"apply_manually": 3}, "titles": ["Secret job"], "automation": {"kill_switch": True}})
        self.assertNotIn("Secret", json.dumps(j))
        self.assertNotIn("by_status", json.dumps(j))
        self.assertEqual((j["needs_you"]["apply_manually"], j["automation"]["kill_switch"]), (3, True))

    def test_nba_section(self):
        site = {"meta": {"today": "2026-11-09", "dry_run": True, "last_run": {"at": "x", "ok": True}},
                "performance": {"posted_leans": {"n": 3, "wins": 2, "losses": 1, "net_units": 0.5, "roi": 0.2,
                    "by_day": {"2026-11-07": {"net_units": 1.0, "wins": 1, "losses": 0}, "2026-11-08": {"net_units": -0.5, "wins": 1, "losses": 1}},
                    "by_market": {"prop": {"n": 3, "wins": 2, "losses": 1, "net_units": 0.5}},
                    "rows": [{"slate": "2026-11-08", "label": "A u1.5", "result": "win", "net_units": 0.55, "player_id": "9"},
                             {"slate": "2026-11-09", "label": "B", "result": "pending"}]}},
                "tickets": {"rows": [{"kind": "parlay", "result": "win", "net_units": 1.2, "legs": [1, 2]},
                                     {"kind": "lotto", "result": "loss", "net_units": -1, "legs": [1, 2, 3, 4, 5]}]},
                "today": {"date": "2026-11-09", "games": [{"home": "GS", "away": "NO", "start_utc": "2026-11-10T03:00Z", "game_id": "1"}]}}
        n = publish.nba(site)
        self.assertEqual(n["line"], [["2026-11-07", 1.0], ["2026-11-08", 0.5]])
        self.assertEqual((n["last_slate"], n["last_results"][0]["units"]), ("2026-11-08", 0.55))
        self.assertNotIn("player_id", json.dumps(n))
        self.assertEqual((n["tickets"]["parlay"]["units"], n["tickets"]["lotto"]["losses"]), (1.2, 1))
        self.assertEqual(n["games"][0]["home"], "GS")

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

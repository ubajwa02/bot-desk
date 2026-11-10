#!/usr/bin/env python3
"""Turn the Team Desk collector's latest.json into Bot Desk's encrypted status file, upload it, and send alerts.

Secrets (the data key, the alert-signing key, phone subscriptions) live outside this repo, in a folder passed with
--secrets. Nothing secret is ever written into the repo or printed.

  publish.py build    --latest latest.json --secrets DIR --out desk.enc.json   # encrypt only
  publish.py upload   --file desk.enc.json [--repo ubajwa02/bot-desk]          # write it to the `data` branch
  publish.py push     --latest latest.json --secrets DIR                        # alert phones about new problems
  publish.py add-sub  --secrets DIR CODE                                        # save a phone's "alert code"
  publish.py all      --latest latest.json --secrets DIR                        # build + upload + push
"""
import argparse
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import webpush  # noqa: E402

REPO = "ubajwa02/bot-desk"
DATA_BRANCH = "data"
DATA_PATH = "desk.enc.json"
SUBJECT = "https://ubajwa02.github.io/bot-desk/"
PROJECT_FIELDS = ("id", "name", "status", "lines", "url")
ALERT_FIELDS = ("id", "level", "project", "title", "detail", "url")
NBA_FIELDS = ("key", "kind", "parent", "pick", "matchup", "started", "win_pct", "price", "dk_url", "dk_label", "fd_url", "fd_label")


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def group_of(p: dict) -> str:
    """Same rule as Team Desk: error=broken, warn or the PR row=needs you, first line 'Paused'=paused, else running."""
    first = (p.get("lines") or [""])[0]
    if p.get("status") == "error":
        return "broken"
    if p.get("status") == "warn" or p.get("id") == "prs":
        return "needs"
    if first.lower().startswith("paused"):
        return "paused"
    return "running"


def payload(latest: dict) -> dict:
    """Statuses only: problems, project rows, tonight's NBA picks. No trades or P&L."""
    projects = []
    for p in latest.get("projects") or []:
        row = {k: p.get(k) for k in PROJECT_FIELDS}
        row["lines"] = list(row.get("lines") or [])[:2]
        row["group"] = group_of(p)
        projects.append(row)
    nba = next((s.get("tonight") or [] for s in latest.get("strategies") or [] if s.get("id") == "nba"), [])
    return {
        "v": 1,
        "generated_at": latest.get("generated_at"),
        "alerts": [{k: a.get(k) for k in ALERT_FIELDS} for a in latest.get("alerts") or []],
        "projects": projects,
        "nba_tonight": [{k: r.get(k) for k in NBA_FIELDS} for r in nba],
    }


def read_key(secrets: pathlib.Path) -> bytes:
    raw = (secrets / "desk.key").read_text().strip()
    key = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    if len(key) != 32:
        raise SystemExit("desk.key must be 32 bytes, base64url")
    return key


def seal(obj: dict, key: bytes) -> dict:
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode(), None)
    return {"v": 1, "iv": b64u(iv), "ct": b64u(ct)}


def cmd_build(a):
    latest = json.loads(pathlib.Path(a.latest).read_text())
    box = seal(payload(latest), read_key(pathlib.Path(a.secrets)))
    pathlib.Path(a.out).write_text(json.dumps(box))
    print(json.dumps({"built": a.out, "bytes": len(json.dumps(box))}))
    return a.out


def gh(*args, input_obj=None):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        if input_obj is not None:
            json.dump(input_obj, f)
        name = f.name
    try:
        cmd = ["gh", "api", *args] + (["--input", name] if input_obj is not None else [])
        r = subprocess.run(cmd, capture_output=True, text=True)
        return r.returncode, (json.loads(r.stdout) if r.stdout.strip().startswith(("{", "[")) else r.stdout)
    finally:
        os.unlink(name)


def cmd_upload(a):
    repo = a.repo
    content = base64.b64encode(pathlib.Path(a.file).read_bytes()).decode()
    code, ref = gh(f"repos/{repo}/git/ref/heads/{DATA_BRANCH}")
    if code != 0:
        # First run: make `data` an orphan branch holding only the encrypted file.
        code, tree = gh("-X", "POST", f"repos/{repo}/git/trees",
                        input_obj={"tree": [{"path": DATA_PATH, "mode": "100644", "type": "blob",
                                             "content": pathlib.Path(a.file).read_text()}]})
        if code: raise SystemExit(f"tree failed: {tree}")
        code, commit = gh("-X", "POST", f"repos/{repo}/git/commits", input_obj={"message": "data: first status file", "tree": tree["sha"], "parents": []})
        if code: raise SystemExit(f"commit failed: {commit}")
        code, out = gh("-X", "POST", f"repos/{repo}/git/refs", input_obj={"ref": f"refs/heads/{DATA_BRANCH}", "sha": commit["sha"]})
        if code: raise SystemExit(f"ref failed: {out}")
        print(json.dumps({"uploaded": f"{repo}@{DATA_BRANCH}", "created_branch": True}))
        return
    code, cur = gh(f"repos/{repo}/contents/{DATA_PATH}?ref={DATA_BRANCH}")
    body = {"message": "data: refresh", "content": content, "branch": DATA_BRANCH}
    if code == 0 and isinstance(cur, dict):
        body["sha"] = cur["sha"]
    code, out = gh("-X", "PUT", f"repos/{repo}/contents/{DATA_PATH}", input_obj=body)
    if code:
        raise SystemExit(f"upload failed: {str(out)[:300]}")
    print(json.dumps({"uploaded": f"{repo}@{DATA_BRANCH}", "commit": out["commit"]["sha"][:7]}))


def subs_path(secrets: pathlib.Path) -> pathlib.Path:
    return secrets / "push-subs.json"


def load_subs(secrets: pathlib.Path) -> list:
    p = subs_path(secrets)
    return json.loads(p.read_text()) if p.exists() else []


def cmd_add_sub(a):
    code = a.code.strip()
    if code.startswith("botdesk-alerts:"):
        code = code.split(":", 1)[1]
    sub = json.loads(base64.b64decode(code + "=" * (-len(code) % 4)))
    if not str(sub.get("endpoint", "")).startswith("https://") or not sub.get("keys", {}).get("p256dh"):
        raise SystemExit("not a Bot Desk alert code")
    secrets = pathlib.Path(a.secrets)
    subs = [s for s in load_subs(secrets) if s["endpoint"] != sub["endpoint"]] + [{"endpoint": sub["endpoint"], "keys": sub["keys"]}]
    subs_path(secrets).write_text(json.dumps(subs, indent=1))
    print(json.dumps({"subscriptions": len(subs), "service": sub["endpoint"].split("/")[2]}))


def alert_message(latest: dict):
    new = latest.get("new_alerts") or []
    if not new:
        return None
    p = payload(latest)
    count = sum(1 for x in p["projects"] if x["group"] in ("broken", "needs"))
    title = "Bot Desk: new problem" if len(new) == 1 else f"Bot Desk: {len(new)} new problems"
    body = new[0].get("title") or "Something needs a look"
    if len(new) > 1:
        body += f" (+{len(new) - 1} more)"
    return {"title": title, "body": body, "count": count, "tag": "bot-desk-" + str(latest.get("generated_at", ""))}


def cmd_push(a, msg=None):
    secrets = pathlib.Path(a.secrets)
    latest = json.loads(pathlib.Path(a.latest).read_text())
    msg = msg or (json.loads(a.message) if getattr(a, "message", None) else alert_message(latest))
    subs = load_subs(secrets)
    if not msg or not subs:
        print(json.dumps({"pushed": 0, "reason": "no new problems" if not msg else "no phones signed up"}))
        return
    pem = (secrets / "vapid_private.pem").read_bytes()
    keep, results = [], []
    for s in subs:
        status, reason = webpush.send(s, msg, pem, SUBJECT)
        results.append(status)
        if status not in (404, 410):
            keep.append(s)
    if len(keep) != len(subs):
        subs_path(secrets).write_text(json.dumps(keep, indent=1))
    print(json.dumps({"pushed": sum(1 for x in results if 200 <= x < 300), "statuses": results, "dropped": len(subs) - len(keep)}))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    b = sp.add_parser("build"); b.add_argument("--latest", required=True); b.add_argument("--secrets", required=True); b.add_argument("--out", default="desk.enc.json")
    u = sp.add_parser("upload"); u.add_argument("--file", default="desk.enc.json"); u.add_argument("--repo", default=REPO)
    p = sp.add_parser("push"); p.add_argument("--latest", required=True); p.add_argument("--secrets", required=True)
    p.add_argument("--message", help='JSON {"title","body"} to send instead of the new-problems alert (e.g. a test)')
    s = sp.add_parser("add-sub"); s.add_argument("--secrets", required=True); s.add_argument("code")
    al = sp.add_parser("all"); al.add_argument("--latest", required=True); al.add_argument("--secrets", required=True)
    al.add_argument("--out", default="desk.enc.json"); al.add_argument("--repo", default=REPO)
    a = ap.parse_args()
    if a.cmd == "build": cmd_build(a)
    elif a.cmd == "upload": cmd_upload(a)
    elif a.cmd == "push": cmd_push(a)
    elif a.cmd == "add-sub": cmd_add_sub(a)
    elif a.cmd == "all":
        cmd_build(a); a.file = a.out; cmd_upload(a); cmd_push(a)


if __name__ == "__main__":
    main()

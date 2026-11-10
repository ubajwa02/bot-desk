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
import time

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


TRADING = (  # bot id, name, health row it belongs to, how a strategy id maps to it (same as Team Desk)
    ("orb", "ORB Signals", "tradebot", lambda sid: sid == "signals"),
    ("contra", "Contra-ORB", "contra-orb", lambda sid: sid == "contra"),
    ("spy", "SPY 0DTE", "spy-0dte", lambda sid: sid.startswith("spy-")),
)
PICKS = (("soccer", "Soccer picks", "soccer-picks"),)  # NBA has its own tab (nba())
TRADE_FIELDS = ("date", "time", "symbol", "side", "setup", "exit", "state")
DAY_FIELDS = ("date", "n", "wins", "losses")
JOB_FIELDS = {  # counts and switch states only, exactly what JobBoard's status.json carries (never titles or employers)
    "generated_at": None, "last_run": ("status", "finished_at", "new_jobs"), "sources_ok": None, "sources_failed": None,
    "new_24h": None, "applications": ("submitted_total", "submitted_today"),
    "needs_you": ("ready_to_submit", "uncertain_submissions", "apply_manually", "questions", "failed_sources"),
    "automation": ("mode", "submission_enabled", "kill_switch", "attempts_today", "daily_cap"),
    "health": ("overall", "failing", "warning"), "backup_age_hours": None,
}


def usd(pnl, unit):
    """Team Desk sizing: $10k per stock trade (P&L in %), SPY 1 contract per leg (already in $)."""
    if pnl is None:
        return None
    return round(pnl * 100, 2) if unit == "%" else round(pnl, 2)


def _day_minus(day: str, n: int) -> str:
    import datetime as dt
    return (dt.date.fromisoformat(day) - dt.timedelta(days=n)).isoformat()


def trading(latest: dict) -> dict:
    """Per-system results in dollars: totals, last 7 days, last session, cumulative line, recent trades."""
    today = (latest.get("today") or str(latest.get("generated_at") or "")[:10]) or "1970-01-01"
    week_ago = _day_minus(today, 7)
    status = {p.get("id"): (p.get("lines") or [""])[0] for p in latest.get("projects") or []}
    systems, all_days = [], {}
    for bot, name, project, match in TRADING:
        strats = [s for s in latest.get("strategies") or [] if match(str(s.get("id", "")))]
        if not strats:
            continue
        trades, open_n = [], 0
        for s in strats:
            open_n += int((s.get("summary") or {}).get("open") or 0)
            label = s.get("name") if len(strats) > 1 else None
            for t in s.get("trades") or []:
                row = {k: t.get(k) for k in TRADE_FIELDS}
                row["usd"] = usd(t.get("pnl"), s.get("unit"))
                if label:
                    row["variant"] = label
                trades.append(row)
        closed = [t for t in trades if t["state"] == "closed" and t["usd"] is not None]
        by_day = {}
        for t in closed:
            by_day[t["date"]] = round(by_day.get(t["date"], 0) + t["usd"], 2)
            all_days[t["date"]] = round(all_days.get(t["date"], 0) + t["usd"], 2)
        cum, line = 0.0, []
        for d in sorted(by_day):
            cum += by_day[d]
            line.append([d, round(cum, 2)])
        last = max(by_day) if by_day else None
        trades.sort(key=lambda t: (t["date"] or "", t["time"] or ""), reverse=True)
        systems.append({
            "id": bot, "name": name, "status": status.get(project, ""),
            "n": len(closed), "wins": sum(1 for t in closed if t["usd"] > 0), "losses": sum(1 for t in closed if t["usd"] <= 0),
            "open": open_n, "usd": round(sum(t["usd"] for t in closed), 2),
            "usd_7d": round(sum(v for d, v in by_day.items() if d > week_ago), 2),
            "last_day": last, "usd_last": by_day.get(last) if last else None,
            "line": line, "trades": trades[:12],
            "since": min(by_day) if by_day else None,
        })
    last = max(all_days) if all_days else None
    return {
        "systems": systems,
        "total": {"usd": round(sum(all_days.values()), 2), "usd_7d": round(sum(v for d, v in all_days.items() if d > week_ago), 2),
                  "last_day": last, "usd_last": all_days.get(last) if last else None},
        "days": [[d, all_days[d]] for d in sorted(all_days)][-30:],
        "sizing": "$10k per stock trade, SPY 1 contract per leg. Paper and signal results, not a brokerage statement.",
    }


def picks(latest: dict) -> list:
    """Other picks (soccer) in units, with the last days. NBA has its own section, nba()."""
    today = (latest.get("today") or str(latest.get("generated_at") or "")[:10]) or "1970-01-01"
    week_ago = _day_minus(today, 7)
    status = {p.get("id"): (p.get("lines") or [""])[0] for p in latest.get("projects") or []}
    out = []
    for sid, name, project in PICKS:
        s = next((x for x in latest.get("strategies") or [] if x.get("id") == sid), None)
        if not s:
            continue
        m = s.get("summary") or {}
        days = []
        for r in s.get("daily") or []:
            row = {k: r.get(k) for k in DAY_FIELDS}
            row["units"] = round(float(r.get("pnl") or 0), 2)
            days.append(row)
        days.sort(key=lambda r: r["date"] or "")
        out.append({
            "id": sid, "name": name, "status": status.get(project, ""),
            "n": m.get("n", 0), "wins": m.get("wins", 0), "losses": m.get("losses", 0),
            "units": round(float(m.get("pnl") or 0), 2), "roi": m.get("roi"), "pending": s.get("pending", m.get("open", 0)),
            "units_7d": round(sum(r["units"] for r in days if (r["date"] or "") > week_ago), 2),
            "days": days[-14:],
        })
    return out


def jobs(status: dict | None):
    """Whitelist JobBoard's counts-only status.json (or None when the Mac hasn't published one yet)."""
    if not isinstance(status, dict):
        return None
    out = {}
    for k, sub in JOB_FIELDS.items():
        v = status.get(k)
        if sub is None:
            out[k] = v if isinstance(v, (int, float, str, type(None))) else None
        elif isinstance(v, dict):
            out[k] = {f: v.get(f) for f in sub}
    for k in ("failing", "warning"):  # health check names, not job data; keep them short
        if isinstance((out.get("health") or {}).get(k), list):
            out["health"][k] = [str(x)[:80] for x in out["health"][k]][:8]
    return out


def fetch_jobs():
    """Read JobBoard's status.json from its private repo's `jobboard-status` branch. Best effort: None on any failure."""
    try:
        r = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github.raw+json",
                            "repos/ubajwa02/job-search-dashboard/contents/status.json?ref=jobboard-status"],
                           capture_output=True, text=True, timeout=60)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:  # noqa: BLE001 - no gh, no network, branch not there yet
        return None


LEAN_FIELDS = ("label", "matchup", "market", "price_american", "prob", "result", "stat_value", "line", "score")


def _rec(x: dict) -> dict:
    return {"n": x.get("n", 0), "wins": x.get("wins", 0), "losses": x.get("losses", 0), "pending": x.get("pending", 0),
            "units": round(float(x.get("net_units") or 0), 2), "roi": x.get("roi"), "hit_rate": x.get("hit_rate")}


def nba(site: dict | None):
    """NBA picks in depth, from nba-picks site/data.json: record, by market, daily units, last results, parlays, tonight's games."""
    if not isinstance(site, dict):
        return None
    perf = (site.get("performance") or {}).get("posted_leans") or {}
    meta, today = site.get("meta") or {}, site.get("today") or {}
    days = sorted((perf.get("by_day") or {}).items())
    cum, line = 0.0, []
    for d, r in days:
        cum += float(r.get("net_units") or 0)
        line.append([d, round(cum, 2)])
    rows = perf.get("rows") or []
    settled_slates = sorted({r.get("slate") for r in rows if r.get("result") in ("win", "loss", "push", "void")})
    last_slate = settled_slates[-1] if settled_slates else None
    last = [{k: r.get(k) for k in LEAN_FIELDS} | {"units": None if r.get("net_units") is None else round(r["net_units"], 2)}
            for r in rows if r.get("slate") == last_slate]
    tickets = (site.get("tickets") or {}).get("rows") or []
    tix = {}
    for kind in ("parlay", "lotto"):
        ts = [t for t in tickets if t.get("kind") == kind]
        done = [t for t in ts if t.get("result") in ("win", "loss")]
        tix[kind] = {"n": len(done), "wins": sum(1 for t in done if t["result"] == "win"),
                     "losses": sum(1 for t in done if t["result"] == "loss"),
                     "units": round(sum(float(t.get("net_units") or 0) for t in done), 2),
                     "recent": [{"slate": t.get("slate"), "result": t.get("result"), "legs": len(t.get("legs") or []),
                                 "price": t.get("price_american"),
                                 "units": None if t.get("net_units") is None else round(t["net_units"], 2)} for t in ts[:7]]}
    week_ago = _day_minus(meta.get("today") or (days[-1][0] if days else "1970-01-01"), 7)
    last_run = meta.get("last_run") or {}
    return {
        "record": _rec(perf) | {"drawdown": (perf.get("advanced") or {}).get("max_drawdown_units"), "since": days[0][0] if days else None},
        "units_7d": round(sum(float(r.get("net_units") or 0) for d, r in days if d > week_ago), 2),
        "by_market": [{"market": k} | _rec(v) for k, v in sorted((perf.get("by_market") or {}).items(), key=lambda kv: -kv[1].get("n", 0))],
        "line": line,
        "days": [[d, round(float(r.get("net_units") or 0), 2), r.get("wins", 0), r.get("losses", 0)] for d, r in days][-14:],
        "last_slate": last_slate, "last_results": last,
        "tickets": tix,
        "games": [{k: g.get(k) for k in ("start_utc", "home", "away", "status", "home_score", "away_score")} for g in today.get("games") or []],
        "slate": today.get("date"),
        "pipeline": {"at": last_run.get("at"), "ok": last_run.get("ok"), "dry_run": meta.get("dry_run"), "paused": meta.get("paused"),
                     "warnings": [str(w)[:120] for w in meta.get("warnings") or []][:5], "odds_stale": (meta.get("stale") or {}).get("odds")},
    }


def fetch_nba():
    """nba-picks site/data.json (private repo) via gh. Best effort: None on any failure."""
    try:
        r = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github.raw+json",
                            "repos/ubajwa02/nba-picks/contents/site/data.json"], capture_output=True, text=True, timeout=120)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:  # noqa: BLE001
        return None


FD_NBA = "https://sportsbook.fanduel.com/navigation/nba"


def _fd_parlay(urls):
    """Join FanDuel addToBetslip links (marketId/selectionId) into one slip, the same way the collector builds parlays."""
    from urllib.parse import urlparse, parse_qs, quote
    pairs = []
    for u in urls:
        q = parse_qs(urlparse(u).query)
        m, sel = (q.get("marketId") or [""])[0], (q.get("selectionId") or [""])[0]
        if not (m and sel):
            return None
        pairs.append((m, sel))
    return "https://sportsbook.fanduel.com/addToBetslip?" + "&".join(
        f"marketId[{i}]={quote(m, safe='')}&selectionId[{i}]={quote(sel, safe='')}" for i, (m, sel) in enumerate(pairs))


def fill_fd(rows: list) -> list:
    """Every pick gets a FanDuel button. Where FanDuel's feed has no slip for that exact bet, the button opens FanDuel's
    NBA page and says so ("not on FD slip"), and the all-straights slip is built from the picks FanDuel does offer."""
    rows = [dict(r) for r in rows]
    slips = [r for r in rows if r.get("kind") == "pick" and not r.get("started") and r.get("fd_url") and "slip" in (r.get("fd_label") or "")]
    picks = [r for r in rows if r.get("kind") == "pick" and not r.get("started")]
    for r in rows:
        if r.get("fd_url"):
            continue
        if r.get("kind") == "all" and len(slips) >= 2:
            u = _fd_parlay([x["fd_url"] for x in slips])
            if u:
                r["fd_url"], r["fd_label"] = u, f"FD {len(slips)} of {len(picks)} on slip"
                continue
        if r.get("kind") in ("pick", "leg", "parlay", "all"):
            r["fd_url"], r["fd_label"] = FD_NBA, "FD (not on FD slip)"
            r["fd_missing"] = True
    return rows


def payload(latest: dict, job_status: dict | None = None, nba_site: dict | None = None) -> dict:
    """Status tab: problems, project rows (no numbers). Trading, Picks and Jobs tabs: their own sections."""
    projects = []
    for p in latest.get("projects") or []:
        row = {k: p.get(k) for k in PROJECT_FIELDS}
        row["lines"] = list(row.get("lines") or [])[:2]
        row["group"] = group_of(p)
        projects.append(row)
    tonight = next((s.get("tonight") or [] for s in latest.get("strategies") or [] if s.get("id") == "nba"), [])
    return {
        "v": 1,
        "generated_at": latest.get("generated_at"),
        "alerts": [{k: a.get(k) for k in ALERT_FIELDS} for a in latest.get("alerts") or []],
        "projects": projects,
        "nba_tonight": fill_fd([{k: r.get(k) for k in NBA_FIELDS} for r in tonight]),
        "trading": trading(latest),
        "picks": picks(latest),
        "nba": nba(nba_site),
        "jobs": jobs(job_status),
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
    job_status = json.loads(pathlib.Path(a.jobs).read_text()) if getattr(a, "jobs", None) else fetch_jobs()
    nba_site = json.loads(pathlib.Path(a.nba).read_text()) if getattr(a, "nba", None) else fetch_nba()
    box = seal(payload(latest, job_status, nba_site), read_key(pathlib.Path(a.secrets)))
    pathlib.Path(a.out).write_text(json.dumps(box))
    print(json.dumps({"built": a.out, "bytes": len(json.dumps(box)), "jobs": job_status is not None, "nba": nba_site is not None}))
    return a.out


def cmd_upload(a):
    """Commit the file to the `data` branch with plain git (Claude sessions can push, but not write via the REST API)."""
    src = pathlib.Path(a.file).resolve()
    url = f"https://github.com/{a.repo}"
    with tempfile.TemporaryDirectory() as d:
        run = lambda *c: subprocess.run(c, cwd=d, capture_output=True, text=True)
        r = run("git", "clone", "-q", "--depth", "1", "--branch", DATA_BRANCH, url, ".")
        created = r.returncode != 0
        if created:  # first run: `data` is an orphan branch holding only the encrypted file
            run("git", "init", "-q"); run("git", "checkout", "-q", "--orphan", DATA_BRANCH); run("git", "remote", "add", "origin", url)
        (pathlib.Path(d) / DATA_PATH).write_bytes(src.read_bytes())
        run("git", "add", DATA_PATH)
        r = run("git", "-c", "user.name=Claude", "-c", "user.email=noreply@anthropic.com", "commit", "-q", "-m", "data: refresh")
        if r.returncode != 0 and "nothing to commit" in (r.stdout + r.stderr):
            print(json.dumps({"uploaded": False, "reason": "unchanged"}))
            return
        for wait in (0, 2, 4, 8, 16):
            time.sleep(wait)
            r = run("git", "push", "-q", "origin", DATA_BRANCH)
            if r.returncode == 0:
                break
        if r.returncode != 0:
            raise SystemExit(f"upload failed: {r.stderr.strip()[:300]}")
        sha = run("git", "rev-parse", "--short", "HEAD").stdout.strip()
    print(json.dumps({"uploaded": f"{a.repo}@{DATA_BRANCH}", "commit": sha, "created_branch": created}))


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
    b.add_argument("--jobs", help="JobBoard status.json to use instead of fetching it from GitHub")
    b.add_argument("--nba", help="nba-picks site/data.json to use instead of fetching it from GitHub")
    u = sp.add_parser("upload"); u.add_argument("--file", default="desk.enc.json"); u.add_argument("--repo", default=REPO)
    p = sp.add_parser("push"); p.add_argument("--latest", required=True); p.add_argument("--secrets", required=True)
    p.add_argument("--message", help='JSON {"title","body"} to send instead of the new-problems alert (e.g. a test)')
    s = sp.add_parser("add-sub"); s.add_argument("--secrets", required=True); s.add_argument("code")
    al = sp.add_parser("all"); al.add_argument("--latest", required=True); al.add_argument("--secrets", required=True)
    al.add_argument("--out", default="desk.enc.json"); al.add_argument("--repo", default=REPO)
    al.add_argument("--jobs", help="JobBoard status.json to use instead of fetching it from GitHub")
    al.add_argument("--nba", help="nba-picks site/data.json to use instead of fetching it from GitHub")
    a = ap.parse_args()
    if a.cmd == "build": cmd_build(a)
    elif a.cmd == "upload": cmd_upload(a)
    elif a.cmd == "push": cmd_push(a)
    elif a.cmd == "add-sub": cmd_add_sub(a)
    elif a.cmd == "all":
        cmd_build(a); a.file = a.out; cmd_upload(a); cmd_push(a)


if __name__ == "__main__":
    main()

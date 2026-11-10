/* Bot Desk: installable status app. Reads an encrypted status file, decrypts it on the phone, draws it. */
(function () {
  "use strict";
  var CFG = window.DESK_CONFIG || {};
  var KEY_STORE = "deskKey";
  var LAST_STORE = "deskLast";
  var TAB_STORE = "deskTab";
  var STALE_HOURS = 6;
  var $ = function (id) { return document.getElementById(id); };
  var standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  var swReg = null;

  // ---------- small helpers ----------
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function safeUrl(u) { return typeof u === "string" && /^https:\/\//i.test(u) ? u : null; }
  function b64urlToBytes(s) {
    s = String(s).trim().replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return "unknown";
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " days ago";
  }
  function hoursOld(iso) { var t = Date.parse(iso); return t ? (Date.now() - t) / 3600000 : Infinity; }

  // ---------- key ----------
  function keyFromHash() {
    var m = /[#&]k=([A-Za-z0-9_\-]+)/.exec(location.hash || "");
    return m ? m[1] : null;
  }
  function validKey(k) {
    try { return b64urlToBytes(k).length === 32; } catch (e) { return false; }
  }
  function getKey() {
    var h = keyFromHash();
    if (h && validKey(h)) store(KEY_STORE, h);
    return load(KEY_STORE);
  }

  // ---------- data ----------
  async function decrypt(box, key) {
    if (!box || box.v !== 1 || !box.iv || !box.ct) throw new Error("Unexpected data format");
    var ck = await crypto.subtle.importKey("raw", b64urlToBytes(key), { name: "AES-GCM" }, false, ["decrypt"]);
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(box.iv) }, ck, b64urlToBytes(box.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function fetchBox() {
    var urls = CFG.dataUrls || [];
    var lastErr = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var u = urls[i] + (urls[i].indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
        var r = await fetch(u, { cache: "no-store", headers: urls[i].indexOf("api.github.com") >= 0 ? { Accept: "application/vnd.github.raw+json" } : {} });
        if (!r.ok) throw new Error("HTTP " + r.status);
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("No data address set");
  }

  // ---------- grouping ----------
  var GROUPS = [
    { id: "broken", label: "Broken" },
    { id: "needs", label: "Needs you" },
    { id: "running", label: "Running" },
    { id: "paused", label: "Paused" }
  ];
  function groupOf(p) {
    if (p.group) return p.group;
    var first = (p.lines && p.lines[0]) || "";
    if (p.status === "error") return "broken";
    if (p.status === "warn" || p.id === "prs") return "needs";
    if (/^Paused/i.test(first)) return "paused";
    return "running";
  }

  // ---------- render ----------
  function render(d) {
    var projects = (d.projects || []).map(function (p) { return Object.assign({}, p, { group: groupOf(p) }); });
    var alerts = d.alerts || [];
    var counts = {};
    GROUPS.forEach(function (g) { counts[g.id] = 0; });
    projects.forEach(function (p) { counts[p.group] = (counts[p.group] || 0) + 1; });

    // updated line + staleness
    $("updated").textContent = "Updated " + ago(d.generated_at);
    var old = hoursOld(d.generated_at);
    showBanner(old > STALE_HOURS ? "These statuses are " + ago(d.generated_at).replace(" ago", "") + " old. The next refresh should update them." : null);

    // counts
    var c = $("counts");
    c.textContent = "";
    GROUPS.forEach(function (g) {
      var a = el("a", "count " + g.id + (counts[g.id] ? " on" : ""));
      a.href = "#g-" + g.id;
      a.appendChild(el("b", null, counts[g.id]));
      a.appendChild(el("span", null, g.label));
      c.appendChild(a);
    });

    // problems
    var pr = $("problems");
    pr.textContent = "";
    if (!alerts.length) pr.appendChild(el("div", "empty", "No problems right now."));
    alerts.forEach(function (a) {
      var url = safeUrl(a.url);
      var it = el(url ? "a" : "div", "item " + (a.level === "error" ? "error" : a.level === "warn" ? "warn" : ""));
      if (url) { it.href = url; it.target = "_blank"; it.rel = "noopener"; }
      var t = el("div", "t");
      t.appendChild(el("span", "dot " + (a.level || "info")));
      t.appendChild(el("span", "name", a.title));
      if (url) t.appendChild(el("span", "chev", "›"));
      it.appendChild(t);
      if (a.detail) it.appendChild(el("div", "l", a.detail));
      pr.appendChild(it);
    });

    // project groups
    var gs = $("groups");
    gs.textContent = "";
    GROUPS.forEach(function (g) {
      var rows = projects.filter(function (p) { return p.group === g.id; });
      if (!rows.length) return;
      var h = el("h2", "sec", g.label);
      h.id = "g-" + g.id;
      gs.appendChild(h);
      var list = el("div", "list");
      rows.forEach(function (p) {
        var url = safeUrl(p.url);
        var it = el(url ? "a" : "div", "item");
        if (url) { it.href = url; it.target = "_blank"; it.rel = "noopener"; }
        var t = el("div", "t");
        t.appendChild(el("span", "dot " + g.id));
        t.appendChild(el("span", "name", p.name));
        if (url) t.appendChild(el("span", "chev", "›"));
        it.appendChild(t);
        (p.lines || []).slice(0, 2).forEach(function (line) { it.appendChild(el("div", "l", line)); });
        list.appendChild(it);
      });
      gs.appendChild(list);
    });

    renderNba(d.nba_tonight || []);
    renderTrading(d.trading);
    renderNbaTab(d.nba);
    renderPicks(d.picks);
    renderJobs(d.jobs);
    var bad = counts.broken + counts.needs;
    tabBadge("status", bad);
    setBadge(bad);
  }

  // ---------- numbers ----------
  function money(v, signed) {
    if (v == null || isNaN(v)) return "–";
    var a = Math.abs(v), s = a >= 1000 ? "$" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k" : "$" + a.toFixed(a >= 100 ? 0 : 2).replace(/\.00$/, "");
    return (v < 0 ? "−" : signed ? "+" : "") + s;
  }
  function units(v) {
    if (v == null || isNaN(v)) return "–";
    return (v < 0 ? "−" : "+") + Math.abs(v).toFixed(2) + "u";
  }
  function tone(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }
  function shortDay(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T12:00:00");
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function stat(label, value, cls) {
    var b = el("div", "stat");
    b.appendChild(el("b", cls || null, value));
    b.appendChild(el("span", null, label));
    return b;
  }

  // Small SVG line of a running total; zero line dashed.
  var SVGNS = "http://www.w3.org/2000/svg";
  function spark(points) {
    var w = 300, h = 56, pad = 3;
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("class", "spark");
    svg.setAttribute("aria-hidden", "true");
    if (!points || points.length < 2) return svg;
    var ys = points.map(function (p) { return p[1]; }).concat([0]);
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), span = hi - lo || 1;
    var X = function (i) { return pad + i * (w - 2 * pad) / (points.length - 1); };
    var Y = function (v) { return pad + (hi - v) * (h - 2 * pad) / span; };
    var zero = document.createElementNS(SVGNS, "line");
    zero.setAttribute("x1", 0); zero.setAttribute("x2", w); zero.setAttribute("y1", Y(0)); zero.setAttribute("y2", Y(0));
    zero.setAttribute("class", "zero");
    svg.appendChild(zero);
    var path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", points.map(function (p, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join(""));
    path.setAttribute("class", "ln " + tone(points[points.length - 1][1]));
    svg.appendChild(path);
    return svg;
  }
  // Daily bars (green up, red down) on one scale.
  function bars(days) {
    var w = 300, h = 64, gap = 2;
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("class", "bars");
    svg.setAttribute("aria-hidden", "true");
    if (!days || !days.length) return svg;
    var m = Math.max.apply(null, days.map(function (d) { return Math.abs(d[1]); })) || 1;
    var bw = Math.min(24, (w - gap * days.length) / days.length), mid = h / 2;
    days.forEach(function (d, i) {
      var r = document.createElementNS(SVGNS, "rect"), bh = Math.max(1, Math.abs(d[1]) / m * (mid - 2));
      r.setAttribute("x", (w - days.length * (bw + gap)) + i * (bw + gap));
      r.setAttribute("width", bw);
      r.setAttribute("y", d[1] >= 0 ? mid - bh : mid);
      r.setAttribute("height", bh);
      r.setAttribute("rx", 2);
      r.setAttribute("class", tone(d[1]) || "flat");
      svg.appendChild(r);
    });
    return svg;
  }

  // ---------- trading tab ----------
  function renderTrading(t) {
    var box = $("trading");
    box.textContent = "";
    if (!t || !(t.systems || []).length) { box.appendChild(el("div", "empty", "No trading results in this update.")); return; }
    var tot = t.total || {};
    var hero = el("div", "card hero");
    hero.appendChild(el("div", "label", "All systems since live"));
    hero.appendChild(el("div", "big " + tone(tot.usd), money(tot.usd, true)));
    var row = el("div", "stats");
    row.appendChild(stat("Last 7 days", money(tot.usd_7d, true), tone(tot.usd_7d)));
    row.appendChild(stat(tot.last_day ? "Last session · " + shortDay(tot.last_day) : "Last session", money(tot.usd_last, true), tone(tot.usd_last)));
    hero.appendChild(row);
    hero.appendChild(bars(t.days));
    hero.appendChild(el("div", "note", "Daily total, last " + (t.days || []).length + " trading days"));
    box.appendChild(hero);

    box.appendChild(el("h2", "sec", "Systems"));
    t.systems.forEach(function (s) {
      var c = el("div", "card sys");
      var head = el("div", "t");
      head.appendChild(el("span", "name", s.name));
      head.appendChild(el("span", "amt " + tone(s.usd), money(s.usd, true)));
      c.appendChild(head);
      if (s.status) c.appendChild(el("div", "l", s.status));
      var st = el("div", "stats");
      st.appendChild(stat("Record", s.wins + "–" + s.losses));
      st.appendChild(stat("7 days", money(s.usd_7d, true), tone(s.usd_7d)));
      st.appendChild(stat("Open", s.open || 0));
      c.appendChild(st);
      c.appendChild(spark(s.line));
      if ((s.trades || []).length) {
        var det = el("details", "trades");
        det.appendChild(el("summary", null, "Recent trades"));
        s.trades.forEach(function (x) {
          var r = el("div", "trade");
          var left = el("div", "tl");
          left.appendChild(el("b", null, [x.symbol, x.side].filter(Boolean).join(" ")));
          left.appendChild(el("span", null, [shortDay(x.date), x.time, x.variant || x.setup, x.exit].filter(Boolean).join(" · ")));
          r.appendChild(left);
          r.appendChild(el("span", "amt " + tone(x.usd), x.state === "closed" ? money(x.usd, true) : (x.state || "open")));
          det.appendChild(r);
        });
        c.appendChild(det);
      }
      if (s.since) c.appendChild(el("div", "note", "Since " + shortDay(s.since) + " · " + s.n + " closed trades"));
      box.appendChild(c);
    });
    if (t.sizing) box.appendChild(el("p", "note pad", t.sizing));
  }

  // ---------- picks tab ----------
  function renderPicks(list) {
    var box = $("picks");
    box.textContent = "";
    if (!list || !list.length) return;
    box.appendChild(el("h2", "sec", "Other picks"));
    list.forEach(function (p) {
      var c = el("div", "card sys");
      var head = el("div", "t");
      head.appendChild(el("span", "name", p.name));
      head.appendChild(el("span", "amt " + tone(p.units), units(p.units)));
      c.appendChild(head);
      if (p.status) c.appendChild(el("div", "l", p.status));
      var st = el("div", "stats");
      st.appendChild(stat("Record", p.wins + "–" + p.losses));
      st.appendChild(stat("7 days", units(p.units_7d), tone(p.units_7d)));
      st.appendChild(stat("ROI", p.roi == null ? "–" : (p.roi * 100).toFixed(1) + "%", tone(p.roi)));
      st.appendChild(stat("Pending", p.pending || 0));
      c.appendChild(st);
      c.appendChild(bars((p.days || []).map(function (d) { return [d.date, d.units]; })));
      c.appendChild(el("div", "note", "Units per day, last " + (p.days || []).length + " days with results"));
      box.appendChild(c);
    });
  }

  // ---------- jobs tab ----------
  var NEEDS = [["ready_to_submit", "Ready to submit"], ["uncertain_submissions", "Unsure if sent"], ["apply_manually", "Apply by hand"],
               ["questions", "Questions to answer"], ["failed_sources", "Job sources failing"]];
  function renderJobs(j) {
    var box = $("jobs");
    box.textContent = "";
    if (!j) {
      var e = el("div", "card");
      e.appendChild(el("h2", null, "No JobBoard status yet"));
      e.appendChild(el("p", "muted", "JobBoard runs on your Mac. Once the Mac publishes its status (git pull, then publish-status once), counts show here after the next refresh."));
      box.appendChild(e);
      tabBadge("jobs", 0);
      return;
    }
    var a = j.automation || {}, n = j.needs_you || {}, apps = j.applications || {}, h = j.health || {};
    var need = NEEDS.reduce(function (s, k) { return s + (+n[k[0]] || 0); }, 0);
    tabBadge("jobs", need);
    var hero = el("div", "card hero");
    hero.appendChild(el("div", "label", a.kill_switch ? "Kill switch is ON" : a.submission_enabled ? "Auto-apply is on" : "Auto-apply is off"));
    var st = el("div", "stats");
    st.appendChild(stat("Sent today", apps.submitted_today || 0));
    st.appendChild(stat("Sent total", apps.submitted_total || 0));
    st.appendChild(stat("Tries today", (a.attempts_today || 0) + "/" + (a.daily_cap || 0)));
    st.appendChild(stat("New jobs 24h", j.new_24h || 0));
    hero.appendChild(st);
    hero.appendChild(el("div", "note", "Status from your Mac, " + ago(j.generated_at)));
    box.appendChild(hero);

    box.appendChild(el("h2", "sec", "Needs you"));
    var list = el("div", "list");
    var any = false;
    NEEDS.forEach(function (k) {
      var v = +n[k[0]] || 0;
      if (!v) return;
      any = true;
      var it = el("div", "item warn");
      var t = el("div", "t");
      t.appendChild(el("span", "dot warn"));
      t.appendChild(el("span", "name", k[1]));
      t.appendChild(el("b", null, v));
      it.appendChild(t);
      list.appendChild(it);
    });
    if (!any) list.appendChild(el("div", "empty", "Nothing needs you."));
    box.appendChild(list);

    box.appendChild(el("h2", "sec", "Health"));
    var hl = el("div", "list");
    var hi = el("div", "item" + (h.overall === "fail" ? " error" : h.overall === "warn" ? " warn" : ""));
    var ht = el("div", "t");
    ht.appendChild(el("span", "dot " + (h.overall === "fail" ? "error" : h.overall === "warn" ? "warn" : "running")));
    ht.appendChild(el("span", "name", h.overall === "fail" ? "Health check failing" : h.overall === "warn" ? "Health warnings" : "Healthy"));
    hi.appendChild(ht);
    var bits = (h.failing || []).concat(h.warning || []);
    if (bits.length) hi.appendChild(el("div", "l", bits.join(", ")));
    var lr = j.last_run || {};
    hi.appendChild(el("div", "l", "Last run " + (lr.status || "unknown") + (lr.finished_at ? ", " + ago(lr.finished_at) : "") +
      " · sources " + (j.sources_ok || 0) + " ok, " + (j.sources_failed || 0) + " failed" +
      (j.backup_age_hours != null ? " · backup " + Math.round(j.backup_age_hours) + " h old" : "")));
    hl.appendChild(hi);
    box.appendChild(hl);
    box.appendChild(el("p", "note pad", "Counts only. Job titles, employers and your profile never leave the Mac. Open JobBoard on the Mac to act on these."));
  }

  // ---------- NBA tab ----------
  var MARKET = { prop: "Player props", ml: "Moneyline", spread: "Spread", total: "Totals" };
  function pct(v) { return v == null ? "–" : Math.round(v * 100) + "%"; }
  function tipTime(iso) {
    var t = Date.parse(iso);
    return t ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  }
  function mark(result) {
    return el("span", "res " + (result || "pending"), result === "win" ? "✓" : result === "loss" ? "✗" : result === "push" || result === "void" ? "–" : "•");
  }
  function renderNbaTab(n) {
    var top = $("nba-top"), more = $("nba-more");
    top.textContent = ""; more.textContent = "";
    if (!n) { top.appendChild(el("div", "empty", "NBA details weren't in this update. Tonight's picks still show below.")); return; }
    var r = n.record || {};
    var hero = el("div", "card hero");
    hero.appendChild(el("div", "label", "Posted picks" + (r.since ? " since " + shortDay(r.since) : "")));
    hero.appendChild(el("div", "big " + tone(r.units), units(r.units)));
    var st = el("div", "stats");
    st.appendChild(stat("Record", r.wins + "–" + r.losses));
    st.appendChild(stat("Hit rate", pct(r.hit_rate)));
    st.appendChild(stat("ROI", r.roi == null ? "–" : (r.roi > 0 ? "+" : "") + (r.roi * 100).toFixed(1) + "%", tone(r.roi)));
    st.appendChild(stat("7 days", units(n.units_7d), tone(n.units_7d)));
    hero.appendChild(st);
    hero.appendChild(spark(n.line));
    hero.appendChild(el("div", "note", "1 unit per pick" + (r.drawdown != null ? " · worst dip " + units(r.drawdown) : "") + (r.pending ? " · " + r.pending + " pending" : "")));
    top.appendChild(hero);

    // Tonight's games
    if ((n.games || []).length) {
      top.appendChild(el("h2", "sec", "Games" + (n.slate ? " · " + shortDay(n.slate) : "")));
      var g = el("div", "card games");
      n.games.forEach(function (x) {
        var row = el("div", "game");
        row.appendChild(el("span", "teams", x.away + " @ " + x.home));
        var live = x.status && x.status !== "scheduled";
        row.appendChild(el("span", "when" + (live ? " live" : ""), live && x.home_score != null ? x.away_score + "–" + x.home_score + (x.status === "final" ? " F" : "") : tipTime(x.start_utc)));
        g.appendChild(row);
      });
      top.appendChild(g);
    }
    $("nba-picks-title").textContent = "Picks" + (n.slate ? " · " + shortDay(n.slate) : "");

    // Last results
    if ((n.last_results || []).length) {
      var won = n.last_results.filter(function (x) { return x.result === "win"; }).length;
      var lost = n.last_results.filter(function (x) { return x.result === "loss"; }).length;
      var u = n.last_results.reduce(function (a, x) { return a + (x.units || 0); }, 0);
      more.appendChild(el("h2", "sec", "Results · " + shortDay(n.last_slate) + " · " + won + "–" + lost + " · " + units(u)));
      var c = el("div", "card results");
      n.last_results.forEach(function (x) {
        var row = el("div", "lean");
        row.appendChild(mark(x.result));
        var mid = el("div", "tl");
        mid.appendChild(el("b", null, x.label));
        var bits = [x.matchup];
        if (x.stat_value != null) bits.push("got " + x.stat_value);
        if (x.price_american != null) bits.push((x.price_american > 0 ? "+" : "") + x.price_american);
        mid.appendChild(el("span", null, bits.filter(Boolean).join(" · ")));
        row.appendChild(mid);
        row.appendChild(el("span", "amt " + tone(x.units), x.units == null ? "" : units(x.units)));
        c.appendChild(row);
      });
      more.appendChild(c);
    }

    // Parlays and lotto
    var tk = n.tickets || {};
    if (tk.parlay || tk.lotto) {
      more.appendChild(el("h2", "sec", "Parlays and lotto"));
      var grid = el("div", "pair");
      [["parlay", "Parlays"], ["lotto", "Lotto"]].forEach(function (k) {
        var t = tk[k[0]];
        if (!t) return;
        var c = el("div", "card mini");
        c.appendChild(el("div", "label", k[1]));
        c.appendChild(el("div", "mid " + tone(t.units), units(t.units)));
        c.appendChild(el("div", "note", t.wins + "–" + t.losses + " settled"));
        var dots = el("div", "dots");
        (t.recent || []).slice().reverse().forEach(function (x) { dots.appendChild(mark(x.result)); });
        c.appendChild(dots);
        grid.appendChild(c);
      });
      more.appendChild(grid);
      more.appendChild(el("p", "note pad", "Parlays and lotto are research tickets, tracked separately from the record above."));
    }

    // By market
    if ((n.by_market || []).length) {
      more.appendChild(el("h2", "sec", "By market"));
      var bm = el("div", "card");
      n.by_market.forEach(function (m) {
        var row = el("div", "mrow");
        row.appendChild(el("span", "name", MARKET[m.market] || m.market));
        row.appendChild(el("span", "muted", m.wins + "–" + m.losses + " · " + pct(m.hit_rate)));
        row.appendChild(el("span", "amt " + tone(m.units), units(m.units)));
        bm.appendChild(row);
      });
      more.appendChild(bm);
    }

    // Daily
    if ((n.days || []).length) {
      more.appendChild(el("h2", "sec", "By day"));
      var bd = el("div", "card");
      bd.appendChild(bars(n.days.map(function (d) { return [d[0], d[1]]; })));
      bd.appendChild(el("div", "note", "Units per slate, last " + n.days.length + " slates"));
      more.appendChild(bd);
    }

    var pl = n.pipeline || {};
    var line = "Model last ran " + (pl.at ? ago(pl.at) : "unknown") + (pl.ok === false ? " (failed)" : "") +
      (pl.dry_run ? " · Discord posting off (dry run)" : "") + (pl.paused ? " · paused" : "") + (pl.odds_stale ? " · odds are stale" : "");
    more.appendChild(el("p", "note pad", line + ((pl.warnings || []).length ? " · " + pl.warnings.join("; ") : "")));
  }

  // ---------- Stocks tab (Fundamental Researcher public snapshot) ----------
  var STOCKS_STORE = "deskStocks";
  var stocksAt = 0;
  async function loadStocks(force) {
    var base = safeUrl(CFG.stocksUrl);
    if (!base) { $("stocks").textContent = ""; $("stocks").appendChild(el("div", "empty", "Stocks aren't set up in this version.")); return; }
    var cached = load(STOCKS_STORE);
    if (cached && !$("stocks").childNodes.length) { try { renderStocks(JSON.parse(cached), true); } catch (e) {} }
    if (!force && Date.now() - stocksAt < 5 * 60000) return;
    try {
      var r = await fetch(base + "data/home.json?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      var d = await r.json();
      stocksAt = Date.now();
      var slim = { updated: d.updated, regime: d.regime, vix: d.vix, breadth: d.breadth, mood: d.mood, quiet: d.quiet,
        next: (d.digest || {}).next_events || [], movers: (d.movers || []).slice(0, 6), disclaimer: d.disclaimer,
        status_note: d.status_note, impact: ((d.digest_impact || {}).items || []).slice(0, 3),
        mine: (d.mine || []).map(function (m) {
          return { ticker: m.ticker, name: m.name, price: m.price, change_1d: m.change_1d, ret_20d: m.ret_20d, label: m.short,
            cls: m.classification, summary: m.summary, todo: m.todo, blocker: m.blocker, state: m.state, spark: m.spark,
            play: (m.play || {}).summary, watch: (m.watch || []).slice(0, 3), earnings_soon: m.earnings_soon };
        }) };
      store(STOCKS_STORE, JSON.stringify(slim));
      renderStocks(slim, false);
    } catch (e) {
      if (!cached) { $("stocks").textContent = ""; $("stocks").appendChild(el("div", "empty", "Couldn't reach the stock snapshot. Tap refresh in a minute.")); }
    }
  }
  function signedPct(v) { return v == null || isNaN(v) ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + "%"; }
  function labelClass(l) {
    l = String(l || "").toUpperCase();
    if (/STRONG|BUY|CANDIDATE/.test(l)) return "good";
    if (/RISK|BEAR|AVOID|SELL/.test(l)) return "bad";
    if (/DEVELOPING|WATCH/.test(l)) return "warn";
    return "";
  }
  function renderStocks(d, fromCache) {
    var box = $("stocks");
    box.textContent = "";
    var hero = el("div", "card hero");
    var head = el("div", "t");
    head.appendChild(el("span", "label", "Tech market"));
    head.appendChild(el("span", "chip " + (/off/i.test(d.regime) ? "bad" : /on/i.test(d.regime) ? "good" : ""), d.regime || "–"));
    hero.appendChild(head);
    var st = el("div", "stats");
    st.appendChild(stat("VIX", d.vix == null ? "–" : d.vix.toFixed(1), d.vix >= 25 ? "down" : ""));
    st.appendChild(stat("Above 50-day", d.breadth == null ? "–" : Math.round(d.breadth) + "%"));
    hero.appendChild(st);
    if (d.quiet) hero.appendChild(el("div", "l", d.quiet));
    box.appendChild(hero);

    if ((d.next || []).length) {
      box.appendChild(el("h2", "sec", "Coming up"));
      var nx = el("div", "card");
      d.next.forEach(function (x) {
        var m = /^(\d{4}-\d{2}-\d{2}):\s*(.*)$/.exec(x);
        var row = el("div", "mrow");
        row.appendChild(el("span", "when", m ? shortDay(m[1]) : ""));
        row.appendChild(el("span", "name", m ? m[2] : x));
        nx.appendChild(row);
      });
      box.appendChild(nx);
    }

    if ((d.movers || []).length) {
      box.appendChild(el("h2", "sec", "Why they moved"));
      var mv = el("div", "list");
      d.movers.forEach(function (m) {
        var it = el("a", "item");
        it.href = CFG.stocksUrl + "?open=" + encodeURIComponent(m.ticker); it.target = "_blank"; it.rel = "noopener";
        var t = el("div", "t");
        t.appendChild(el("span", "name", m.ticker));
        t.appendChild(el("span", "amt " + tone(m.move), signedPct(m.move)));
        it.appendChild(t);
        it.appendChild(el("div", "l", m.headline || m.why || ""));
        mv.appendChild(it);
      });
      box.appendChild(mv);
    }

    if ((d.mine || []).length) {
      box.appendChild(el("h2", "sec", "My stocks"));
      var list = el("div", "list");
      d.mine.forEach(function (m) {
        var it = el("details", "item stock");
        var sum = el("summary");
        var t = el("div", "t");
        t.appendChild(el("span", "name", m.ticker));
        t.appendChild(el("span", "chip " + labelClass(m.label), m.label || ""));
        t.appendChild(el("span", "amt " + tone(m.change_1d), signedPct(m.change_1d)));
        sum.appendChild(t);
        var sub = el("div", "l");
        sub.textContent = (m.price != null ? "$" + m.price.toFixed(2) + " · " : "") + (m.summary || "");
        sum.appendChild(sub);
        it.appendChild(sum);
        var body = el("div", "body");
        if (m.spark && m.spark.length > 1) {
          body.appendChild(spark(m.spark.map(function (v, i) { return [i, v - m.spark[0]]; })));
          body.appendChild(el("div", "note", "Last " + m.spark.length + " days · 20 days " + signedPct(m.ret_20d) + (m.state ? " · " + m.state : "")));
        }
        if (m.todo) body.appendChild(el("p", "do", m.todo));
        if (m.play) body.appendChild(el("p", null, m.play));
        (m.watch || []).forEach(function (w) { body.appendChild(el("p", "muted small", "Watch: " + w)); });
        var a = el("a", "btn", "Full brief");
        a.href = CFG.stocksUrl + "?open=" + encodeURIComponent(m.ticker); a.target = "_blank"; a.rel = "noopener";
        body.appendChild(a);
        it.appendChild(body);
        list.appendChild(it);
      });
      box.appendChild(list);
    }
    box.appendChild(el("p", "note pad", "Fundamental Researcher snapshot, updated " + (d.updated ? ago(d.updated) : "unknown") +
      (fromCache ? " (saved copy)" : "") + ". " + (d.disclaimer || "Research, not advice.")));
  }

  // ---------- tabs ----------
  var TABS = ["status", "trading", "nba", "stocks", "jobs"];
  function tabFromHash() {
    var m = /^#(status|trading|nba|stocks|jobs)\b/.exec(location.hash || "");
    return m ? m[1] : (load(TAB_STORE) || "status");
  }
  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = "status";
    TABS.forEach(function (t) { $("view-" + t).hidden = t !== name; });
    document.querySelectorAll("#tabbar a[data-tab]").forEach(function (a) { a.classList.toggle("on", a.dataset.tab === name); });
    $("foot").hidden = name !== "status" || $("main").hidden;
    $("install").hidden = standalone || name !== "status" || $("main").hidden;
    $("title").textContent = { status: "Bot Desk", trading: "Trading", nba: "NBA Picks", stocks: "Stocks", jobs: "Jobs" }[name];
    if (name === "stocks") loadStocks(false);
    store(TAB_STORE, name);
    window.scrollTo(0, 0);
  }
  function tabBadge(name, n) {
    var b = $("badge-" + name);
    if (!b) return;
    b.hidden = !n;
    b.textContent = n > 99 ? "99+" : String(n || "");
  }

  function renderNba(rows) {
    var sec = $("nba-sec"), box = $("nba");
    box.textContent = "";
    sec.hidden = !rows.length;
    var parlayBox = {};
    var allBox = $("nba-all");
    allBox.textContent = "";
    rows.forEach(function (r) {
      if (r.kind === "all") {
        var card = el("div", "card allslip");
        card.appendChild(el("div", "label", "Add all tonight's straights"));
        card.appendChild(el("div", "l", "One tap puts every straight pick on the slip. Bet them as singles."));
        var bl = el("div", "links");
        [["dk_url", "dk_label", "DraftKings"], ["fd_url", "fd_label", "FanDuel"]].forEach(function (k) {
          var u = safeUrl(r[k[0]]);
          if (!u) return;
          var a = el("a", "btn primary big");
          a.href = u; a.target = "_blank"; a.rel = "noopener";
          a.appendChild(el("b", null, k[2]));
          a.appendChild(el("span", null, (r[k[1]] || "").replace(/^(DK|FD) /, "")));
          bl.appendChild(a);
        });
        card.appendChild(bl);
        allBox.appendChild(card);
        return;
      }
      var cls = "item pick" + (r.kind === "leg" ? " leg" : "") + (r.started ? " started" : "");
      var it = el("div", cls);
      if (r.kind === "parlay" || r.kind === "all") it.appendChild(el("div", "tag", r.kind === "all" ? "All straights" : "Parlay"));
      it.appendChild(el("div", "t", r.pick || ""));
      var meta = [];
      if (r.matchup) meta.push(r.matchup);
      if (r.win_pct != null) meta.push(r.win_pct + "% model");
      if (r.price != null) meta.push((r.price > 0 ? "+" : "") + r.price);
      if (r.started) meta.push("started");
      if (meta.length) it.appendChild(el("div", "meta", meta.join(" · ")));
      var links = el("div", "links");
      [["dk_url", "dk_label", "DK"], ["fd_url", "fd_label", "FD"]].forEach(function (k) {
        var u = safeUrl(r[k[0]]);
        if (!u) return;
        var a = el("a", "btn" + (k[2] === "FD" && r.fd_missing ? " soft" : ""), r[k[1]] || k[2]);
        a.href = u; a.target = "_blank"; a.rel = "noopener";
        links.appendChild(a);
      });
      if (links.childNodes.length) it.appendChild(links);
      if (r.kind === "leg" && parlayBox[r.parent]) { parlayBox[r.parent].appendChild(it); return; }
      if (r.kind === "parlay") {
        // Legs fold under their parlay so the list stays short.
        var det = el("details", "legs");
        det.appendChild(el("summary", null, "Show legs"));
        it.appendChild(det);
        parlayBox[r.key] = det;
      }
      box.appendChild(it);
    });
  }

  function showBanner(text) {
    var b = $("banner");
    b.hidden = !text;
    b.textContent = text || "";
  }
  function setBadge(n) {
    try {
      if (!("setAppBadge" in navigator)) return;
      if (n > 0) navigator.setAppBadge(n); else navigator.clearAppBadge();
    } catch (e) {}
  }

  // ---------- flow ----------
  async function refresh() {
    var key = getKey();
    if (!key) { showSetup(); return; }
    $("refresh").classList.add("spin");
    try {
      var box = await fetchBox();
      if (tabFromHash() === "stocks") loadStocks(true);
      var d = await decrypt(box, key);
      store(LAST_STORE, JSON.stringify(d));
      showMain();
      render(d);
    } catch (e) {
      var last = load(LAST_STORE);
      var badKey = e && e.name === "OperationError";
      if (badKey && !last) { showSetup("That key doesn't match. Paste the latest key from your Claude thread."); return; }
      if (last) { showMain(); render(JSON.parse(last)); }
      else { $("updated").textContent = "No data yet"; }
      showBanner(badKey ? "This key doesn't open the latest data. Paste the newest key from your Claude thread (Settings > Forget key)."
        : navigator.onLine === false ? "Offline. Showing the last statuses this phone saw."
        : last ? "Couldn't reach the data just now. Showing the last statuses this phone saw." : "Couldn't reach the data yet. Tap refresh in a minute.");
    } finally {
      $("refresh").classList.remove("spin");
    }
  }

  function showSetup(msg) {
    $("setup").hidden = false;
    $("main").hidden = true;
    $("foot").hidden = true;
    $("tabbar").hidden = true;
    $("updated").textContent = "Not set up yet";
    var err = $("key-err");
    err.hidden = !msg;
    err.textContent = msg || "";
  }
  function showMain() {
    $("setup").hidden = true;
    $("main").hidden = false;
    $("tabbar").hidden = false;
    $("foot").hidden = tabFromHash() !== "status";
    var key = load(KEY_STORE);
    $("install").hidden = standalone || tabFromHash() !== "status";
    $("key-copy").hidden = !key;
  }

  async function saveKey() {
    var k = $("key-input").value.trim().replace(/^.*[#&]k=/, "");
    if (!validKey(k)) {
      $("key-err").hidden = false;
      $("key-err").textContent = "That doesn't look like a Bot Desk key. It's a 43-character code.";
      return;
    }
    store(KEY_STORE, k);
    store(LAST_STORE, null);
    $("key-input").value = "";
    await refresh();
  }

  // ---------- alerts (web push) ----------
  function alertsState() {
    var s = $("alerts-state"), btn = $("alerts-btn");
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      btn.hidden = true;
      s.textContent = standalone
        ? "This phone can't do web alerts. iOS 16.4 or newer is needed."
        : "Alerts work once Bot Desk is on your Home Screen (iOS 16.4 or newer).";
      return;
    }
    btn.hidden = false;
    if (Notification.permission === "granted") {
      btn.textContent = "Alerts are on · show alert code";
      s.textContent = "Alerts are allowed on this phone.";
    } else if (Notification.permission === "denied") {
      btn.textContent = "Alerts are blocked";
      s.textContent = "Alerts were blocked. Turn them on in iPhone Settings > Notifications > Bot Desk.";
    } else {
      btn.textContent = "Turn on alerts";
      s.textContent = "Alerts are off.";
    }
  }

  async function turnOnAlerts() {
    try {
      if (!swReg) swReg = await navigator.serviceWorker.ready;
      var perm = await Notification.requestPermission();
      alertsState();
      if (perm !== "granted") return;
      if (!CFG.vapidPublicKey) { $("alerts-state").textContent = "Alerts aren't set up in this version yet."; return; }
      var sub = await swReg.pushManager.getSubscription();
      if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(CFG.vapidPublicKey) });
      var j = sub.toJSON();
      $("sub-code").value = "botdesk-alerts:" + btoa(JSON.stringify({ endpoint: j.endpoint, keys: j.keys }));
      $("sub-box").hidden = false;
      document.querySelector(".more").open = true;
    } catch (e) {
      $("alerts-state").textContent = "Couldn't turn on alerts: " + (e && e.message ? e.message : e);
    }
  }

  async function copyText(text, btn) {
    var label = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
    catch (e) { btn.textContent = "Copy failed. Select and copy instead."; }
    setTimeout(function () { btn.textContent = label; }, 1800);
  }

  // ---------- wire up ----------
  function init() {
    $("version").textContent = "Version " + (CFG.version || "dev");
    document.querySelectorAll("#tabbar a[data-tab]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); history.replaceState(null, "", "#" + a.dataset.tab); showTab(a.dataset.tab); });
    });
    showTab(tabFromHash());
    $("refresh").addEventListener("click", refresh);
    $("key-save").addEventListener("click", saveKey);
    $("key-input").addEventListener("keydown", function (e) { if (e.key === "Enter") saveKey(); });
    $("key-paste").addEventListener("click", async function () {
      try { $("key-input").value = (await navigator.clipboard.readText()).trim(); } catch (e) { $("key-input").focus(); }
    });
    $("key-copy").addEventListener("click", function () { copyText(load(KEY_STORE) || "", $("key-copy")); });
    $("key-forget").addEventListener("click", function () {
      if (!confirm("Forget the key on this phone? You'll need to paste it again.")) return;
      store(KEY_STORE, null); store(LAST_STORE, null); setBadge(0); showSetup();
    });
    $("alerts-btn").addEventListener("click", turnOnAlerts);
    $("sub-copy").addEventListener("click", function () { copyText($("sub-code").value, $("sub-copy")); });
    $("test-note").addEventListener("click", async function () {
      try {
        if (Notification.permission !== "granted") await Notification.requestPermission();
        if (!swReg) swReg = await navigator.serviceWorker.ready;
        await swReg.showNotification("Bot Desk", { body: "Test alert. Real ones look like this.", icon: "icons/icon-192.png", tag: "test" });
      } catch (e) { $("alerts-state").textContent = "Couldn't show a notification: " + (e && e.message ? e.message : e); }
    });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(); });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").then(function (r) { swReg = r; }).catch(function () {});
    }
    alertsState();

    // Draw the last known data right away, then fetch fresh.
    var last = load(LAST_STORE);
    if (getKey() && last) { try { showMain(); render(JSON.parse(last)); } catch (e) {} }
    refresh();
  }
  init();
})();

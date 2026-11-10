/* Bot Desk: installable status app. Reads an encrypted status file, decrypts it on the phone, draws it. */
(function () {
  "use strict";
  var CFG = window.DESK_CONFIG || {};
  var KEY_STORE = "deskKey";
  var LAST_STORE = "deskLast";
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
    setBadge(counts.broken + counts.needs);
  }

  function renderNba(rows) {
    var sec = $("nba-sec"), box = $("nba");
    box.textContent = "";
    sec.hidden = !rows.length;
    var parlayBox = {};
    rows.forEach(function (r) {
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
        var a = el("a", "btn", r[k[1]] || k[2]);
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
    $("updated").textContent = "Not set up yet";
    var err = $("key-err");
    err.hidden = !msg;
    err.textContent = msg || "";
  }
  function showMain() {
    $("setup").hidden = true;
    $("main").hidden = false;
    $("foot").hidden = false;
    var key = load(KEY_STORE);
    $("install").hidden = standalone;
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

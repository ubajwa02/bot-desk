/* Bot Desk service worker: offline app shell + push alerts. Data is never cached here (the page keeps its own last copy). */
var CACHE = "bot-desk-v1.1.0";
var SHELL = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "config.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// App shell: network first (so updates land), cache when offline. Other origins (data) pass straight through.
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match("index.html"); });
    })
  );
});

// Push: payload is {title, body, count, tag}. Only titles of new problems are sent, never trading numbers.
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  var title = d.title || "Bot Desk";
  var opts = {
    body: d.body || "Something needs a look. Open Bot Desk.",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || "bot-desk",
    data: { url: "./" }
  };
  var jobs = [self.registration.showNotification(title, opts)];
  if (typeof d.count === "number" && self.navigator && "setAppBadge" in self.navigator) {
    jobs.push(d.count > 0 ? self.navigator.setAppBadge(d.count) : self.navigator.clearAppBadge());
  }
  e.waitUntil(Promise.all(jobs).catch(function () {}));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) { if ("focus" in list[i]) return list[i].focus(); }
      return self.clients.openWindow("./");
    })
  );
});

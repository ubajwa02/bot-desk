// Public settings only. The data key never goes in this repo: each phone keeps its own copy.
window.DESK_CONFIG = {
  version: "1.1.0",
  // Encrypted status file, refreshed by the Team Desk collector. First address that answers wins.
  dataUrls: [
    "https://raw.githubusercontent.com/ubajwa02/bot-desk/data/desk.enc.json",
    "https://api.github.com/repos/ubajwa02/bot-desk/contents/desk.enc.json?ref=data"
  ],
  // Stocks tab reads data/home.json from the Fundamental Researcher snapshot you already publish (public, read-only,
  // research not advice). Same site as this app, so no extra permissions.
  stocksUrl: "https://ubajwa02.github.io/fr-dashboard/",
  // Public half of the alert-sending key (safe to publish; the private half is kept outside the repo).
  vapidPublicKey: "BBQyt__yWeY8vrWmvHXGK4sXAUJSFrlr19UV2T9FMVyZi7ci-ETux46vUDhFAMqoPyRybrbkup4KOEoIqSRiIPo"
};

"use strict";
/* AyX Group connection page — live service status.
   NEVER claims "connected" unless the health endpoint actually responds. */
(function () {
  var HEALTH_URL = "https://api.imayx.in/v1/health";
  var TIMEOUT_MS = 8000;

  var dot = document.getElementById("status-dot");
  var title = document.getElementById("status-title");
  var detail = document.getElementById("status-detail");
  var checked = document.getElementById("status-checked");

  function setState(state, titleText, detailText) {
    dot.className = "dot " + state;
    title.textContent = titleText;
    detail.textContent = detailText;
    checked.textContent = "Last checked: " + new Date().toLocaleString();
  }

  async function check() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    try {
      var res = await fetch(HEALTH_URL, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var when = "";
      if (data && data.time) {
        var d = new Date(data.time);
        if (!isNaN(d.getTime())) when = " · Server time: " + d.toLocaleString();
      }
      var svc = data && data.service ? String(data.service) : "AyX Group API";
      setState("online", "Service online", svc + " responded successfully." + when);
    } catch (err) {
      clearTimeout(timer);
      setState(
        "offline",
        "Service unreachable",
        "The AyX Group API did not respond. Announcements sync from the app itself, so this page cannot confirm a connection right now."
      );
    }
  }

  setState("checking", "Checking service status…", "Contacting the AyX Group API…");
  check();
})();

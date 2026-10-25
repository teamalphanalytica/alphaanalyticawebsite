/*
 * Alpha Analytica call tracking for client websites.
 * Add once, before </body>:
 *   <script src="https://alpha-analytica.netlify.app/call-tracking.js" defer></script>
 *
 * When a visitor who came from an ad taps a phone number link (tel:), this tells the portal which ad
 * click they came from. If that number is an Alpha Analytica tracking number and the call follows within
 * two minutes, the call is credited to the ad click, so Google and Facebook learn which clicks become calls.
 * It sends nothing for visitors who didn't come from an ad, and never sends names, emails or phone numbers
 * of visitors: only the number that was tapped and the ad click ids.
 */
(function () {
  try {
    var me = document.currentScript && document.currentScript.src;
    var endpoint = (me ? new URL(me).origin : "https://alpha-analytica.netlify.app") + "/api/call-click";
    var store = window.sessionStorage;
    var q = new URLSearchParams(location.search);
    ["gclid", "gbraid", "wbraid"].forEach(function (k) {
      var v = q.get(k);
      if (v) store.setItem("aa_" + k, v.slice(0, 300));
    });
    if (q.get("fbclid")) store.setItem("aa_fbc", "fb.1." + Date.now() + "." + q.get("fbclid").slice(0, 300));
    var cookie = function (n) {
      var m = document.cookie.match("(?:^|; )" + n + "=([^;]*)");
      return m ? decodeURIComponent(m[1]) : "";
    };

    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="tel:"]') : null;
      if (!a) return;
      var body = {
        number: decodeURIComponent(a.getAttribute("href").slice(4)),
        gclid: store.getItem("aa_gclid") || "",
        gbraid: store.getItem("aa_gbraid") || "",
        wbraid: store.getItem("aa_wbraid") || "",
        fbc: cookie("_fbc") || store.getItem("aa_fbc") || "",
        fbp: cookie("_fbp") || "",
        page_url: location.origin + location.pathname
      };
      if (!body.gclid && !body.gbraid && !body.wbraid && !body.fbc) return; // not from an ad
      var data = JSON.stringify(body);
      if (navigator.sendBeacon) navigator.sendBeacon(endpoint, new Blob([data], { type: "text/plain" }));
      else fetch(endpoint, { method: "POST", body: data, mode: "no-cors", keepalive: true });
    }, true);
  } catch (err) { /* never break the page */ }
})();

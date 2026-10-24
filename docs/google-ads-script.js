/**
 * Alpha Analytica: push Google Ads results into the client portal.
 *
 * Where: Google Ads manager (MCC) account > Tools > Bulk actions > Scripts > New script.
 * Paste this in, fill in the two settings below, Authorise, Preview, then Schedule it hourly or daily.
 * It sends the last 3 days for every client account under your manager account.
 * Each client must have their Google Ads customer id saved in the portal (Admin > client > Ad accounts).
 */
var PORTAL_URL = "https://YOUR-SITE.netlify.app/api/ingest-ads";
var PUSH_KEY = "PASTE-THE-SAME-VALUE-AS-ADS_PUSH_KEY";
var DAYS_BACK = 3;

function main() {
  var accounts = AdsManagerApp.accounts().get();
  var rows = [];
  while (accounts.hasNext()) {
    var account = accounts.next();
    AdsManagerApp.select(account);
    var customerId = account.getCustomerId();
    var from = isoDay(daysAgo(DAYS_BACK));
    var to = isoDay(daysAgo(0));
    var report = AdsApp.report(
      "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions " +
      "FROM customer WHERE segments.date BETWEEN '" + from + "' AND '" + to + "'"
    );
    var it = report.rows();
    while (it.hasNext()) {
      var r = it.next();
      rows.push({
        day: r["segments.date"],
        platform: "google",
        google_customer_id: customerId,
        spend: Number(r["metrics.cost_micros"]) / 1000000,
        impressions: Number(r["metrics.impressions"]),
        clicks: Number(r["metrics.clicks"]),
        conversions: Number(r["metrics.conversions"])
      });
    }
  }
  for (var i = 0; i < rows.length; i += 400) {
    var res = UrlFetchApp.fetch(PORTAL_URL, {
      method: "post",
      contentType: "application/json",
      headers: { "x-push-key": PUSH_KEY },
      payload: JSON.stringify({ rows: rows.slice(i, i + 400) }),
      muteHttpExceptions: true
    });
    Logger.log(res.getResponseCode() + " " + res.getContentText());
  }
}

function daysAgo(n) { return new Date(new Date().getTime() - n * 86400000); }
function isoDay(d) { return Utilities.formatDate(d, AdsApp.currentAccount().getTimeZone(), "yyyy-MM-dd"); }

/**
 * Alpha Analytica: one daily script in your Google Ads MANAGER account that
 *  1. sends each client's results (spend, clicks, conversions) to the portal, and
 *  2. uploads each genuine enquiry from the portal back to the client's Google Ads account
 *     as an offline conversion, so Google's bidding learns which clicks become real customers.
 *
 * Setup: Tools > Bulk actions > Scripts > + > New script. Paste this in, set PUSH_KEY, Authorise,
 * Preview, Save, then set it to run Daily.
 * In each client account, create a conversion action once:
 *   Goals > Conversions > New conversion action > Import > "Other data sources or CRMs" > "Track conversions from clicks",
 *   named exactly "Portal enquiry" (or whatever name is saved for that client in the portal).
 * Optional second action for enquiries that became paying customers: create another the same way, named
 *   "Portal customer", and save that name for the client in the portal (leave it blank there to switch it off).
 *
 * What gets sent: only enquiries we're confident are genuine (the client marked them as qualified or a
 * customer, or the dispute window passed with no dispute). Each is valued at the client's price per enquiry.
 */
var PORTAL = "https://alpha-analytica.netlify.app";
var PUSH_KEY = "PASTE_ADS_PUSH_KEY_HERE";
var DAYS_BACK = 3;

function main() {
  sendResults();
  uploadConversions();
}

function sendResults() {
  var accounts = AdsManagerApp.accounts().get();
  var rows = [];
  while (accounts.hasNext()) {
    var account = accounts.next();
    AdsManagerApp.select(account);
    var tz = AdsApp.currentAccount().getTimeZone();
    var from = Utilities.formatDate(new Date(Date.now() - DAYS_BACK * 86400000), tz, "yyyy-MM-dd");
    var to = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    var it = AdsApp.report(
      "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions " +
      "FROM customer WHERE segments.date BETWEEN '" + from + "' AND '" + to + "'").rows();
    while (it.hasNext()) {
      var r = it.next();
      rows.push({ day: r["segments.date"], platform: "google", google_customer_id: account.getCustomerId(),
        spend: Number(r["metrics.cost_micros"]) / 1000000, impressions: Number(r["metrics.impressions"]),
        clicks: Number(r["metrics.clicks"]), conversions: Number(r["metrics.conversions"]) });
    }
  }
  Logger.log("Results rows: " + rows.length);
  for (var i = 0; i < rows.length; i += 400) {
    var res = UrlFetchApp.fetch(PORTAL + "/api/ingest-ads", { method: "post", contentType: "application/json",
      headers: { "x-push-key": PUSH_KEY }, payload: JSON.stringify({ rows: rows.slice(i, i + 400) }), muteHttpExceptions: true });
    Logger.log("Results: " + res.getResponseCode() + " " + res.getContentText());
  }
}

function uploadConversions() {
  var res = UrlFetchApp.fetch(PORTAL + "/api/conversions/google", { headers: { "x-push-key": PUSH_KEY }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { Logger.log("Conversions: portal said " + res.getResponseCode()); return; }
  var list = JSON.parse(res.getContentText()).conversions;
  Logger.log("Conversions waiting: " + list.length);
  if (!list.length) return;

  // group by client account id (digits only)
  var byAccount = {};
  list.forEach(function (c) { (byAccount[c.customer_id] = byAccount[c.customer_id] || []).push(c); });

  var done = [], doneCustomers = [];
  var accounts = AdsManagerApp.accounts().get();
  while (accounts.hasNext()) {
    var account = accounts.next();
    var items = byAccount[account.getCustomerId().replace(/-/g, "")];
    if (!items) continue;
    AdsManagerApp.select(account);
    var upload = AdsApp.bulkUploads().newCsvUpload(
      ["Google Click ID", "Conversion name", "Conversion time", "Conversion value", "Conversion currency"],
      { moneyInMicros: false });
    upload.forOfflineConversions();
    items.forEach(function (c) {
      upload.append({ "Google Click ID": c.gclid, "Conversion name": c.conversion_name,
        "Conversion time": c.conversion_time, "Conversion value": c.value || 1, "Conversion currency": "GBP" });
    });
    if (AdsApp.getExecutionInfo().isPreview()) {
      Logger.log("Preview: would upload " + items.length + " conversions for " + account.getCustomerId());
      continue;
    }
    upload.apply();
    items.forEach(function (c) { (c.kind === "customer" ? doneCustomers : done).push(c.id); });
    Logger.log("Uploaded " + items.length + " conversions for " + account.getCustomerId());
  }
  if (done.length || doneCustomers.length) {
    var ack = UrlFetchApp.fetch(PORTAL + "/api/conversions/google/ack", { method: "post", contentType: "application/json",
      headers: { "x-push-key": PUSH_KEY }, payload: JSON.stringify({ ids: done, customer_ids: doneCustomers }), muteHttpExceptions: true });
    Logger.log("Confirmed with portal: " + ack.getContentText());
  }
}

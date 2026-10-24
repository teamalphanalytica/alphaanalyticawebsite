# Plugging in the portal feeds

Everything is built. These are the steps that need your accounts. Do them on the Deploy Preview first, then merge.

## 1. Netlify
1. Open a pull request from `portal-v1` to `main`. Netlify builds a Deploy Preview with its own database.
2. Project configuration > Identity: enable it, set registration to **Invite only**.
3. Environment variables (Project configuration > Environment variables):
   - `ADMIN_EMAILS`: your email, and Harry's, comma separated.
   - `ADS_PUSH_KEY`: a long random string (for example 40+ random characters).
   - `TWILIO_AUTH_TOKEN`: from the Twilio console (step 3).
   - `PUBLIC_BASE_URL`: your live address with no trailing slash, e.g. `https://alphaanalytica.co.uk`. Twilio signs the exact address it called, so this must match what you put in Twilio.
4. Invite each client from Identity > Invite users, then link their email in Admin > client > Logins.

## 2. Website enquiries
For each client site: Forms > Form notifications > Add notification > Outgoing webhook, pasting the address from Admin > client > "Sending enquiries here". Submit one real test form and check it appears under Enquiries.

## 3. Call tracking (Twilio)
1. Create a Twilio account and upgrade it. UK numbers need a regulatory bundle (business details and address proof); this takes a day or more to approve.
2. Buy a UK number per client per source (for example one for Google ads, one for Facebook).
3. On each number: Voice configuration > "A call comes in" > Webhook, HTTP POST, `https://YOUR-SITE/api/twilio/voice`.
4. Add the number in Admin > client > Tracking phone numbers with the client's real phone number.
5. Ring it from another phone. The call should forward and appear in the Calls tab. Calls that were answered and last at least the client's minimum length also appear as enquiries.

Notes: the client's phone will show the tracking number as the caller, not the customer's number. The customer's number is in the portal call log. Calls are not recorded. If you ever add recording, you must tell callers at the start. Caller numbers are personal data, so mention call tracking in your privacy notice.

### Customers set up their own number
Customers can open the Calls tab, type their phone number and press **Set up**. The portal then buys a UK number from Twilio, points it at your voice webhook and forwards calls to them. Each number costs money every month, so it is off until you switch it on:
1. Twilio console > Phone Numbers > Regulatory Compliance: create and get approved a UK bundle and address. Note the Bundle SID (starts `BU`) and Address SID (starts `AD`).
2. Netlify environment variables: `TWILIO_ACCOUNT_SID`, `TWILIO_BUNDLE_SID`, `TWILIO_ADDRESS_SID`, and finally `SELF_SERVE_NUMBERS=on`.
3. Optional: `SELF_SERVE_MAX_NUMBERS` (default 20) caps how many numbers customers can create in total, and `TWILIO_NUMBER_TYPE` (`Local` by default, or `Mobile` / `National`).
Safeguards: one number per customer, double clicks can't buy two, and only ordinary UK mobiles and landlines are accepted as forwarding numbers (no premium-rate, 08, 070 or 118 numbers). Changing the forwarding number later is free. If Twilio refuses, the customer sees a friendly message and you check the Netlify function log.

## 4. Google Ads results
1. In Admin > client > Ad accounts, save the client's Google Ads customer id.
2. In your Google Ads manager account: Tools > Bulk actions > Scripts > New script. Paste `docs/google-ads-script.js`, set `PORTAL_URL` and `PUSH_KEY`, authorise, Preview, then schedule it.
3. The result log shows `saved`, `unknown_account` and `rejected` counts.

## Automatic Facebook results, report drafts and alerts
These run on their own once the settings below exist.
- **Facebook sync** runs every morning (05:30 UTC) and pulls the last 7 days for every client with a Meta ad account id. It needs `META_ACCESS_TOKEN`, a system-user token from your Meta Business Manager (Business settings > Users > System users > add one > assign each client's ad account with "View performance" > Generate token with `ads_read`). Clients share their ad account with your Business as a partner; the portal's Ads tab walks them through it. Facebook may require app review for `ads_read` on partner accounts; the sync reports a clear error per client until access is granted.
- **Weekly report drafts** are created every Monday at 06:00 UTC for the previous Monday to Sunday, unpublished. Admin shows them under each client; add notes and press Publish.
- **Needs attention** in Admin lists clients with no enquiries for 3 days, failed syncs, silent Google feeds, failed calls, drafts waiting and missing details.
- Admin has "Run now" buttons for the Facebook sync and the report drafts, for testing.
- Optional settings that show the client the right ids in their Connect guide: `GOOGLE_MCC_ID` (your Google Ads manager account id) and `META_BUSINESS_ID` (your Meta Business id).
- Enquiry sources: ad links ending `?utm_source=google&utm_campaign=boilers` are remembered and attached to the enquiry, so reports can show where each one came from.

## Emails (report ready, Monday attention list)
The portal emails a client's logins when a report is published, and emails the admins every Monday after the drafts are made. It uses Resend (resend.com, free for up to 3,000 emails a month).
1. Create a Resend account and an API key.
2. Add your domain in Resend and add the DNS records it shows (so emails come from you and don't land in spam).
3. Netlify environment variables: `RESEND_API_KEY`, and `EMAIL_FROM` such as `Alpha Analytica <reports@yourdomain.co.uk>`.
4. Test with Admin > "Email me this list now".
Until the key is set, nothing is emailed and everything else carries on working.

## Billing summary
Set each client's price per enquiry in Admin > client > Ad accounts and calls. Admin > Billing shows genuine enquiries per client per month (everything not marked spam), how many are not yet reviewed, and the total; "Download CSV" gives a file for your invoicing tool.

## 5. Facebook and Instagram results
Facebook has no equivalent of the Google script. Options:
- Use a connector tool (for example Windsor.ai or Supermetrics) that can send a daily webhook or sheet export, mapped to the same JSON as above with `platform: "meta"` and `meta_ad_account_id`.
- Or apply for Meta Business Verification and app review for `ads_read`, then add a small scheduled function. This takes weeks.
- Until then, enter results by hand in Admin > client > Ad results for one day.

## Push format (`POST /api/ingest-ads`, header `x-push-key`)
```json
{ "rows": [ { "day": "2026-10-23", "platform": "google", "google_customer_id": "123-456-7890",
  "spend": 12.34, "impressions": 900, "clicks": 40, "conversions": 5 } ] }
```
Re-sending a day replaces that day's numbers.

## Not tested against the real services
This was built and tested without access to live Twilio, Google Ads, Meta, or a Netlify database. Test each on the Deploy Preview before relying on it.

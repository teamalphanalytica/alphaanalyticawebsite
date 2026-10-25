# Finding Manchester clients (Prospects)

Admin, then **Prospects**. Every weekday at about 7am a scheduled job:

1. Picks the day's trade (roofers, plumbers, electricians and so on, rotating through 15).
2. Searches Greater Manchester for businesses of that trade on OpenStreetMap (free, no key).
3. Opens each business's homepage once, like a visitor, and checks the things that cost a local business enquiries: phone-friendliness, tap-to-call, a clear next step, reviews, security, tracking, out-of-date look.
4. Keeps the few it can help most (default 5, never one already in the list, never a site with little to fix).
5. Writes a proposal and a call script for each. Open the **proposal PDF**, ring them, send it afterwards.

The PDF is three pages: where they stand today (a scorecard of what we saw), a drawn mock-up of what their new website could look like on a computer and a phone (using their own services and credentials only where we found them on their site), and the benefits with why each matters, plus a worked example of what it could be worth. The example uses clearly labelled illustrative figures and says so; we use the prospect's own numbers on the call.

Nothing is ever sent to a business automatically. You choose who to call.

## Their advertising

Google and Facebook don't allow automatic collection of other people's ads, so this is part automatic, part one click:

- **Automatic:** the website check notes whether the homepage carries a Google Ads tag, a Facebook pixel or analytics, and finds the business's Facebook page if it links to one.
- **One click:** each card has **Check Google ads** (Google Ads Transparency Centre) and **Check Facebook ads** (Meta Ad Library), already searched for that business. Look, set the dropdown to *Running ads* or *No ads found*, then press **Rewrite proposal**. The proposal uses only what you recorded; "Not checked" is never turned into a claim.

## Settings (Netlify, Site configuration, Environment variables), all optional

| Name | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | With it, Claude writes each proposal and script from what we saw on the site. Without it, a good plain template is used. Already used for call summaries, so one key covers both. |
| `PROPOSAL_CONTACT` | One line printed under "Next step" on the PDF, e.g. `Jordan, 07xxx xxxxxx, jordan@yourdomain.co.uk`. |
| `PITCH_PRICE_TEXT` | How you want pricing worded on the PDF. Left blank, the proposal says the price per enquiry is agreed on a short call. Claude is never allowed to invent a price. |
| `PROSPECTS_PER_DAY` | 1 to 10. Default 5. |
| `PROPOSAL_MODEL` | Defaults to `claude-sonnet-5-5`. |

## Adding businesses yourself

OpenStreetMap is patchy for small firms. If you spot one (a van, a Facebook page, a competitor to a client), use **Add a business you found yourself**. It checks the site straight away and writes the proposal in a few seconds.

## Before you ring or email (UK rules, not legal advice)

- **Phone:** check the number against the TPS (people) and CTPS (companies) at tpsonline.org.uk before a cold call. Say who you are and why you're calling.
- **Email:** limited companies can be emailed at a business address if you say who you are and include an easy way to opt out. **Sole traders and ordinary partnerships can't be emailed cold.** That's why each prospect has a "Limited company / Sole trader" setting; check Companies House when unsure.
- If anyone says no, set them to **Not for us** and never contact them again.
- The ICO's "Direct marketing guidance" is the reference.

The tool only reads public homepages, one page per business, and keeps business details (name, phone, website), not personal ones.

## The same thing as a bot prompt (no portal needed)

If you'd rather run this from a scheduled Claude task or any chat, paste this each morning (or schedule it daily):

```
You are my daily prospecting assistant for Alpha Analytica, a Manchester agency that builds websites and runs Google and Facebook ads for local trades and service businesses, charging per genuine enquiry (spam and wrong numbers are not charged).

Today's trade: <ROOFERS - change daily, or say "pick one that suits a per-enquiry model">.

1. Use web search to find 8 independent businesses of that trade in Greater Manchester. Skip national chains and anyone I list below as already contacted: <PASTE NAMES>.
2. For each, open their homepage and note ONLY what you can actually see: works on a phone? tap-to-call number? clear "get a quote" prompt? reviews shown? looks out of date (footer year)? any sign of analytics or ad tracking? no website at all?
3. Pick the 5 where I could help most.
4. For each of the 5, give me: business, phone, website, whether it looks like a limited company (check Companies House), the three most useful things you noticed, a 15-second call opener naming the business, three questions to ask, three likely objections with answers, and a three-sentence message to send with a one-page PDF.
5. Then make a one-page A4 PDF proposal for each (header "Alpha Analytica", "What we noticed", "What we would do", "How you pay", "Next step"), in plain British English.

Rules: use only facts you saw; never invent statistics, rankings, competitors, reviews or results; never state a price (say it is agreed on a short call); no hype or exclamation marks. Flag any business that is a sole trader so I only phone them, never email.
```

The in-portal version is better because it remembers who it has already found, keeps your call notes and follow-up dates, and builds the PDFs for you.

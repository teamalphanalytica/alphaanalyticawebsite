// Sends email through Resend (resend.com). Without RESEND_API_KEY it does nothing and says so,
// so the rest of the system keeps working before email is set up.

export async function sendEmail({ to, subject, text, html }) {
  const key = Netlify.env.get("RESEND_API_KEY");
  const from = Netlify.env.get("EMAIL_FROM") || "Alpha Analytica <onboarding@resend.dev>";
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!key) return { skipped: true, reason: "RESEND_API_KEY not set" };
  if (!list.length) return { skipped: true, reason: "no recipients" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: list, subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("email failed", res.status, body.slice(0, 300));
      return { sent: false, error: `Email service said ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error("email failed", e);
    return { sent: false, error: "Email service unreachable" };
  }
}

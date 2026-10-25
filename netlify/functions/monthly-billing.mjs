import { getDatabase } from "@netlify/database";
import { runBilling } from "../lib/billing.mjs";
import { sendEmail } from "../lib/email.mjs";
import { parseAdminEmails } from "../lib/util.mjs";

// Every day at 07:00 UTC. From the 8th it invoices last month for anyone not yet invoiced.
// Clients that have to wait (open disputes, no price) are simply retried the next day.
export const config = { schedule: "0 7 * * *" };

export default async () => {
  const db = getDatabase();
  const r = await runBilling(db);
  console.log("billing run", JSON.stringify(r));
  const news = r.created + r.drafts + r.failed.length;
  if (news > 0) {
    const lines = [
      r.drafts ? `${r.drafts} draft invoice(s) are waiting for your approval in the portal (Admin > Billing).` : null,
      r.created ? `${r.created} invoice(s) were created and are being collected.` : null,
      ...r.failed.map((f) => `Problem with ${f.client}: ${f.error}`),
    ].filter(Boolean);
    await sendEmail({ to: parseAdminEmails(Netlify.env.get("ADMIN_EMAILS")), subject: `Billing run for ${r.period}`, text: lines.join("\n") });
  }
};

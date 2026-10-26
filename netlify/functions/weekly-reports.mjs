import { getDatabase } from "@netlify/database";
import { draftWeeklyReports, sendAttentionEmail } from "../lib/jobs.mjs";
import { runWeeklyReviews } from "../lib/ad-review.mjs";

// Every Monday at 06:00 UTC: draft last week's report for each client
export const config = { schedule: "0 6 * * 1" };

export default async () => {
  const db = getDatabase();
  const result = await draftWeeklyReports(db);
  console.log("weekly report drafts", JSON.stringify(result));
  // then the AI review of every client's advertising, which adds its plain-English note to each draft
  console.log("weekly ad reviews", JSON.stringify(await runWeeklyReviews(db)));
  // then email the admins what needs attention (including the new drafts to publish)
  console.log("attention email", JSON.stringify(await sendAttentionEmail(db)));
};

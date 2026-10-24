import { getDatabase } from "@netlify/database";
import { draftWeeklyReports } from "../lib/jobs.mjs";

// Every Monday at 06:00 UTC: draft last week's report for each client
export const config = { schedule: "0 6 * * 1" };

export default async () => {
  const result = await draftWeeklyReports(getDatabase());
  console.log("weekly report drafts", JSON.stringify(result));
};

import { getDatabase } from "@netlify/database";
import { syncMeta } from "../lib/jobs.mjs";

// Every morning at 05:30 UTC
export const config = { schedule: "30 5 * * *" };

export default async () => {
  const result = await syncMeta(getDatabase());
  console.log("meta sync", JSON.stringify(result));
};

import { getDatabase } from "@netlify/database";
import { sendMetaConversions } from "../lib/jobs.mjs";

// Every hour: send genuine enquiries (past the spam-review window) to Facebook as Lead events
export const config = { schedule: "@hourly" };

export default async () => {
  const result = await sendMetaConversions(getDatabase());
  console.log("meta conversions", JSON.stringify(result));
};

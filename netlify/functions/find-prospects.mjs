import { getDatabase } from "@netlify/database";
import { findProspects } from "../lib/prospects.mjs";

// Weekday mornings (about 7am UK): find a few Manchester businesses, look at their websites, write the proposals
export const config = { schedule: "0 6 * * 1-5" };

export default async () => {
  console.log("prospects", JSON.stringify(await findProspects(getDatabase())));
};

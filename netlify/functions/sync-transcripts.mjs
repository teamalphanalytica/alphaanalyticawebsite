import { getDatabase } from "@netlify/database";
import { syncTranscripts } from "../lib/calls.mjs";

// Every 10 minutes: collect finished call transcripts, summarise them, and delete old recordings
export const config = { schedule: "*/10 * * * *" };

export default async () => {
  console.log("transcripts", JSON.stringify(await syncTranscripts(getDatabase())));
};

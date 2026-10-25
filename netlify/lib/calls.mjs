// Call recording, transcripts and AI summaries.
//
//  1. A forwarded call is recorded (both sides, separate channels) after a spoken notice to the caller.
//  2. When Twilio says the recording is ready, we ask Twilio Voice Intelligence to transcribe it.
//  3. A job every 10 minutes collects finished transcripts and asks Claude for a short summary and a verdict.
//  4. After the retention period (default 90 days) the audio and transcript are deleted for good.
//
// All of it is off until CALL_RECORDING=on. Transcripts and summaries are only ever shown to admins.

import { formatTranscript, summaryRequest, parseSummary, toInt } from "./util.mjs";

export const recordingOn = () => Netlify.env.get("CALL_RECORDING") === "on";
export const retentionDays = () => toInt(Netlify.env.get("CALL_RETENTION_DAYS"), { min: 1, max: 3650 }) ?? 90;
export const recordingNotice = () => Netlify.env.get("CALL_NOTICE") || "This call may be recorded for quality and training purposes.";

function authHeader() {
  const sid = Netlify.env.get("TWILIO_ACCOUNT_SID");
  const token = Netlify.env.get("TWILIO_AUTH_TOKEN");
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

async function intelApi(path, { method = "GET", form } = {}) {
  const res = await fetch(`https://intelligence.twilio.com/v2/${path}`, {
    method,
    headers: { authorization: authHeader(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (method === "DELETE" && res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message || "error"}`);
  return data;
}

/** The Voice Intelligence service that does the transcribing. Made once, then remembered. */
export async function ensureIntelligenceService(db) {
  const fromEnv = Netlify.env.get("TWILIO_INTELLIGENCE_SERVICE_SID");
  if (fromEnv) return fromEnv;
  const [saved] = await db.sql`SELECT value FROM settings WHERE key = 'intelligence_service_sid'`;
  if (saved) return saved.value;
  const uniqueName = "alpha-analytica-calls";
  let sid = null;
  try {
    const svc = await intelApi("Services", { method: "POST", form: {
      UniqueName: uniqueName, FriendlyName: "Alpha Analytica calls",
      LanguageCode: Netlify.env.get("TRANSCRIPT_LANGUAGE") || "en-GB", AutoTranscribe: "false",
    } });
    sid = svc.sid;
  } catch (e) {
    // already exists from an earlier attempt? find it
    const list = await intelApi("Services");
    sid = (list.services || []).find((s) => s.unique_name === uniqueName)?.sid;
    if (!sid) throw e;
  }
  await db.sql`INSERT INTO settings (key, value) VALUES ('intelligence_service_sid', ${sid})
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
  return sid;
}

/** Ask Twilio to transcribe a recording. Safe to call twice: a recording can only have one transcript. */
export async function startTranscript(db, callId) {
  const [call] = await db.sql`SELECT id, call_sid, recording_sid, transcript_sid FROM calls WHERE id = ${callId}`;
  if (!call?.recording_sid) return { skipped: "no recording" };
  if (call.transcript_sid) return { skipped: "already started" };
  try {
    const service = await ensureIntelligenceService(db);
    const t = await intelApi("Transcripts", { method: "POST", form: {
      ServiceSid: service, CustomerKey: call.call_sid,
      Channel: JSON.stringify({
        media_properties: { source_sid: call.recording_sid },
        participants: [{ channel_participant: 1, role: "Caller" }, { channel_participant: 2, role: "Business" }],
      }),
    } });
    await db.sql`UPDATE calls SET transcript_sid = ${t.sid}, transcript_status = ${t.status || "queued"}, transcript_error = NULL WHERE id = ${callId}`;
    return { started: true };
  } catch (e) {
    console.error("transcript start failed", e);
    await db.sql`UPDATE calls SET transcript_status = 'failed', transcript_error = ${String(e.message).slice(0, 300)} WHERE id = ${callId}`;
    return { error: e.message };
  }
}

/** Twilio's "recording is ready" message. The parent call sid is always the one we logged. */
export async function handleRecordingCallback(db, params) {
  if (params.RecordingStatus !== "completed" || !params.RecordingSid || !params.CallSid) return { ignored: true };
  const seconds = toInt(params.RecordingDuration) ?? null;
  const rows = await db.sql`
    UPDATE calls SET recording_sid = ${params.RecordingSid}, recording_seconds = ${seconds}
    WHERE call_sid = ${params.CallSid} AND recording_sid IS NULL RETURNING id`;
  if (!rows[0]) return { ignored: true };
  // recordings under two seconds can't be transcribed
  if (seconds !== null && seconds < 3) return { stored: true, transcript: "too short" };
  const r = await startTranscript(db, rows[0].id);
  return { stored: true, transcript: r };
}

async function fetchSentences(transcriptSid) {
  const all = [];
  let path = `Transcripts/${transcriptSid}/Sentences?PageSize=1000`;
  for (let page = 0; page < 5 && path; page++) {
    const data = await intelApi(path);
    all.push(...(data.sentences || []));
    const next = data.meta?.next_page_url;
    path = next ? next.replace("https://intelligence.twilio.com/v2/", "") : null;
  }
  return all;
}

/** Ask Claude for a short summary and verdict. Quietly does nothing without ANTHROPIC_API_KEY. */
export async function summariseCall(db, callId) {
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!key) return { skipped: "no ANTHROPIC_API_KEY" };
  const [call] = await db.sql`
    SELECT k.id, k.transcript, c.name AS client FROM calls k JOIN clients c ON c.id = k.client_id WHERE k.id = ${callId}`;
  if (!call?.transcript?.length) return { skipped: "no transcript" };
  const req = summaryRequest(call.transcript, { businessName: call.client });
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Netlify.env.get("SUMMARY_MODEL") || "claude-haiku-5-5", max_tokens: 500, system: req.system, messages: [{ role: "user", content: req.user }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${data?.error?.message || "error"}`);
    const summary = parseSummary(data?.content?.find((b) => b.type === "text")?.text);
    if (!summary) throw new Error("Couldn't read the summary");
    await db.sql`UPDATE calls SET summary = ${JSON.stringify(summary)}::jsonb, summarised_at = NOW() WHERE id = ${callId}`;
    return { summarised: true };
  } catch (e) {
    console.error("summary failed", e);
    return { error: e.message };
  }
}

/** Every 10 minutes: collect finished transcripts, summarise new ones, and delete anything past retention. */
export async function syncTranscripts(db) {
  const result = { checked: 0, completed: 0, failed: 0, summarised: 0, deleted: 0, off: !recordingOn() };
  if (result.off) return result;

  const pending = await db.sql`
    SELECT id, transcript_sid FROM calls
    WHERE transcript_sid IS NOT NULL AND transcript_status IS DISTINCT FROM 'completed' AND transcript_status IS DISTINCT FROM 'failed'
      AND started_at > NOW() - INTERVAL '3 days' ORDER BY started_at LIMIT 50`;
  for (const c of pending) {
    result.checked++;
    try {
      const t = await intelApi(`Transcripts/${c.transcript_sid}`);
      if (t.status === "completed") {
        const transcript = formatTranscript(await fetchSentences(c.transcript_sid));
        await db.sql`UPDATE calls SET transcript = ${JSON.stringify(transcript)}::jsonb, transcript_status = 'completed' WHERE id = ${c.id}`;
        result.completed++;
      } else if (["failed", "error", "canceled"].includes(t.status)) {
        await db.sql`UPDATE calls SET transcript_status = 'failed', transcript_error = ${"Twilio status: " + t.status} WHERE id = ${c.id}`;
        result.failed++;
      } else {
        await db.sql`UPDATE calls SET transcript_status = ${t.status || "in-progress"} WHERE id = ${c.id}`;
      }
    } catch (e) {
      console.error("transcript check failed", c.id, e);
    }
  }

  const toSummarise = await db.sql`
    SELECT id FROM calls WHERE transcript_status = 'completed' AND summary IS NULL AND transcript IS NOT NULL
      AND jsonb_array_length(transcript) > 0 AND started_at > NOW() - INTERVAL '3 days' ORDER BY started_at LIMIT 20`;
  for (const c of toSummarise) if ((await summariseCall(db, c.id)).summarised) result.summarised++;

  result.deleted = await deleteOldMedia(db);
  return result;
}

/** Audio and transcripts don't live forever. Summaries stay; the words and the voice go. */
export async function deleteOldMedia(db) {
  const days = retentionDays();
  const old = await db.sql`
    SELECT id, recording_sid, transcript_sid FROM calls
    WHERE media_deleted_at IS NULL AND (recording_sid IS NOT NULL OR transcript_sid IS NOT NULL)
      AND started_at < NOW() - make_interval(days => ${days}::int) ORDER BY started_at LIMIT 50`;
  let n = 0;
  for (const c of old) {
    try {
      const sid = Netlify.env.get("TWILIO_ACCOUNT_SID");
      if (c.recording_sid) {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${c.recording_sid}.json`, { method: "DELETE", headers: { authorization: authHeader() }, signal: AbortSignal.timeout(15_000) });
        if (!r.ok && r.status !== 404) throw new Error(`recording delete ${r.status}`);
      }
      if (c.transcript_sid) await intelApi(`Transcripts/${c.transcript_sid}`, { method: "DELETE" }).catch((e) => { if (!/404/.test(e.message)) throw e; });
      await db.sql`UPDATE calls SET media_deleted_at = NOW(), transcript = NULL, recording_sid = NULL, transcript_sid = NULL WHERE id = ${c.id}`;
      n++;
    } catch (e) {
      console.error("media delete failed", c.id, e); // tried again at the next run
    }
  }
  return n;
}

/** Stream a recording to an admin's browser. The audio never has a public link. */
export async function fetchRecording(recordingSid, rangeHeader) {
  const sid = Netlify.env.get("TWILIO_ACCOUNT_SID");
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${recordingSid}.mp3`, {
    headers: { authorization: authHeader(), ...(rangeHeader ? { range: rangeHeader } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

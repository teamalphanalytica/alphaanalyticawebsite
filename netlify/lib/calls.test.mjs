// Runs the real call-transcript code against an in-memory fake database and fake Twilio / Anthropic.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const env = {};
globalThis.Netlify = { env: { get: (k) => env[k] } };
const { handleRecordingCallback, syncTranscripts, summariseCall, deleteOldMedia, ensureIntelligenceService } = await import("./calls.mjs");

let calls, settings, fetches, twilio;

const fakeDb = () => ({
  sql: async (strings, ...v) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT value FROM settings")) return settings.intelligence_service_sid ? [{ value: settings.intelligence_service_sid }] : [];
    if (q.startsWith("INSERT INTO settings")) { settings.intelligence_service_sid = v[0]; return []; }
    if (q.startsWith("UPDATE calls SET recording_sid")) {
      const c = calls.find((x) => x.call_sid === v[2] && !x.recording_sid);
      if (!c) return [];
      c.recording_sid = v[0]; c.recording_seconds = v[1]; return [{ id: c.id }];
    }
    if (q.startsWith("SELECT id, call_sid, recording_sid, transcript_sid FROM calls")) return calls.filter((c) => c.id === v[0]);
    if (q.startsWith("UPDATE calls SET transcript_sid")) { Object.assign(calls.find((c) => c.id === v[2]), { transcript_sid: v[0], transcript_status: v[1] }); return []; }
    if (q.startsWith("UPDATE calls SET transcript_status = 'failed', transcript_error")) { Object.assign(calls.find((c) => c.id === v[1]), { transcript_status: "failed", transcript_error: v[0] }); return []; }
    if (q.startsWith("SELECT id, transcript_sid FROM calls")) return calls.filter((c) => c.transcript_sid && !["completed", "failed"].includes(c.transcript_status));
    if (q.startsWith("UPDATE calls SET transcript = ")) { Object.assign(calls.find((c) => c.id === v[1]), { transcript: JSON.parse(v[0]), transcript_status: "completed" }); return []; }
    if (q.startsWith("UPDATE calls SET transcript_status = 'failed', transcript_error = ?")) return [];
    if (q.startsWith("UPDATE calls SET transcript_status = ?")) { calls.find((c) => c.id === v[1]).transcript_status = v[0]; return []; }
    if (q.startsWith("SELECT id FROM calls WHERE transcript_status = 'completed'")) return calls.filter((c) => c.transcript_status === "completed" && !c.summary);
    if (q.startsWith("SELECT k.id, k.transcript, c.name AS client")) return calls.filter((c) => c.id === v[0]).map((c) => ({ ...c, client: "Joe" }));
    if (q.startsWith("UPDATE calls SET summary")) { calls.find((c) => c.id === v[1]).summary = JSON.parse(v[0]); return []; }
    if (q.startsWith("SELECT id, recording_sid, transcript_sid FROM calls")) return calls.filter((c) => !c.media_deleted_at && c.old);
    if (q.startsWith("UPDATE calls SET media_deleted_at")) { Object.assign(calls.find((c) => c.id === v[0]), { media_deleted_at: new Date(), transcript: null, recording_sid: null, transcript_sid: null }); return []; }
    throw new Error("Unexpected query in test: " + q.slice(0, 90));
  },
});

beforeEach(() => {
  calls = [{ id: 1, call_sid: "CA1", recording_sid: null, transcript_sid: null }];
  settings = {}; fetches = [];
  twilio = { transcriptStatus: "completed", createFails: false };
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, { CALL_RECORDING: "on", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    fetches.push(`${method} ${url}`);
    const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.endsWith("intelligence.twilio.com/v2/Services") && method === "POST") return ok({ sid: "GA1" }, 201);
    if (url.endsWith("/v2/Transcripts") && method === "POST") return twilio.createFails ? ok({ message: "bad" }, 400) : ok({ sid: "GT1", status: "queued" }, 201);
    if (/Transcripts\/GT1\/Sentences/.test(url)) return ok({ sentences: [
      { media_channel: 1, transcript: "My boiler has broken.", start_time: 2 }, { media_channel: 2, transcript: "I can come tomorrow.", start_time: 5 }], meta: {} });
    if (/Transcripts\/GT1$/.test(url) && method === "GET") return ok({ sid: "GT1", status: twilio.transcriptStatus });
    if (/Transcripts\/GT1$/.test(url) && method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/Recordings/") && method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("api.anthropic.com")) return ok({ content: [{ type: "text", text: '{"summary":"Boiler repair booked","outcome":"booked","genuine":true,"sentiment":"positive","follow_up":""}' }] });
    throw new Error("Unexpected fetch " + method + " " + url);
  };
});

const cb = (extra = {}) => ({ RecordingStatus: "completed", RecordingSid: "RE1", CallSid: "CA1", RecordingDuration: "42", ...extra });

test("a finished recording is stored and a transcript is started with the right service", async () => {
  const r = await handleRecordingCallback(fakeDb(), cb());
  assert.equal(r.stored, true);
  assert.equal(calls[0].recording_sid, "RE1");
  assert.equal(calls[0].transcript_sid, "GT1");
  assert.equal(settings.intelligence_service_sid, "GA1");
  assert.ok(fetches.some((f) => f.endsWith("/v2/Services")));
});

test("the same recording message twice does nothing the second time", async () => {
  await handleRecordingCallback(fakeDb(), cb());
  const n = fetches.length;
  assert.equal((await handleRecordingCallback(fakeDb(), cb())).ignored, true);
  assert.equal(fetches.length, n);
});

test("unfinished recordings, unknown calls and very short recordings are handled quietly", async () => {
  assert.equal((await handleRecordingCallback(fakeDb(), cb({ RecordingStatus: "in-progress" }))).ignored, true);
  assert.equal((await handleRecordingCallback(fakeDb(), cb({ CallSid: "CA999" }))).ignored, true);
  const short = await handleRecordingCallback(fakeDb(), cb({ RecordingDuration: "1" }));
  assert.equal(short.transcript, "too short");
  assert.equal(calls[0].transcript_sid, null);
});

test("a Twilio failure marks the transcript failed instead of throwing", async () => {
  twilio.createFails = true;
  await handleRecordingCallback(fakeDb(), cb());
  assert.equal(calls[0].transcript_status, "failed");
  assert.match(calls[0].transcript_error, /Twilio 400/);
});

test("the sync collects a finished transcript, labels the speakers, then summarises it", async () => {
  env.ANTHROPIC_API_KEY = "sk-ant-test";
  await handleRecordingCallback(fakeDb(), cb());
  const r = await syncTranscripts(fakeDb());
  assert.equal(r.completed, 1);
  assert.equal(r.summarised, 1);
  assert.deepEqual(calls[0].transcript.map((t) => t.speaker), ["caller", "business"]);
  assert.equal(calls[0].summary.outcome, "booked");
});

test("without an Anthropic key the transcript still arrives and the summary is skipped", async () => {
  await handleRecordingCallback(fakeDb(), cb());
  const r = await syncTranscripts(fakeDb());
  assert.equal(r.completed, 1);
  assert.equal(r.summarised, 0);
  assert.equal(calls[0].summary, undefined);
  assert.deepEqual(await summariseCall(fakeDb(), 1), { skipped: "no ANTHROPIC_API_KEY" });
});

test("a transcript still in progress is left to the next run", async () => {
  twilio.transcriptStatus = "in-progress";
  await handleRecordingCallback(fakeDb(), cb());
  const r = await syncTranscripts(fakeDb());
  assert.equal(r.completed, 0);
  assert.equal(calls[0].transcript_status, "in-progress");
});

test("everything is off unless CALL_RECORDING=on", async () => {
  delete env.CALL_RECORDING;
  assert.equal((await syncTranscripts(fakeDb())).off, true);
  assert.equal(fetches.length, 0);
});

test("old recordings and transcripts are deleted from Twilio and wiped here", async () => {
  Object.assign(calls[0], { recording_sid: "RE1", transcript_sid: "GT1", old: true, transcript: [{ speaker: "caller", text: "hi" }] });
  assert.equal(await deleteOldMedia(fakeDb()), 1);
  assert.ok(fetches.some((f) => f.startsWith("DELETE") && f.includes("/Recordings/RE1")));
  assert.ok(fetches.some((f) => f.startsWith("DELETE") && f.includes("Transcripts/GT1")));
  assert.equal(calls[0].transcript, null);
  assert.ok(calls[0].media_deleted_at);
});

test("a configured service id is used without creating one", async () => {
  env.TWILIO_INTELLIGENCE_SERVICE_SID = "GA9";
  assert.equal(await ensureIntelligenceService(fakeDb()), "GA9");
  assert.equal(fetches.length, 0);
});

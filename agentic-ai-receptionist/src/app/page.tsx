const sections = [
  {
    title: "System Architecture Diagram (Text)",
    body: (
      <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <pre className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">
{`[Caller]
   │ SIP/PSTN
   ▼
[Telephony Provider]
   │ Webhook (Call Start + Audio Stream)
   ▼
[n8n Self-Hosted Cluster]
   ├─ Voice IO Loop (STT ⇄ TTS via AI Voice Agent API)
   │    ├─ STT Node → Transcript Buffer (Redis)
   │    ├─ LLM Orchestrator (OpenAI/Groq) with System Prompt
   │    └─ TTS Node → Provider Media Streaming
   ├─ Conversation Memory (Postgres via n8n Credentials)
   ├─ Data Extraction (JSON → Validation)
   ├─ Branch: Spreadsheet Append (Google Sheets API)
   ├─ Branch: Calendar Event (Google Calendar API)
   ├─ Branch: Slack/Email Alerts (Ops Notifications)
   └─ Branch: Error Queue (S3/MinIO + Incident Alert)
   ▼
[Business Ops Stack]
   ├─ CRM (Optional webhook)
   └─ Analytics Dashboard (Metabase/Grafana)`}
        </pre>
        <p className="mt-4 text-sm text-zinc-600">
          Deploy n8n in HA mode behind Traefik with automatic restart policies. Use managed SIP trunking (e.g., Twilio, Telnyx) to forward webhook events into the n8n REST API. Media streams are proxied through the AI voice service for low-latency turn taking.
        </p>
      </div>
    ),
  },
  {
    title: "Call Flow Step-by-Step",
    body: (
      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm text-sm leading-6 text-zinc-800">
        <p>1. Inbound SIP/PSTN call triggers the telephony provider&apos;s webhook to the n8n public endpoint (`/webhook/voice/inbound`).</p>
        <p>2. n8n immediately responds with a `200` to seize the call and directs the provider to proxy audio to the configured AI voice agent session.</p>
        <p>3. The AI receptionist greets the caller with the authored system prompt, maintains natural pacing, and gathers required fields one at a time.</p>
        <p>4. Each speech turn is transcribed (STT) and streamed into n8n via the voice agent&apos;s event callbacks; transcripts append to session memory.</p>
        <p>5. n8n&apos;s LLM Orchestrator function parses intent, tracks slot-filling state (name, phone, email, reason, preferred date, preferred time), and injects follow-up questions through the TTS response.</p>
        <p>6. Once all fields are captured, n8n checks Google Calendar availability via the Calendar node using dynamic calendar ID matching the business.</p>
        <p>7. If the requested slot is open, n8n creates the event and confirms; otherwise it computes the next two available slots and routes the offer back through the voice agent.</p>
        <p>8. After confirmation, n8n appends the final dataset to Google Sheets, pushes structured JSON into the data warehouse (optional), and sends a Slack/Email summary.</p>
        <p>9. n8n closes the voice session, logs the call outcome, and the telephony provider terminates the call leg.</p>
        <p>10. On failure (drop, API error), n8n logs the partial payload, sends an alert to Ops, and schedules an outbound follow-up task.</p>
      </div>
    ),
  },
  {
    title: "AI Receptionist System Prompt (Final Version)",
    body: (
      <div className="rounded-xl border border-zinc-200 bg-slate-50 p-6 shadow-sm">
        <pre className="whitespace-pre-wrap text-sm leading-6 text-zinc-900">
{`You are "Harbor Reception", the confident, warm, and concise voice receptionist for Harbor Automation.

Core persona:
- Sound human. Use natural cadence, short sentences, occasional micro-pauses ("..."), and soft affirmations.
- Stay upbeat and professional. You guide callers toward booking an appointment unless they explicitly refuse.
- You know the business: Harbor Automation offers smart building automation audits and rapid deployment services.

Operating rules:
1. Answer immediately: "Hi, this is Harbor Reception. Thanks for calling Harbor Automation. How can I help today?"
2. Collect in this order, one item at a time. Confirm by paraphrasing.
   a) Full name
   b) Best callback number
   c) Email address
   d) Reason for the call
   e) Preferred appointment date
   f) Preferred appointment time window
3. If caller is unsure, gently offer suggestions: "We can do early mornings or late afternoons. What works best?"
4. Handle objections briefly:
   - Pricing curiosity → "Our specialist can tailor options once we learn more. Let’s secure a slot so they can walk you through it."
   - Availability concern → offer next two openings returned by scheduling API.
   - Urgency → escalate to today’s on-call slot if flagged urgent.
5. Never fabricate. If you lack data, say, "Let me double-check that for you" and trigger the fallback action.
6. Keep replies under 25 words. Ask one question per turn. Use names naturally.
7. Once all fields are gathered, confirm the appointment: "Great, I have you booked for [DATE] at [TIME]. You’ll receive a confirmation by email."
8. Close warmly: "Thanks for choosing Harbor Automation. Talk soon!"

Structured output:
- After each caller turn, output JSON with keys: name, phone, email, reason, preferred_date, preferred_time, notes, status. Use null for unknown.
- Mark status as one of: collecting, ready_to_book, booked, follow_up_required.
- If call drops or user refuses, set status accordingly and include last known details in notes.

Fail-safe:
- If something feels off or the caller becomes abusive, say "I’m transferring you to a teammate" and trigger escalation.`}
        </pre>
      </div>
    ),
  },
  {
    title: "n8n Workflow Logic (Node-by-Node Explanation)",
    body: (
      <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm text-sm leading-6 text-zinc-800">
        <div>
          <p className="font-semibold text-zinc-900">1. Webhook (voice_inbound)</p>
          <p>Receives call start payload from telephony provider. Stores callId, caller ANI/DNIS, and initializes execution context.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">2. Set (session_init)</p>
          <p>Creates default JSON object with null fields, status `collecting`, timestamps, and Redis session keys.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">3. Function (startVoiceSession)</p>
          <p>Calls AI voice API to establish bidirectional audio stream. Returns sessionId, STT/TTS endpoints.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">4. IF (connectionCheck)</p>
          <p>Branches if voice session fails. On failure → Alert branch. On success → continue.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">5. Loop: Sub-workflow (conversationLoop)</p>
          <p>Triggered via n8n Execute Workflow node for turn-by-turn handling. Receives STT text events, calls LLM (OpenAI GPT-4o or Groq LLaMA) with system prompt, updates slot state, and sends TTS payload back through the voice API. Continues until status != `collecting`.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">6. Function (extractBookingIntent)</p>
          <p>Validates JSON structure, normalizes phone/email, enriches geo/timezone metadata.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">7. Google Calendar Node (checkAvailability)</p>
          <p>Queries free/busy for requested window. On conflict, calls Function (suggestAlternatives) to select next two openings.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">8. Function (composeConfirmation)</p>
          <p>Builds final voice response plus fallback instructions if slot unavailable. Marks status `ready_to_book` or `follow_up_required`.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">9. Google Calendar Node (createEvent)</p>
          <p>Creates event when status is `ready_to_book`. Stores eventId and meeting link.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">10. Google Sheets Node (appendRow)</p>
          <p>Appends structured data with timestamp. Uses service account credentials dedicated per client.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">11. Function (logCall)</p>
          <p>Writes call transcript, sentiment, and metadata to Postgres. Also pushes to external CRM webhook if configured.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">12. IF (statusCheck)</p>
          <p>If status equals `follow_up_required`, route to Task Queue (e.g., ClickUp/Asana node). Otherwise proceed.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">13. Slack Node (notifyOps)</p>
          <p>Sends summary with booking details, error flags, and recording link.</p>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">14. Error Trigger (global)</p>
          <p>Configured workflow to catch any unhandled exception, dump payload to S3/MinIO, and alert via PagerDuty.</p>
        </div>
      </div>
    ),
  },
  {
    title: "Data Schemas (JSON examples)",
    body: (
      <div className="space-y-6 rounded-xl border border-zinc-200 bg-slate-50 p-6 shadow-sm text-sm leading-6 text-zinc-800">
        <div>
          <p className="font-semibold text-zinc-900">Call Session Record</p>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-white p-4 text-xs text-zinc-900">{`{
  "call_id": "ca_9f4ba0",
  "started_at": "2024-07-21T15:02:11Z",
  "ended_at": "2024-07-21T15:18:44Z",
  "caller": {
    "name": "Jordan Ellis",
    "phone": "+14085551234",
    "email": "jordan@example.com"
  },
  "reason": "Requesting automation audit",
  "preferred_date": "2024-07-25",
  "preferred_time": "15:30",
  "final_slot": {
    "start": "2024-07-25T15:30:00-04:00",
    "end": "2024-07-25T16:00:00-04:00",
    "calendar_id": "primary",
    "event_id": "harbor-appointment-123"
  },
  "status": "booked",
  "transcript_url": "https://storage.harbor.ai/calls/ca_9f4ba0.txt",
  "notes": "Interested in retrofit package, wants onsite visit"
}`}</pre>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">Google Sheets Row Payload</p>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-white p-4 text-xs text-zinc-900">{`{
  "Name": "Jordan Ellis",
  "Phone": "+14085551234",
  "Email": "jordan@example.com",
  "Reason for Call": "Requesting automation audit",
  "Appointment Date": "2024-07-25",
  "Appointment Time": "3:30 PM EDT",
  "Call Timestamp": "2024-07-21T15:18:44Z"
}`}</pre>
        </div>
        <div>
          <p className="font-semibold text-zinc-900">Google Calendar Event</p>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-white p-4 text-xs text-zinc-900">{`{
  "summary": "Appointment – Jordan Ellis",
  "description": "Call reason: Requesting automation audit\\nCall notes: Interested in retrofit package, wants onsite visit",
  "start": { "dateTime": "2024-07-25T15:30:00-04:00", "timeZone": "America/New_York" },
  "end": { "dateTime": "2024-07-25T16:00:00-04:00", "timeZone": "America/New_York" },
  "attendees": [ { "email": "jordan@example.com" } ],
  "reminders": { "useDefault": false, "overrides": [ { "method": "email", "minutes": 1440 }, { "method": "popup", "minutes": 30 } ] }
}`}</pre>
        </div>
      </div>
    ),
  },
  {
    title: "Spreadsheet & Calendar Setup Instructions",
    body: (
      <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm text-sm leading-6 text-zinc-800">
        <p>- Create a dedicated Google Workspace service account. Delegate domain-wide authority for Sheets and Calendar scopes.</p>
        <p>- Share the target Spreadsheet with the service account email. Pre-create header columns: Name, Phone, Email, Reason for Call, Appointment Date, Appointment Time, Call Timestamp.</p>
        <p>- Configure timezone and locale settings per client sheet to avoid formatting errors. Lock header row to prevent accidental edits.</p>
        <p>- For Calendar, grant `Make changes and manage sharing` permission to the service account on the operational calendar (or dynamically map calendars via metadata table).</p>
        <p>- Store credentials in n8n using encrypted credentials vault. Rotate keys quarterly and log every access.</p>
        <p>- Enable audit logging in Google Admin to monitor Sheets edits and Calendar event creations for compliance.</p>
      </div>
    ),
  },
  {
    title: "Scaling Notes (multi-client ready)",
    body: (
      <div className="space-y-3 rounded-xl border border-zinc-200 bg-slate-50 p-6 shadow-sm text-sm leading-6 text-zinc-800">
        <p>- Multi-tenant metadata stored in Postgres table `clients` with per-client voice prompt, calendar ID, sheet ID, and SLA policies.</p>
        <p>- Use n8n queue mode with Redis + worker autoscaling to process concurrent calls without saturation. Each call executes in isolated executionId.</p>
        <p>
          - Telephony provider routes calls to per-client webhooks (
          <span className="font-mono">/webhook/voice/{"{clientSlug}"}</span>
          ) secured via HMAC signatures.
        </p>
        <p>- Provision distinct AI voice agent credentials per client to separate usage analytics and voice persona.</p>
        <p>- Central observability stack (Prometheus, Loki, Grafana) monitors call volume, booking conversion, latency, and error rates. Trigger PagerDuty on SLA breaches.</p>
        <p>- Implement automated regression tests: synthetic call flows using SIPp + mock voice API run hourly to verify booking path.</p>
      </div>
    ),
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-white to-slate-100 py-16 text-zinc-900">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-6">
        <header className="space-y-4 text-center sm:text-left">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            AI Voice Receptionist Deployment Blueprint
          </h1>
          <p className="text-lg text-slate-700 sm:max-w-3xl">
            Production-ready architecture for an autonomous, natural-sounding AI receptionist that answers calls, qualifies prospects, and books appointments without human intervention.
          </p>
        </header>
        <section className="grid gap-8">
          {sections.map((section) => (
            <article key={section.title} className="space-y-4">
              <h2 className="text-2xl font-semibold text-slate-900">
                {section.title}
              </h2>
              {section.body}
            </article>
          ))}
        </section>
        <footer className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
          Built for 24/7 reliability: combine SIP redundancy, n8n high-availability nodes, and rigorous monitoring to deliver a concierge-level voice experience that converts callers into booked appointments.
        </footer>
      </main>
    </div>
  );
}

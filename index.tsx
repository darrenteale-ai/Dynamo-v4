import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sql, S3Client } from "bun";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  WidthType,
  BorderStyle,
  AlignmentType,
  Footer,
  ImageRun,
} from "docx";
import { imageSize } from "image-size";
import QRCode from "qrcode";

const JWT_SECRET = Bun.env.JWT_SECRET || "dev-secret-change-me";
const SEED_ADMIN_EMAIL = Bun.env.SEED_ADMIN_EMAIL || "darren.teale@medicalemergencysolutions.co.uk";
const SEED_ADMIN_PASSWORD = Bun.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";

const s3 = new S3Client({
  accessKeyId: Bun.env.BUCKET_ACCESS_KEY_ID,
  secretAccessKey: Bun.env.BUCKET_SECRET_ACCESS_KEY,
  bucket: Bun.env.BUCKET_NAME,
  endpoint: Bun.env.BUCKET_ENDPOINT,
  region: Bun.env.BUCKET_REGION || "auto",
});

// ---- Bucket migration (US -> EU) ----
// While LEGACY_BUCKET_* is set, files not yet copied to the primary (EU)
// bucket are still read from the old bucket, and deletes go to both.
// Once every file is copied and verified, LEGACY_BUCKET_* is removed.
const legacyS3 = Bun.env.LEGACY_BUCKET_NAME
  ? new S3Client({
      accessKeyId: Bun.env.LEGACY_BUCKET_ACCESS_KEY_ID,
      secretAccessKey: Bun.env.LEGACY_BUCKET_SECRET_ACCESS_KEY,
      bucket: Bun.env.LEGACY_BUCKET_NAME,
      endpoint: Bun.env.LEGACY_BUCKET_ENDPOINT,
      region: Bun.env.LEGACY_BUCKET_REGION || "auto",
    })
  : null;

async function storageClientFor(key: string): Promise<S3Client> {
  if (!legacyS3) return s3;
  try {
    if (await s3.file(key).exists()) return s3;
  } catch {}
  return legacyS3;
}
async function storageRead(key: string): Promise<ArrayBuffer> {
  return (await storageClientFor(key)).file(key).arrayBuffer();
}
async function storagePresign(key: string): Promise<string> {
  return (await storageClientFor(key)).presign(key, { expiresIn: 300, method: "GET" });
}
async function storageDelete(key: string) {
  await s3.file(key).delete();
  if (legacyS3) await legacyS3.file(key).delete();
}

// Copies every attachment from the legacy bucket to the primary bucket,
// skipping ones already there with the same size. Safe to re-run.
async function migrateBucket() {
  if (!legacyS3) return { error: "No legacy bucket configured" };
  const rows = (await sql`SELECT file_key FROM incident_attachments`) as any[];
  const keys = new Set<string>(rows.map((r) => r.file_key));
  // Also pick up anything in the old bucket that isn't referenced in the DB.
  try {
    let token: string | undefined;
    do {
      const page: any = await legacyS3.list({ maxKeys: 1000, ...(token ? { continuationToken: token } : {}) });
      for (const o of page.contents || []) keys.add(o.key);
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
  } catch (err) {
    console.log(`Bucket migration: could not list legacy bucket: ${err}`);
  }
  let copied = 0, alreadyThere = 0, missingInLegacy = 0, failed = 0;
  const failures: string[] = [];
  for (const key of keys) {
    try {
      const src = legacyS3.file(key);
      if (!(await src.exists())) {
        if (await s3.file(key).exists()) alreadyThere++;
        else { missingInLegacy++; failures.push(`missing: ${key}`); }
        continue;
      }
      const srcSize = (await src.stat()).size;
      const dst = s3.file(key);
      if ((await dst.exists()) && (await dst.stat()).size === srcSize) { alreadyThere++; continue; }
      const stat = await src.stat();
      const buf = await src.arrayBuffer();
      await dst.write(buf, { type: (stat as any).type || "application/octet-stream" });
      if ((await dst.stat()).size !== srcSize) throw new Error("size mismatch after copy");
      copied++;
    } catch (err) {
      failed++;
      failures.push(`${key}: ${err}`);
    }
  }
  return { totalKeys: keys.size, copied, alreadyThere, missingInLegacy, failed, failures: failures.slice(0, 50) };
}

// JSON snapshot of every table, written to the primary bucket. Taken
// before the database region move as a safety copy.
async function snapshotDatabase() {
  const tables = [
    "users", "incidents", "incident_audit_log", "incident_attachments", "corrective_actions",
    "safety_alerts", "safety_alert_acks", "app_settings", "case_notes", "case_note_entries", "gdpr_log",
    "vehicles", "vdi_checks", "vehicle_defects",
  ];
  const out: Record<string, any[]> = {};
  for (const t of tables) out[t] = (await sql.unsafe(`SELECT * FROM ${t}`)) as any[];
  const key = `backups/db-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await s3.file(key).write(JSON.stringify(out), { type: "application/json" });
  return { key, counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])) };
}

const RESEND_API_KEY = Bun.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = Bun.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";

// Fire-and-forget style helper: never throws, just logs on failure, so a
// broken/misconfigured email provider can never block an incident report
// from being saved.
async function sendIncidentAckEmail(toEmail: string, ref: string, occurredAt: string) {
  if (!RESEND_API_KEY) {
    console.log(`Skipping incident ack email to ${toEmail}: RESEND_API_KEY not set`);
    return;
  }
  try {
    const occurredDate = new Date(occurredAt);
    const occurredLabel = isNaN(occurredDate.getTime())
      ? occurredAt
      : occurredDate.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" });
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Dynamo Incident Reporting <${RESEND_FROM_EMAIL}>`,
        to: [toEmail],
        subject: `Incident report received — ${ref}`,
        text:
          `Thank you — your incident report has been received.\n\n` +
          `Reference: ${ref}\n` +
          `Date/time of incident: ${occurredLabel}\n\n` +
          `Please quote this reference in any follow-up correspondence. ` +
          `A manager will review the report and be in touch if further information is needed.\n\n` +
          `This is an automated acknowledgement — please do not reply to this email.`,
        html:
          `<p>Thank you &mdash; your incident report has been received.</p>` +
          `<p><strong>Reference:</strong> ${ref}<br/>` +
          `<strong>Date/time of incident:</strong> ${occurredLabel}</p>` +
          `<p>Please quote this reference in any follow-up correspondence. A manager will review the report and be in touch if further information is needed.</p>` +
          `<p style="color:#666;font-size:12px;">This is an automated acknowledgement &mdash; please do not reply to this email.</p>`,
      }),
    });
    if (!res.ok) {
      console.log(`Incident ack email to ${toEmail} failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.log(`Incident ack email to ${toEmail} threw: ${err}`);
  }
}

// Generic fire-and-forget alert email to a list of staff addresses, used for
// both the HIGH-severity notify and the overdue-response escalation. Like
// sendIncidentAckEmail, this never throws — a misconfigured/unavailable
// email provider must never block an incident being saved or the incidents
// list from loading.
async function sendAlertEmail(toEmails: string[], subject: string, text: string, html: string) {
  const recipients = toEmails.filter(Boolean);
  if (recipients.length === 0) return;
  if (!RESEND_API_KEY) {
    console.log(`Skipping alert email "${subject}" to ${recipients.join(", ")}: RESEND_API_KEY not set`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Dynamo Incident Reporting <${RESEND_FROM_EMAIL}>`,
        to: recipients,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      console.log(`Alert email "${subject}" to ${recipients.join(", ")} failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.log(`Alert email "${subject}" to ${recipients.join(", ")} threw: ${err}`);
  }
}

async function getMgrAndAdminEmails(): Promise<string[]> {
  const rows = await sql`SELECT email FROM users WHERE active = TRUE AND role IN ('ADMIN', 'MANAGER')`;
  return rows.map((r: any) => r.email).filter(Boolean);
}

async function notifyHighSeverityIncident(ref: string, category: string | null, location: string | null, _description: string) {
  const emails = await getMgrAndAdminEmails();
  // Data minimisation: the incident description can contain patient health
  // information, so it is no longer copied into emails (which pass through a
  // third-party provider and sit in inboxes). Managers read it in Dynamo.
  const snippet = "Open the incident in Dynamo to read the full report.";
  ref = String(ref); category = category && escapeHtml(category); location = location && escapeHtml(location);
  await sendAlertEmail(
    emails,
    `HIGH/CRITICAL severity incident logged — ${ref}`,
    `A high-severity incident has just been reported.\n\n` +
      `Reference: ${ref}\n` +
      `Category: ${category || "Not specified"}\n` +
      `Location: ${location || "Not specified"}\n\n` +
      `${snippet}\n\n` +
      `Please review it in Dynamo as soon as possible.`,
    `<p>A high-severity incident has just been reported.</p>` +
      `<p><strong>Reference:</strong> ${ref}<br/>` +
      `<strong>Category:</strong> ${category || "Not specified"}<br/>` +
      `<strong>Location:</strong> ${location || "Not specified"}</p>` +
      `<p>${snippet}</p>` +
      `<p>Please review it in Dynamo as soon as possible.</p>`
  );
}

async function notifyBreachedIncident(ref: string, category: string | null, hoursOverdue: number) {
  const emails = await getMgrAndAdminEmails();
  const daysOverdue = Math.floor(hoursOverdue / 24);
  await sendAlertEmail(
    emails,
    `ESCALATION: response overdue — ${ref}`,
    `Incident ${ref} has missed its response deadline by more than ${ESCALATION_BREACH_HOURS} hours ` +
      `(roughly ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue) and no one has actioned it yet.\n\n` +
      `Category: ${category || "Not specified"}\n\n` +
      `Please review and assign it in Dynamo.`,
    `<p>Incident <strong>${ref}</strong> has missed its response deadline by more than ${ESCALATION_BREACH_HOURS} hours ` +
      `(roughly ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue) and no one has actioned it yet.</p>` +
      `<p><strong>Category:</strong> ${category || "Not specified"}</p>` +
      `<p>Please review and assign it in Dynamo.</p>`
  );
}

const DIGEST_SECRET = Bun.env.DIGEST_SECRET;

// Weekly summary email — composes counts + lists and sends them to every
// active manager/admin. Like the other alert emails this never throws.
async function runDigest(): Promise<{ recipientCount: number; emailSent: boolean }> {
  const daysToRespond = await getDaysToRespond();
  const hoursToAllocate = await getHoursToAllocate();
  const incidentRows = await sql`SELECT * FROM incidents`;
  const incidents = (incidentRows as any[]).map((r) => serializeIncident(r, daysToRespond, hoursToAllocate));
  const openIncidents = incidents.filter((i) => i.status !== "CLOSED");
  const overdueIncidents = incidents.filter((i) => i.responseStatus === "RED");
  const riddor = incidents.filter((i) => i.riddorReportable && i.status !== "CLOSED");
  const cqc = incidents.filter((i) => i.cqcNotifiable && i.status !== "CLOSED");
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const newThisWeek = incidents.filter((i) => new Date(i.createdAt) >= weekAgo);

  const overdueActions = await sql`
    SELECT ca.*, i.ref AS incident_ref FROM corrective_actions ca
    JOIN incidents i ON i.id = ca.incident_id
    WHERE ca.status <> 'DONE' AND ca.due_date IS NOT NULL AND ca.due_date < CURRENT_DATE
    ORDER BY ca.due_date ASC
  `;

  const [{ count: unackedAlerts }] = await sql`
    SELECT COUNT(*) AS count FROM safety_alerts WHERE active = TRUE
  `;

  const lines = [
    `New incidents this week: ${newThisWeek.length}`,
    `Currently open: ${openIncidents.length}`,
    `Overdue response: ${overdueIncidents.length}`,
    `RIDDOR reportable (open): ${riddor.length}`,
    `CQC notifiable (open): ${cqc.length}`,
    `Overdue corrective actions: ${overdueActions.length}`,
    `Active safety alerts: ${unackedAlerts}`,
  ];
  const listBlock = (label: string, rows: any[]) =>
    rows.length ? `\n${label}:\n` + rows.map((r: any) => `  - ${r.ref}${r.category ? " (" + (CATEGORY_LABEL_MAP[r.category] || r.category) + ")" : ""}`).join("\n") : "";

  const text =
    `Weekly Dynamo incident summary\n\n` +
    lines.join("\n") +
    listBlock("Overdue incidents", overdueIncidents) +
    listBlock("RIDDOR reportable", riddor) +
    listBlock("CQC notifiable", cqc) +
    (overdueActions.length
      ? `\nOverdue corrective actions:\n` + (overdueActions as any[]).map((a) => `  - ${a.incident_ref}: ${a.description}`).join("\n")
      : "") +
    `\n\nOpen Dynamo to review in full.`;

  const html =
    `<h2>Weekly Dynamo incident summary</h2><ul>` +
    lines.map((l) => `<li>${l}</li>`).join("") +
    `</ul>` +
    (overdueIncidents.length
      ? `<p><strong>Overdue incidents:</strong> ${overdueIncidents.map((i) => i.ref).join(", ")}</p>`
      : "") +
    (overdueActions.length
      ? `<p><strong>Overdue corrective actions:</strong> ${(overdueActions as any[]).map((a) => `${escapeHtml(a.incident_ref)}: ${escapeHtml(a.description)}`).join("; ")}</p>`
      : "");

  const emails = await getMgrAndAdminEmails();
  await sendAlertEmail(emails, `Dynamo weekly summary — ${new Date().toLocaleDateString("en-GB")}`, text, html);
  return { recipientCount: emails.length, emailSent: !!RESEND_API_KEY };
}

// Opportunistic escalation sweep: there's no background job runner in this
// deployment, so instead of a cron we check for breached, unescalated
// incidents whenever a manager/admin loads the incidents list (the normal
// path through which the app is used). Each incident is only escalated once
// (escalated_at is set immediately after sending).
async function escalateBreachedIncidents() {
  const daysToRespond = await getDaysToRespond();
  const candidates = await sql`
    SELECT id, ref, category, occurred_at FROM incidents
    WHERE status <> 'CLOSED' AND escalated_at IS NULL
  `;
  for (const row of candidates as any[]) {
    const hoursLeft = hoursUntilDeadline(row.occurred_at, daysToRespond);
    const hoursOverdue = -hoursLeft;
    if (hoursOverdue >= ESCALATION_BREACH_HOURS) {
      await notifyBreachedIncident(row.ref, row.category, hoursOverdue);
      await sql`UPDATE incidents SET escalated_at = now() WHERE id = ${row.id}`;
    }
  }
}

// The built frontend (gzip+base64) is too large for a single env var, so it is
// split across DYNAMO_HTML_B64_0..N and reconstructed here at boot.
function loadIndexHtmlGzB64(): string {
  const parts: string[] = [];
  let i = 0;
  while (true) {
    const part = Bun.env[`DYNAMO_HTML_B64_${i}`];
    if (part === undefined) break;
    const h = new Bun.CryptoHasher("sha256");
    h.update(part);
    console.log(`DYNAMO_HTML_B64_${i}: length=${part.length} sha256=${h.digest("hex")}`);
    parts.push(part);
    for (const suffix of ["_EXT", "_EXT2", "_EXT3"]) {
      const ext = Bun.env[`DYNAMO_HTML_B64_${i}${suffix}`];
      if (ext !== undefined) {
        const he = new Bun.CryptoHasher("sha256");
        he.update(ext);
        console.log(`DYNAMO_HTML_B64_${i}${suffix}: length=${ext.length} sha256=${he.digest("hex")}`);
        parts.push(ext);
      }
    }
    i++;
  }
  if (parts.length === 0) {
    throw new Error("DYNAMO_HTML_B64_0.. environment variables are not set");
  }
  return parts.join("");
}
// Newer frontend builds are stored in FRONTEND_B64_0..N (gzip+base64, each
// wrapped in "#" markers) with FRONTEND_SHA256; used when present and the
// checksum matches, otherwise the original DYNAMO_HTML_B64_* build is served.
function loadFrontendGzB64(): string {
  const parts: string[] = [];
  for (let i = 0; ; i++) {
    const v = Bun.env[`FRONTEND_B64_${i}`];
    if (v === undefined) break;
    parts.push(v.replace(/^#/, "").replace(/#$/, ""));
  }
  if (parts.length) {
    const joined = parts.join("");
    const h = new Bun.CryptoHasher("sha256");
    h.update(joined);
    const sum = h.digest("hex");
    if (sum === Bun.env.FRONTEND_SHA256) {
      console.log(`Frontend: using FRONTEND_B64 build (${parts.length} parts, sha256=${sum})`);
      return joined;
    }
    console.log(`Frontend: FRONTEND_B64 checksum mismatch (got ${sum}); falling back to previous build`);
  }
  return loadIndexHtmlGzB64();
}
// Since deploying from GitHub, the frontend lives in the repo as frontend.html
// and is used when present; the env-var builds remain as a fallback.
const FRONTEND_FILE = `${import.meta.dir}/frontend.html`;
const FRONTEND_FROM_FILE: string | null = (await Bun.file(FRONTEND_FILE).exists()) ? await Bun.file(FRONTEND_FILE).text() : null;
if (FRONTEND_FROM_FILE) console.log(`Frontend: using frontend.html from the repo (${FRONTEND_FROM_FILE.length} chars)`);
const INDEX_HTML_GZ_B64 = FRONTEND_FROM_FILE ? "" : loadFrontendGzB64();
{
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(INDEX_HTML_GZ_B64);
  console.log(
    `INDEX_HTML_GZ_B64 loaded: length=${INDEX_HTML_GZ_B64.length} sha256=${hasher.digest("hex")}`
  );
}
const INDEX_HTML_RAW = FRONTEND_FROM_FILE ?? new TextDecoder("utf-8").decode(Bun.gunzipSync(Buffer.from(INDEX_HTML_GZ_B64, "base64")));

async function ensureSchema() {
  // Older deploy attempts may have left behind tables with an incompatible
  // schema (e.g. no auto-incrementing id). Drop and recreate cleanly.
  const [{ exists: needsReset }] = await sql`
    SELECT NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'id' AND column_default IS NOT NULL
    ) AS exists
  `;
  if (needsReset) {
    await sql`DROP TABLE IF EXISTS users CASCADE`;
  }

  // One-time cutover: this app was previously a full rota/HR system. It has
  // been reduced to Incident Reporting only, so every other module's tables
  // (and the data in them) are dropped permanently.
  await sql`DROP TABLE IF EXISTS shift_crew CASCADE`;
  await sql`DROP TABLE IF EXISTS shifts CASCADE`;
  await sql`DROP TABLE IF EXISTS policy_acks CASCADE`;
  await sql`DROP TABLE IF EXISTS policies CASCADE`;
  await sql`DROP TABLE IF EXISTS recognitions CASCADE`;
  await sql`DROP TABLE IF EXISTS newsroom_posts CASCADE`;
  await sql`DROP TABLE IF EXISTS documents CASCADE`;
  // (vehicles / vdi_checks were dropped here too; those names are now used by
  // Fleet Management, so they are no longer dropped.)
  await sql`DROP TABLE IF EXISTS event_resource_crew CASCADE`;
  await sql`DROP TABLE IF EXISTS event_resources CASCADE`;
  await sql`DROP TABLE IF EXISTS events CASCADE`;
  await sql`DROP TABLE IF EXISTS compliance_records CASCADE`;
  await sql`DROP TABLE IF EXISTS onboarding_checks CASCADE`;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'MANAGER',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_after TIMESTAMPTZ`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMPTZ`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`;
  // Accounts that were already inactive before this column existed start
  // their retention clock now.
  await sql`UPDATE users SET deactivated_at = now() WHERE active = FALSE AND deactivated_at IS NULL`;

  await sql`
    CREATE TABLE IF NOT EXISTS incidents (
      id SERIAL PRIMARY KEY,
      ref TEXT UNIQUE NOT NULL,
      reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      location TEXT,
      severity TEXT NOT NULL DEFAULT 'LOW',
      description TEXT NOT NULL,
      people_involved TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      admin_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS category TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cad_ref TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS call_sign TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS crew_names TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS notified_by TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS date_sent_to_manager DATE`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS info_request_by DATE`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS completed_response_date DATE`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS outcome TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS recommendations TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS lessons_learnt TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS signature_name TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS investigator_name TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS designation TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS sign_off_date DATE`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS responsible_manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS on_call_manager_informed BOOLEAN`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS on_call_manager_name TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS on_call_manager_called_at TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS vehicle_reg TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reporter_email TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS riddor_reportable BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cqc_notifiable BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS related_incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS likelihood TEXT`;
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS impact TEXT`;

  await sql`
    CREATE TABLE IF NOT EXISTS incident_audit_log (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS incident_attachments (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'PHOTO',
      file_key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT,
      file_size INTEGER,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS corrective_actions (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date DATE,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS safety_alerts (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS safety_alert_acks (
      id SERIAL PRIMARY KEY,
      alert_id INTEGER NOT NULL REFERENCES safety_alerts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (alert_id, user_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      days_to_respond INTEGER NOT NULL DEFAULT 5,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS hours_to_allocate INTEGER NOT NULL DEFAULT 24`;
  await sql`
    CREATE TABLE IF NOT EXISTS case_notes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS case_note_entries (
      id SERIAL PRIMARY KEY,
      case_note_id INTEGER NOT NULL REFERENCES case_notes(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // ---- Fleet management ----
  await sql`
    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      reg TEXT UNIQUE NOT NULL,
      call_sign TEXT,
      vehicle_type TEXT,
      make_model TEXT,
      status TEXT NOT NULL DEFAULT 'AVAILABLE',
      mot_due DATE,
      service_due DATE,
      insurance_due DATE,
      tax_due DATE,
      notes TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS vdi_checks (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      checked_by TEXT,
      mileage INTEGER,
      results JSONB NOT NULL DEFAULT '[]'::jsonb,
      defect_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS vdi_checks_vehicle_created ON vdi_checks (vehicle_id, created_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS vehicle_defects (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      vdi_check_id INTEGER REFERENCES vdi_checks(id) ON DELETE SET NULL,
      item TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      reported_by TEXT,
      reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolution_notes TEXT
    )
  `;

  // ---- GDPR support ----
  await sql`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMPTZ`;
  // Retention periods are NULL (= switched off) until an admin sets them.
  await sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS retention_incident_months INTEGER`;
  await sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS retention_case_note_months INTEGER`;
  await sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS retention_inactive_staff_months INTEGER`;
  await sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS retention_last_run_at TIMESTAMPTZ`;
  await sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS retention_vdi_months INTEGER`;
  // Accountability record (Art. 5(2)) of every subject-access export,
  // anonymisation and retention run. Holds no personal data beyond the
  // acting admin's name and a description of what was done.
  await sql`
    CREATE TABLE IF NOT EXISTS gdpr_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_name TEXT,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function seed() {
  const hash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 10);
  await sql`
    INSERT INTO users (name, email, password_hash, role, active)
    VALUES (${"Darren Teale"}, ${SEED_ADMIN_EMAIL}, ${hash}, 'ADMIN', TRUE)
    ON CONFLICT (email) DO UPDATE SET role = 'ADMIN'
  `;
  await sql`INSERT INTO app_settings (id, days_to_respond) VALUES (1, 5) ON CONFLICT (id) DO NOTHING`;
  // Never log credentials (previous versions logged the admin password here).
  console.log(`Seed complete. Admin account: ${SEED_ADMIN_EMAIL}`);
}

// GDPR Art. 32: sessions are kept short, and every request re-checks the
// account in the database, so deactivating/deleting/anonymising a user or
// resetting their password ends their existing sessions immediately rather
// than leaving a token valid for days.
const SESSION_HOURS = 12;

function signToken(user: any) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, {
    expiresIn: `${SESSION_HOURS}h`,
  });
}

async function getAuth(req: Request): Promise<any> {
  const h = req.headers.get("authorization");
  if (!h || !h.startsWith("Bearer ")) return null;
  let payload: any;
  try {
    payload = jwt.verify(h.slice(7), JWT_SECRET);
  } catch {
    return null;
  }
  const [user] = await sql`
    SELECT id, name, email, role, active, tokens_valid_after FROM users WHERE id = ${payload.sub}
  `;
  if (!user || !user.active) return null;
  if (user.tokens_valid_after && payload.iat && payload.iat * 1000 < new Date(user.tokens_valid_after).getTime() - 1000) {
    return null;
  }
  // Use current DB values, not the (possibly stale) values baked into the token.
  return { ...payload, sub: user.id, name: user.name, email: user.email, role: user.role };
}

// ---- Login / public-form throttling (in-memory; resets on restart) ----
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_EMAIL = 5;
const LOGIN_MAX_PER_IP = 20;
const PUBLIC_REPORT_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_REPORT_MAX_PER_IP = 20;
const attemptBuckets = new Map<string, number[]>();

function recentAttempts(key: string, windowMs: number): number[] {
  const now = Date.now();
  const list = (attemptBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length) attemptBuckets.set(key, list);
  else attemptBuckets.delete(key);
  return list;
}
function recordAttempt(key: string) {
  const list = attemptBuckets.get(key) || [];
  list.push(Date.now());
  attemptBuckets.set(key, list);
}
function clientIp(req: Request, server: any): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  try {
    return server?.requestIP(req)?.address || "unknown";
  } catch {
    return "unknown";
  }
}

function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(self)",
};

function withSecurityHeaders(res: Response, isApi: boolean): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  // Personal data must not be cached by browsers or intermediaries.
  if (isApi && !res.headers.has("Cache-Control")) res.headers.set("Cache-Control", "no-store");
  return res;
}

function isMgrOrAdmin(auth: any) {
  return !!auth && (auth.role === "ADMIN" || auth.role === "MANAGER");
}

async function getDaysToRespond(): Promise<number> {
  const [row] = await sql`SELECT days_to_respond FROM app_settings WHERE id = 1`;
  return row ? row.days_to_respond : 5;
}

// Every open incident must have a responsible manager allocated within this
// many hours of being reported (independent of the response SLA above). An
// admin can adjust the window on the Settings page; default is 24 hours.
async function getHoursToAllocate(): Promise<number> {
  const [row] = await sql`SELECT hours_to_allocate FROM app_settings WHERE id = 1`;
  return row ? row.hours_to_allocate : 24;
}

function hoursUntilDeadline(occurredAt: string, daysToRespond: number): number {
  const deadline = new Date(occurredAt).getTime() + daysToRespond * 86400000;
  return (deadline - Date.now()) / 3600000;
}

function incidentResponseStatus(occurredAt: string, status: string, daysToRespond: number): string | null {
  if (status === "CLOSED") return null;
  const hoursLeft = hoursUntilDeadline(occurredAt, daysToRespond);
  if (hoursLeft < 0) return "RED";
  if (hoursLeft <= 24) return "AMBER";
  return "GREEN";
}

// Flags incidents that still have no responsible manager allocated. Measured
// from createdAt (when the report landed), not occurredAt, since allocation
// is an administrative step that starts the moment the report is received.
// Once a responsible manager is set this returns null — only the response
// SLA above applies from then on.
function allocationStatus(createdAt: string, responsibleManagerId: number | null, status: string, hoursToAllocate: number): string | null {
  if (status === "CLOSED") return null;
  if (responsibleManagerId) return null;
  const hoursSinceCreated = (Date.now() - new Date(createdAt).getTime()) / 3600000;
  const hoursLeft = hoursToAllocate - hoursSinceCreated;
  if (hoursLeft < 0) return "RED";
  if (hoursLeft <= Math.min(4, hoursToAllocate)) return "AMBER";
  return "GREEN";
}

// How many hours a RED (breached) incident sits without being escalated to
// an admin before we send an escalation email.
const ESCALATION_BREACH_HOURS = 24;

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const INCIDENT_CATEGORIES = [
  "CLINICAL",
  "MEDICATION",
  "VEHICLE_DAMAGE",
  "SAFEGUARDING",
  "COMPLAINT",
  "NEAR_MISS",
  "VIOLENCE",
  "INFECTION_CONTROL",
];

const INCIDENT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

const CATEGORY_LABEL_MAP: Record<string, string> = {
  CLINICAL: "Clinical",
  MEDICATION: "Medication",
  VEHICLE_DAMAGE: "Vehicle Damage",
  SAFEGUARDING: "Safeguarding",
  COMPLAINT: "Complaint",
  NEAR_MISS: "Near Miss",
  VIOLENCE: "Violence",
  INFECTION_CONTROL: "Infection Control",
};

async function nextIncidentRef() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const datePrefix = `${dd}/${mm}/${yyyy}`;
  const prefix = `${datePrefix} - `;
  const pattern = `^${escapeRegex(prefix)}[0-9]+$`;
  const substrFrom = prefix.length + 1;
  const [{ max }] = await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(ref FROM ${substrFrom}) AS INT)), 0) AS max FROM incidents WHERE ref ~ ${pattern}
  `;
  return `${prefix}${String((max || 0) + 1).padStart(4, "0")}`;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serializeIncident(row: any, daysToRespond: number, hoursToAllocate: number) {
  return {
    id: row.id,
    ref: row.ref,
    reportedBy: row.reported_by,
    reporterName: row.reporter_name,
    occurredAt: row.occurred_at,
    location: row.location,
    severity: row.severity,
    likelihood: row.likelihood,
    impact: row.impact,
    category: row.category,
    description: row.description,
    peopleInvolved: row.people_involved,
    status: row.status,
    adminNotes: row.admin_notes,
    createdAt: row.created_at,
    responseStatus: incidentResponseStatus(row.occurred_at, row.status, daysToRespond),
    allocationStatus: allocationStatus(row.created_at, row.responsible_manager_id, row.status, hoursToAllocate),
    cadRef: row.cad_ref,
    callSign: row.call_sign,
    crewNames: row.crew_names,
    notifiedBy: row.notified_by,
    dateSentToManager: row.date_sent_to_manager,
    infoRequestBy: row.info_request_by,
    completedResponseDate: row.completed_response_date,
    outcome: row.outcome,
    recommendations: row.recommendations,
    lessonsLearnt: row.lessons_learnt,
    signatureName: row.signature_name,
    investigatorName: row.investigator_name,
    designation: row.designation,
    signOffDate: row.sign_off_date,
    responsibleManagerId: row.responsible_manager_id,
    responsibleManagerName: row.responsible_manager_name,
    onCallManagerInformed: row.on_call_manager_informed,
    onCallManagerName: row.on_call_manager_name,
    onCallManagerCalledAt: row.on_call_manager_called_at,
    vehicleReg: row.vehicle_reg,
    reporterEmail: row.is_anonymous ? null : row.reporter_email,
    isAnonymous: row.is_anonymous,
    escalatedAt: row.escalated_at,
    riddorReportable: row.riddor_reportable,
    cqcNotifiable: row.cqc_notifiable,
    relatedIncidentId: row.related_incident_id,
    relatedIncidentRef: row.related_incident_ref,
  };
}

async function logIncidentAudit(incidentId: number, auth: any, action: string, details?: string | null) {
  await sql`
    INSERT INTO incident_audit_log (incident_id, action, actor_id, actor_name, details)
    VALUES (${incidentId}, ${action}, ${auth?.sub || null}, ${auth?.name || null}, ${details || null})
  `;
}

function serializeIncidentAuditEntry(row: any) {
  return {
    id: row.id,
    action: row.action,
    actorId: row.actor_id,
    actorName: row.actor_name,
    details: row.details,
    createdAt: row.created_at,
  };
}

function serializeCorrectiveAction(row: any) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    incidentRef: row.incident_ref,
    description: row.description,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    dueDate: row.due_date,
    status: row.status,
    overdue: row.status !== 'DONE' && row.due_date && new Date(row.due_date) < new Date(new Date().toDateString()),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function serializeSafetyAlert(row: any) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    incidentRef: row.incident_ref,
    title: row.title,
    body: row.body,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    active: row.active,
    ackCount: row.ack_count !== undefined ? Number(row.ack_count) : undefined,
    staffCount: row.staff_count !== undefined ? Number(row.staff_count) : undefined,
    acknowledged: row.acknowledged !== undefined ? !!row.acknowledged : undefined,
  };
}

function serializeIncidentAttachment(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    fileName: row.file_name,
    contentType: row.content_type,
    fileSize: row.file_size,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name,
    createdAt: row.created_at,
  };
}

function fmtDocDate(value: any) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB");
}

function fmtDocDateTime(value: any) {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) return "";
  const datePart = d.toLocaleDateString("en-GB");
  const timePart = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${datePart} ${timePart}`;
}

function docLabelRow(label: string, value: string) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 35, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
      }),
      new TableCell({
        width: { size: 65, type: WidthType.PERCENTAGE },
        children: [new Paragraph(value || "")],
      }),
    ],
  });
}

function docFreeTextSection(heading: string, body: string) {
  return [
    new Paragraph({ text: heading, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: (body ? body.split("\n") : [""]).map((line) => new Paragraph(line)),
            }),
          ],
        }),
      ],
    }),
  ];
}

function docAuditTrailSection(entries: any[]) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      new TableCell({ width: { size: 22, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: "Timestamp", bold: true })] })] }),
      new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: "Action", bold: true })] })] }),
      new TableCell({ width: { size: 20, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: "By", bold: true })] })] }),
      new TableCell({ width: { size: 38, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: "Details", bold: true })] })] }),
    ],
  });
  const rows = (entries || []).map(
    (e: any) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(fmtDocDateTime(e.createdAt))] }),
          new TableCell({ children: [new Paragraph(e.action || "")] }),
          new TableCell({ children: [new Paragraph(e.actorName || "")] }),
          new TableCell({ children: [new Paragraph(e.details || "")] }),
        ],
      })
  );
  return [
    new Paragraph({ text: "Audit trail", heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.length ? [headerRow, ...rows] : [headerRow],
    }),
  ];
}

// Maps a stored content-type to the image kind the "docx" library can embed.
// Anything else (e.g. heic, webp) is skipped from the embedded gallery but
// still listed in the attachments list below it.
function docxImageType(contentType: string | null | undefined): "jpg" | "png" | "gif" | "bmp" | null {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("bmp")) return "bmp";
  return null;
}

type EmbeddablePhoto = {
  fileName: string;
  type: "jpg" | "png" | "gif" | "bmp";
  bytes: Uint8Array;
  width: number;
  height: number;
};

function docPhotosSection(photos: EmbeddablePhoto[], skippedCount: number) {
  if (photos.length === 0 && skippedCount === 0) return [];
  const MAX_WIDTH = 460;
  const blocks: Paragraph[] = [
    new Paragraph({ text: "Photographs", heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }),
  ];
  for (const photo of photos) {
    let { width, height } = photo;
    if (!width || !height) {
      width = MAX_WIDTH;
      height = Math.round(MAX_WIDTH * 0.75);
    } else if (width > MAX_WIDTH) {
      height = Math.round((height / width) * MAX_WIDTH);
      width = MAX_WIDTH;
    }
    blocks.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: photo.type,
            data: photo.bytes,
            transformation: { width, height },
          } as any),
        ],
        spacing: { after: 60 },
      })
    );
    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: photo.fileName, italics: true, size: 16 })],
        spacing: { after: 220 },
      })
    );
  }
  if (skippedCount > 0) {
    blocks.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${skippedCount} attached file${skippedCount === 1 ? "" : "s"} could not be previewed in this document and ${skippedCount === 1 ? "is" : "are"} available in Dynamo.`,
            italics: true,
            size: 16,
          }),
        ],
      })
    );
  }
  return blocks;
}

async function buildIncidentDocx(incident: any, photos: EmbeddablePhoto[] = [], skippedPhotoCount = 0) {
  const generatedAt = fmtDocDateTime(new Date());
  const doc = new Document({
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [new TextRun("QA4\tAugust 2025 v2\tGenerated: " + generatedAt)],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({ text: "Incident Report", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "Investigation response form", heading: HeadingLevel.HEADING_3, spacing: { after: 200 } }),
          new Paragraph({
            children: [new TextRun({ text: `Form generated: ${generatedAt}`, italics: true, size: 18 })],
            spacing: { after: 200 },
          }),

          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              docLabelRow("Date of incident:", fmtDocDate(incident.occurredAt)),
              docLabelRow("Incident Ref:", incident.ref || ""),
              docLabelRow("Responsible manager:", incident.responsibleManagerName || "Unassigned"),
              docLabelRow("Vehicle registration:", incident.vehicleReg || ""),
              docLabelRow("Reporter email:", incident.reporterEmail || ""),
              docLabelRow("CAD Ref:", incident.cadRef || ""),
              docLabelRow("Call sign:", incident.callSign || ""),
              docLabelRow("Crew names and grade:", incident.crewNames || ""),
              docLabelRow("Reported by:", incident.reporterName || incident.notifiedBy || ""),
              docLabelRow(
                "On-call manager informed:",
                incident.onCallManagerInformed
                  ? `Yes${incident.onCallManagerName ? " — " + incident.onCallManagerName : ""}${incident.onCallManagerCalledAt ? " at " + incident.onCallManagerCalledAt : ""}`
                  : "No"
              ),
              docLabelRow("Date sent to manager:", fmtDocDate(incident.dateSentToManager)),
              docLabelRow("Further information request by:", fmtDocDate(incident.infoRequestBy)),
              docLabelRow("Completed response date:", fmtDocDate(incident.completedResponseDate)),
            ],
          }),

          new Paragraph({ spacing: { before: 200 } }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    children: [
                      new Paragraph({ children: [new TextRun({ text: "Action required", bold: true })] }),
                      new Paragraph(
                        "Please note the Completed Response Date above and ensure completed documentation is forwarded to the investigator (sender of this form) by this date. Completed responses submitted ahead of this date would be appreciated."
                      ),
                      new Paragraph(
                        "Any request for further information or documentation must be made within three calendar days of receipt of this document."
                      ),
                    ],
                  }),
                ],
              }),
            ],
          }),

          ...docFreeTextSection("Incident description", incident.description || ""),
          ...docFreeTextSection("Outcome of investigation", incident.outcome || ""),
          ...docFreeTextSection("Recommendations / conclusions", incident.recommendations || ""),
          ...docFreeTextSection("Lessons learnt / action plan", incident.lessonsLearnt || ""),

          new Paragraph({ text: "Sign-off", heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              docLabelRow("Signature:", incident.signatureName || ""),
              docLabelRow("Investigator name:", incident.investigatorName || ""),
              docLabelRow("Designation:", incident.designation || ""),
              docLabelRow("Date:", fmtDocDate(incident.signOffDate)),
            ],
          }),

          ...docPhotosSection(photos, skippedPhotoCount),

          ...docAuditTrailSection(incident.auditTrail || []),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function countTableSection(heading: string, counts: { label: string; count: number }[]) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: heading, bold: true })] })] }),
      new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: "Count", bold: true })] })] }),
    ],
  });
  const rows = counts.map(
    (c) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(c.label)] }),
          new TableCell({ children: [new Paragraph(String(c.count))] }),
        ],
      })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.length ? [headerRow, ...rows] : [headerRow],
  });
}

function countBy(incidents: any[], key: string): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of incidents) {
    const label = i[key] || "Not specified";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

async function buildIncidentSummaryDocx(incidents: any[], range: { from?: string; to?: string }) {
  const generatedAt = fmtDocDateTime(new Date());
  const rangeLabel =
    range.from || range.to
      ? `${range.from ? fmtDocDate(range.from) : "the start"} to ${range.to ? fmtDocDate(range.to) : "now"}`
      : "all recorded incidents";
  const overdue = incidents.filter((i: any) => i.responseStatus === "RED");
  const riddor = incidents.filter((i: any) => i.riddorReportable);
  const cqc = incidents.filter((i: any) => i.cqcNotifiable);

  const overdueRows = overdue.map(
    (i: any) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(i.ref || "")] }),
          new TableCell({ children: [new Paragraph(CATEGORY_LABEL_MAP[i.category] || i.category || "")] }),
          new TableCell({ children: [new Paragraph(i.severity || "")] }),
          new TableCell({ children: [new Paragraph(i.responsibleManagerName || "Unassigned")] }),
        ],
      })
  );
  const overdueHeader = new TableRow({
    tableHeader: true,
    children: [
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Ref", bold: true })] })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Category", bold: true })] })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Severity", bold: true })] })] }),
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Responsible manager", bold: true })] })] }),
    ],
  });

  const doc = new Document({
    sections: [
      {
        footers: {
          default: new Footer({
            children: [new Paragraph({ children: [new TextRun("Dynamo incident summary\tGenerated: " + generatedAt)] })],
          }),
        },
        children: [
          new Paragraph({ text: "Incident Reporting — Summary Report", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [new TextRun({ text: `Covering ${rangeLabel}. Generated: ${generatedAt}. Total incidents: ${incidents.length}.`, italics: true, size: 18 })],
            spacing: { after: 200 },
          }),

          new Paragraph({ text: "By category", heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }),
          countTableSection("Category", countBy(incidents.map((i: any) => ({ category: CATEGORY_LABEL_MAP[i.category] || i.category })), "category")),

          new Paragraph({ text: "By severity", heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }),
          countTableSection("Severity", countBy(incidents, "severity")),

          new Paragraph({ text: "By status", heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }),
          countTableSection("Status", countBy(incidents, "status")),

          new Paragraph({ text: "By vehicle", heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }),
          countTableSection("Vehicle", countBy(incidents, "vehicleReg")),

          new Paragraph({ text: "By location", heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }),
          countTableSection("Location", countBy(incidents, "location")),

          new Paragraph({
            text: `Overdue response (${overdue.length})`,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 100 },
          }),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: overdueRows.length ? [overdueHeader, ...overdueRows] : [overdueHeader] }),

          new Paragraph({
            text: `Regulatory flags — RIDDOR reportable: ${riddor.length}, CQC notifiable: ${cqc.length}`,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 100 },
          }),
          new Paragraph(
            riddor.length || cqc.length
              ? [...riddor.map((i: any) => i.ref + " (RIDDOR)"), ...cqc.map((i: any) => i.ref + " (CQC)")].join(", ")
              : "None flagged for this period."
          ),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function sanitizeFileName(name: string) {
  return String(name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
}

function genTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function serializeStaff(row: any) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    active: row.active,
  };
}

// =====================================================================
// Privacy notice (Arts. 13/14) and the admin data-protection page.
// Organisation details come from environment variables so they can be
// corrected without a code change.
// =====================================================================

const PRIVACY = {
  controller: Bun.env.PRIVACY_CONTROLLER || "Medical Emergency Solutions",
  contactEmail: Bun.env.PRIVACY_CONTACT_EMAIL || "",
  contactAddress: Bun.env.PRIVACY_CONTACT_ADDRESS || "",
  dpoName: Bun.env.PRIVACY_DPO_NAME || "",
  hostingLocation: Bun.env.PRIVACY_HOSTING_LOCATION || "the European Union (Amsterdam, the Netherlands)",
  lastUpdated: Bun.env.PRIVACY_LAST_UPDATED || "6 October 2026",
};

const PAGE_STYLE = `
  :root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#5f5f5a; --card:#fff; --line:#e2e1dc; --accent:#b4231c; --ok:#1f6f3a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe6; --muted:#a3a29b; --card:#1f1f1d; --line:#33332f; --accent:#ff6b5e; --ok:#6fcf8b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.7rem; margin: 0 0 4px; } h2 { font-size: 1.15rem; margin: 28px 0 8px; }
  p, li { color: var(--fg); } .muted { color: var(--muted); font-size: .9rem; }
  a { color: var(--accent); }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 8px 6px; vertical-align: top; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 14px 0; }
  input, select, button { font: inherit; padding: 8px 10px; border-radius: 7px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  input, select { width: 100%; margin: 4px 0 10px; }
  button { cursor: pointer; background: var(--fg); color: var(--bg); border: 0; }
  button.danger { background: var(--accent); color: #fff; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  label { font-size: .9rem; color: var(--muted); }
  pre { white-space: pre-wrap; font-size: .85rem; background: var(--bg); padding: 10px; border-radius: 7px; overflow-x: auto; }
  .tabs { display:flex; gap:6px; flex-wrap: wrap; margin: 16px 0; }
  .tabs button { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  .tabs button.on { background: var(--fg); color: var(--bg); }
  .row { display:flex; gap:10px; flex-wrap: wrap; } .row > * { flex: 1 1 200px; }
  .warn { border-left: 4px solid var(--accent); padding-left: 12px; }
`;

function privacyContactHtml() {
  const bits: string[] = [];
  if (PRIVACY.dpoName) bits.push(`Data protection lead: ${escapeHtml(PRIVACY.dpoName)}`);
  if (PRIVACY.contactEmail) bits.push(`Email: <a href="mailto:${escapeHtml(PRIVACY.contactEmail)}">${escapeHtml(PRIVACY.contactEmail)}</a>`);
  if (PRIVACY.contactAddress) bits.push(`Post: ${escapeHtml(PRIVACY.contactAddress)}`);
  if (!bits.length) bits.push("Please contact your manager or the company office and ask for the data protection lead.");
  return bits.join("<br/>");
}

function monthsLabel(m: number | null, fallback: string) {
  if (!m) return fallback;
  if (m % 12 === 0) return `${m / 12} year${m === 12 ? "" : "s"}`;
  return `${m} months`;
}

async function renderPrivacyPage() {
  const r = await getRetentionSettings();
  const c = escapeHtml(PRIVACY.controller);
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Privacy notice</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>Privacy notice — Dynamo incident reporting</h1>
<p class="muted">Last updated ${escapeHtml(PRIVACY.lastUpdated)}</p>

<p>${c} ("we") uses Dynamo to record and investigate incidents, near misses, complaints and safety concerns connected with our services. This notice explains what personal information Dynamo holds, why, and your rights. We are the controller of this information under the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018.</p>

<h2>Who to contact</h2>
<p>${privacyContactHtml()}</p>

<h2>What we collect</h2>
<ul>
<li><strong>If you submit an incident report:</strong> your name, optionally your email address (so we can send you a reference), the vehicle registration, call sign, crew names, CAD reference, the date, time and place of the incident, your description, and any photos you attach. Near-miss reports can be made anonymously.</li>
<li><strong>People mentioned in a report</strong> (for example patients, members of the public or colleagues): names and details that the reporter or investigating manager records. Reports about clinical care, safeguarding, medication or injuries may include <strong>information about a person's health</strong>, which is special category data.</li>
<li><strong>If you complete a vehicle daily check:</strong> your name, the vehicle, its mileage, the check results and any defects you describe.</li>
<li><strong>Managers and administrators who use Dynamo:</strong> name, work email, phone number, role, sign-in credentials (stored only as a secure hash), and a record of actions taken on each incident.</li>
</ul>

<h2>Why we use it, and our lawful basis</h2>
<ul>
<li>To record, investigate and learn from incidents and keep patients, staff and the public safe — <em>legal obligation</em> (including health and safety law, RIDDOR reporting and Care Quality Commission requirements) and <em>legitimate interests</em> in running a safe service.</li>
<li>Health information is processed for the provision and management of health care and for public health (UK GDPR Article 9(2)(h) and (i), with the conditions in Schedule 1 of the Data Protection Act 2018), and where needed to establish or defend legal claims (Article 9(2)(f)).</li>
<li>Staff account information is processed to provide secure access to the system — <em>contract</em> (employment) and <em>legitimate interests</em>.</li>
</ul>

<h2>Who we share it with</h2>
<p>Reports are seen only by authorised managers and administrators. Where the law requires it we may share information with regulators such as the Health and Safety Executive or the Care Quality Commission, with commissioners, insurers or legal advisers, or with the police or safeguarding authorities. We do not sell personal information or use it for marketing.</p>
<p>We use service providers who process data on our behalf under contract: Railway (application hosting and database), an S3-compatible storage provider (photos and documents) and Resend (email delivery). Our hosting provider stores this data in ${escapeHtml(PRIVACY.hostingLocation)}. Where data is held outside the UK we rely on safeguards approved under UK law for international transfers.</p>

<h2>How long we keep it</h2>
<ul>
<li>Incident records: ${monthsLabel(r.incidentMonths, "for as long as required by our records retention schedule")} from the date of the incident, after which names, contact details, descriptions and photos are permanently removed. Anonymised statistics may be kept.</li>
<li>Case notes: ${monthsLabel(r.caseNoteMonths, "in line with our records retention schedule")} after the last entry.</li>
<li>Staff accounts: until ${monthsLabel(r.inactiveStaffMonths, "a reasonable period")} after the account is closed, then anonymised.</li>
<li>Vehicle daily checks: ${monthsLabel(r.vdiMonths, "in line with our records retention schedule")} after the check, unless a defect from it is still open.</li>
</ul>

<h2>Keeping it secure</h2>
<p>Dynamo is only available to named managers and administrators, over encrypted connections, with role-based access, sign-in throttling and an audit trail of who viewed, changed or exported each record.</p>

<h2>Your rights</h2>
<p>You can ask for a copy of the personal information we hold about you, ask us to correct it, ask us to delete it or restrict how we use it, and object to how we use it. Some rights are limited where we must keep records by law (for example, we may anonymise rather than delete an incident record). We will respond within one month. To make a request, use the contact details above.</p>
<p>If you are unhappy with how we have handled your information you can complain to the Information Commissioner's Office: <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk/make-a-complaint</a>, telephone 0303 123 1113.</p>
</main></body></html>`;
}

// Small "Privacy" link injected into every page of the main app (including
// the public /report form) without needing to rebuild the bundled frontend.
// On phones it sits at the end of the page instead of floating, so it never
// covers form buttons.
const PRIVACY_LINK_SNIPPET = `<style>#dyn-privacy-link{position:fixed;right:10px;bottom:8px;z-index:2147483000;font:12px system-ui,sans-serif;color:#555;background:rgba(255,255,255,.85);padding:3px 8px;border-radius:6px;text-decoration:underline}@media (max-width:700px){#root{height:auto;min-height:100%}#dyn-privacy-link{position:static;display:block;width:max-content;margin:12px auto 20px;background:none}}</style><a id="dyn-privacy-link" href="/privacy" target="_blank" rel="noopener">Privacy notice</a>`;

function injectPrivacyLink(html: string) {
  const i = html.lastIndexOf("</body>");
  return i === -1 ? html + PRIVACY_LINK_SNIPPET : html.slice(0, i) + PRIVACY_LINK_SNIPPET + html.slice(i);
}

const GDPR_ADMIN_PAGE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/><title>Data protection tools</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>Data protection tools</h1>
<p class="muted">Admins only. Every action here is recorded in the data protection log. <a href="/privacy" target="_blank">View privacy notice</a> · <a href="/">Back to Dynamo</a></p>

<div id="login" class="card">
  <p>Sign in with your Dynamo admin account.</p>
  <label>Email</label><input id="em" type="email" autocomplete="username"/>
  <label>Password</label><input id="pw" type="password" autocomplete="current-password"/>
  <button id="loginBtn">Sign in</button> <span id="loginMsg" class="muted"></span>
</div>

<div id="app" hidden>
  <div class="tabs">
    <button data-tab="person" class="on">Person request</button>
    <button data-tab="retention">Retention</button>
    <button data-tab="log">Log</button>
    <button id="logout" class="ghost">Sign out</button>
  </div>

  <section data-panel="person">
    <div class="card">
      <p>Find everything Dynamo holds about one person (including vehicle checks they completed, matched by name), for a subject access request (copy of data) or an erasure request (anonymise).</p>
      <label>Staff account (if they have one)</label><select id="userId"><option value="">— not a staff member —</option></select>
      <div class="row">
        <div><label>Email address (e.g. a public reporter)</label><input id="email" type="email"/></div>
        <div><label>Name as written in reports</label><input id="name"/></div>
      </div>
      <button id="searchBtn">Search</button> <button id="exportBtn" class="ghost">Download export (JSON)</button>
    </div>
    <div id="results"></div>
    <div class="card warn" id="anonCard" hidden>
      <h2 style="margin-top:0">Anonymise this person</h2>
      <p>Replaces their name in crew / reporter / people-involved / investigator fields, removes their email from reports, and (for staff) strips name, email, phone and password from their account. Incident records themselves are kept. Descriptions and notes are <strong>not</strong> edited automatically; any that mention them are listed afterwards for manual review. <strong>This cannot be undone.</strong></p>
      <label><input type="checkbox" id="inclAudit" style="width:auto"/> Also anonymise their name in the incident audit trail (normally kept for accountability)</label>
      <label>Type ANONYMISE to confirm</label><input id="anonConfirm"/>
      <button id="anonBtn" class="danger">Anonymise</button>
      <div id="anonResult"></div>
    </div>
  </section>

  <section data-panel="retention" hidden>
    <div class="card">
      <p>Once set, a retention run happens automatically about once a day. Closed incidents older than the period have names, contact details, descriptions, notes and photos permanently removed (category, severity, dates, flags and lessons learnt are kept). Leave a box empty to switch that rule off.</p>
      <div class="row">
        <div><label>Closed incidents (months, min 36)</label><input id="rInc" type="number" min="36"/></div>
        <div><label>Case notes (months, min 12)</label><input id="rCase" type="number" min="12"/></div>
        <div><label>Leaver accounts (months after deactivation)</label><input id="rStaff" type="number" min="1"/></div>
        <div><label>Vehicle checks (months, min 12)</label><input id="rVdi" type="number" min="12"/></div>
      </div>
      <button id="rSave">Save</button> <button id="rPreview" class="ghost">Preview what would be removed</button>
      <p class="muted" id="rLast"></p>
      <div id="rOut"></div>
      <div id="rRunBox" hidden class="warn">
        <label>Type RUN to apply now</label><input id="rConfirm"/>
        <button id="rRun" class="danger">Run retention now</button>
      </div>
    </div>
  </section>

  <section data-panel="log" hidden><div class="card" id="logOut"></div></section>
</div>
</main>
<script>
let token = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(opts.headers || {}) } });
  if (res.status === 401) { signOut(); throw new Error("Session expired — sign in again"); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") && !res.headers.get("content-disposition") ? await res.json() : res;
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}
function signOut() { token = null; $("app").hidden = true; $("login").hidden = false; }
$("logout").onclick = signOut;
$("loginBtn").onclick = async () => {
  $("loginMsg").textContent = "";
  const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("em").value, password: $("pw").value }) });
  const data = await res.json();
  if (!res.ok) return ($("loginMsg").textContent = data.error || "Sign-in failed");
  if (data.user.role !== "ADMIN") return ($("loginMsg").textContent = "These tools are for admins only.");
  token = data.token; $("pw").value = "";
  $("login").hidden = true; $("app").hidden = false;
  loadStaff(); loadRetention();
};
document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => {
  document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll("[data-panel]").forEach((p) => p.hidden = p.dataset.panel !== b.dataset.tab);
  if (b.dataset.tab === "log") loadLog();
});
async function loadStaff() {
  const staff = await api("/api/gdpr/staff");
  $("userId").innerHTML = '<option value="">— not a staff member —</option>' + staff.map((s) =>
    '<option value="' + s.id + '">' + esc(s.name) + " (" + esc(s.email) + ")" + (s.anonymised_at ? " — anonymised" : s.active ? "" : " — inactive") + "</option>").join("");
}
function query() {
  const p = new URLSearchParams();
  if ($("userId").value) p.set("userId", $("userId").value);
  if ($("email").value.trim()) p.set("email", $("email").value.trim());
  if ($("name").value.trim()) p.set("name", $("name").value.trim());
  return p;
}
$("searchBtn").onclick = async () => {
  try {
    const r = await api("/api/gdpr/search?" + query());
    const s = r.subject;
    $("results").innerHTML = '<div class="card"><p><strong>Searching for:</strong> ' +
      [s.user ? "staff account #" + s.user.id + " " + esc(s.user.name) : null, s.email ? esc(s.email) : null, s.name ? "name “" + esc(s.name) + "”" : null].filter(Boolean).join(" · ") +
      "</p><p>" + r.incidents.length + " incident(s) found.</p>" +
      (r.incidents.length ? "<table><tr><th>Ref</th><th>Date</th><th>Status</th><th>Why it matched</th></tr>" +
        r.incidents.map((i) => "<tr><td>" + esc(i.ref) + "</td><td>" + esc(new Date(i.occurredAt).toLocaleDateString("en-GB")) + "</td><td>" + esc(i.status) + "</td><td>" + esc(i.matches.join("; ")) + "</td></tr>").join("") + "</table>" : "") +
      '<p class="muted">Name matches are by text, so check for other people with similar names before acting.</p></div>';
    $("anonCard").hidden = false; $("anonResult").innerHTML = "";
  } catch (e) { $("results").innerHTML = '<p class="warn">' + esc(e.message) + "</p>"; }
};
$("exportBtn").onclick = async () => {
  try {
    const res = await api("/api/gdpr/export?" + query());
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "subject-access-export-" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
  } catch (e) { alert(e.message); }
};
$("anonBtn").onclick = async () => {
  try {
    const q = query();
    const r = await api("/api/gdpr/anonymise", { method: "POST", body: JSON.stringify({
      userId: q.get("userId") || undefined, email: q.get("email") || undefined, name: q.get("name") || undefined,
      includeAuditTrail: $("inclAudit").checked, confirm: $("anonConfirm").value.trim() }) });
    $("anonConfirm").value = "";
    $("anonResult").innerHTML = "<pre>" + esc(JSON.stringify(r, null, 2)) + "</pre>";
    loadStaff();
  } catch (e) { $("anonResult").innerHTML = '<p class="warn">' + esc(e.message) + "</p>"; }
};
async function loadRetention() {
  const r = await api("/api/gdpr/retention");
  $("rInc").value = r.incidentMonths ?? ""; $("rCase").value = r.caseNoteMonths ?? ""; $("rStaff").value = r.inactiveStaffMonths ?? ""; $("rVdi").value = r.vdiMonths ?? "";
  $("rLast").textContent = r.lastRunAt ? "Last run: " + new Date(r.lastRunAt).toLocaleString("en-GB") : "Not run yet.";
}
$("rSave").onclick = async () => {
  try {
    await api("/api/gdpr/retention", { method: "PUT", body: JSON.stringify({ incidentMonths: $("rInc").value, caseNoteMonths: $("rCase").value, inactiveStaffMonths: $("rStaff").value, vdiMonths: $("rVdi").value }) });
    await loadRetention(); $("rOut").innerHTML = '<p>Saved.</p>';
  } catch (e) { $("rOut").innerHTML = '<p class="warn">' + esc(e.message) + "</p>"; }
};
$("rPreview").onclick = async () => {
  try {
    const p = await api("/api/gdpr/retention/preview");
    const list = (t, rows, f) => "<h2>" + t + " (" + rows.length + ")</h2>" + (rows.length ? "<ul>" + rows.slice(0, 200).map((r) => "<li>" + f(r) + "</li>").join("") + "</ul>" : '<p class="muted">None.</p>');
    $("rOut").innerHTML =
      list("Incidents", p.incidents, (r) => esc(r.ref) + " — " + esc(new Date(r.occurredAt).toLocaleDateString("en-GB"))) +
      list("Case notes", p.caseNotes, (r) => esc(r.title)) +
      list("Leaver accounts", p.staff, (r) => esc(r.name)) +
      list("Vehicle checks", p.vdiChecks, (r) => esc(r.vehicleReg) + " — " + esc(new Date(r.createdAt).toLocaleDateString("en-GB")));
    $("rRunBox").hidden = !(p.incidents.length || p.caseNotes.length || p.staff.length || p.vdiChecks.length);
  } catch (e) { $("rOut").innerHTML = '<p class="warn">' + esc(e.message) + "</p>"; }
};
$("rRun").onclick = async () => {
  try {
    const r = await api("/api/gdpr/retention/run", { method: "POST", body: JSON.stringify({ confirm: $("rConfirm").value.trim() }) });
    $("rConfirm").value = ""; $("rRunBox").hidden = true;
    $("rOut").innerHTML = "<pre>" + esc(JSON.stringify(r, null, 2)) + "</pre>"; loadRetention();
  } catch (e) { $("rOut").innerHTML = '<p class="warn">' + esc(e.message) + "</p>"; }
};
async function loadLog() {
  const rows = await api("/api/gdpr/log");
  $("logOut").innerHTML = rows.length ? "<table><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr>" +
    rows.map((r) => "<tr><td>" + esc(new Date(r.created_at).toLocaleString("en-GB")) + "</td><td>" + esc(r.actor_name) + "</td><td>" + esc(r.action) + "</td><td>" + esc(r.details) + "</td></tr>").join("") + "</table>"
    : '<p class="muted">No data protection actions yet.</p>';
}
</script></body></html>`;

// =====================================================================
// GDPR: data subject rights (Art. 15 access, Art. 17 erasure) and
// storage limitation (Art. 5(1)(e) retention). Admin-only.
// =====================================================================

function isAdmin(auth: any) {
  return !!auth && auth.role === "ADMIN";
}

async function logGdpr(auth: any, action: string, details: string) {
  await sql`
    INSERT INTO gdpr_log (action, actor_id, actor_name, details)
    VALUES (${action}, ${auth?.sub || null}, ${auth?.name || "System (scheduled)"}, ${details})
  `;
}

const ANON_REPORTER = "[anonymised]";
const RETENTION_REDACTED = "[Removed under data retention policy]";

// Identify a data subject either by staff account (userId), by email (for
// public reporters who aren't staff), and/or by a name string (to find them
// in the free-text name fields like crew_names / people_involved).
async function resolveSubject(params: { userId?: any; email?: any; name?: any }) {
  let user: any = null;
  if (params.userId) {
    [user] = await sql`
      SELECT id, name, email, phone, role, active, created_at, deactivated_at, anonymised_at
      FROM users WHERE id = ${Number(params.userId)}
    `;
  }
  const email = String(params.email || user?.email || "").trim().toLowerCase() || null;
  const name = String(params.name || user?.name || "").trim() || null;
  if (!user && email) {
    [user] = await sql`
      SELECT id, name, email, phone, role, active, created_at, deactivated_at, anonymised_at
      FROM users WHERE lower(email) = ${email}
    `;
  }
  return { user: user || null, email, name: name && name.length >= 3 ? name : null };
}

async function findSubjectIncidents(subject: { user: any; email: string | null; name: string | null }) {
  const userId = subject.user?.id ?? -1;
  // NULL never matches (comparisons with NULL are not true) — the previous
  // "\u0000" sentinel was rejected by Postgres and broke name-only searches.
  const email = subject.email ?? null;
  const like = subject.name ? `%${subject.name.replace(/[%_\\]/g, "\\$&")}%` : null;
  return await sql`
    SELECT i.*,
      (i.reported_by = ${userId}) AS m_reported_by,
      (i.responsible_manager_id = ${userId}) AS m_responsible_manager,
      (lower(i.reporter_email) = ${email}) AS m_reporter_email,
      (i.notified_by ILIKE ${like}) AS m_notified_by,
      (i.crew_names ILIKE ${like}) AS m_crew_names,
      (i.people_involved ILIKE ${like}) AS m_people_involved,
      (i.investigator_name ILIKE ${like} OR i.signature_name ILIKE ${like} OR i.on_call_manager_name ILIKE ${like}) AS m_named_role,
      (i.description ILIKE ${like} OR i.admin_notes ILIKE ${like} OR i.outcome ILIKE ${like}
        OR i.recommendations ILIKE ${like} OR i.lessons_learnt ILIKE ${like}) AS m_free_text
    FROM incidents i
    WHERE i.reported_by = ${userId}
       OR i.responsible_manager_id = ${userId}
       OR lower(i.reporter_email) = ${email}
       OR i.notified_by ILIKE ${like}
       OR i.crew_names ILIKE ${like}
       OR i.people_involved ILIKE ${like}
       OR i.investigator_name ILIKE ${like}
       OR i.signature_name ILIKE ${like}
       OR i.on_call_manager_name ILIKE ${like}
       OR i.description ILIKE ${like}
       OR i.admin_notes ILIKE ${like}
       OR i.outcome ILIKE ${like}
       OR i.recommendations ILIKE ${like}
       OR i.lessons_learnt ILIKE ${like}
    ORDER BY i.occurred_at ASC
  `;
}

function matchReasons(r: any): string[] {
  const out: string[] = [];
  if (r.m_reported_by) out.push("reported by this staff account");
  if (r.m_responsible_manager) out.push("responsible manager");
  if (r.m_reporter_email) out.push("reporter email");
  if (r.m_notified_by) out.push("named as person reporting");
  if (r.m_crew_names) out.push("named in crew");
  if (r.m_people_involved) out.push("named in people involved");
  if (r.m_named_role) out.push("named as investigator / signatory / on-call manager");
  if (r.m_free_text) out.push("name appears in free text (review manually)");
  return out;
}

async function buildSubjectExport(subject: { user: any; email: string | null; name: string | null }) {
  const userId = subject.user?.id ?? -1;
  const like = subject.name ? `%${subject.name.replace(/[%_\\]/g, "\\$&")}%` : null;
  const daysToRespond = await getDaysToRespond();
  const hoursToAllocate = await getHoursToAllocate();
  const incidentRows = await findSubjectIncidents(subject);
  const incidents = (incidentRows as any[]).map((r) => ({
    whyIncluded: matchReasons(r),
    ...serializeIncident(r, daysToRespond, hoursToAllocate),
  }));
  const incidentIds = (incidentRows as any[]).map((r) => r.id);

  const attachments = incidentIds.length
    ? await sql`
        SELECT id, incident_id, kind, file_name, content_type, file_size, uploaded_by, created_at
        FROM incident_attachments WHERE incident_id IN ${sql(incidentIds)} OR uploaded_by = ${userId}
      `
    : await sql`
        SELECT id, incident_id, kind, file_name, content_type, file_size, uploaded_by, created_at
        FROM incident_attachments WHERE uploaded_by = ${userId}
      `;
  const correctiveActions = await sql`
    SELECT ca.*, i.ref AS incident_ref FROM corrective_actions ca
    JOIN incidents i ON i.id = ca.incident_id
    WHERE ca.owner_id = ${userId} OR ca.created_by = ${userId} OR ca.description ILIKE ${like}
  `;
  const auditEntries = await sql`
    SELECT l.*, i.ref AS incident_ref FROM incident_audit_log l
    JOIN incidents i ON i.id = l.incident_id
    WHERE l.actor_id = ${userId} OR l.details ILIKE ${like}
      OR (${subject.email}::text IS NOT NULL AND l.details ILIKE ${"%" + (subject.email || "") + "%"})
    ORDER BY l.created_at ASC
  `;
  const safetyAlertAcks = await sql`
    SELECT a.alert_id, s.title, a.acknowledged_at FROM safety_alert_acks a
    JOIN safety_alerts s ON s.id = a.alert_id WHERE a.user_id = ${userId}
  `;
  const safetyAlertsCreated = await sql`SELECT id, title, body, created_at FROM safety_alerts WHERE created_by = ${userId}`;
  const caseNotes = await sql`
    SELECT n.id, n.title, n.body, n.created_at, n.author_id FROM case_notes n
    WHERE n.author_id = ${userId} OR n.title ILIKE ${like} OR n.body ILIKE ${like}
       OR EXISTS (SELECT 1 FROM case_note_entries e WHERE e.case_note_id = n.id AND (e.author_id = ${userId} OR e.body ILIKE ${like}))
  `;
  const vehicleChecks = subject.name
    ? await sql`
        SELECT c.id, v.reg AS vehicle_reg, c.checked_by, c.mileage, c.defect_count, c.notes, c.created_at
        FROM vdi_checks c JOIN vehicles v ON v.id = c.vehicle_id
        WHERE c.checked_by ILIKE ${like} ORDER BY c.created_at ASC
      `
    : [];
  const vehicleDefectsReported = subject.name
    ? await sql`
        SELECT d.id, v.reg AS vehicle_reg, d.item, d.description, d.status, d.reported_by, d.reported_at
        FROM vehicle_defects d JOIN vehicles v ON v.id = d.vehicle_id
        WHERE d.reported_by ILIKE ${like} ORDER BY d.reported_at ASC
      `
    : [];
  const caseNoteIds = (caseNotes as any[]).map((n) => n.id);
  const caseNoteEntries = caseNoteIds.length
    ? await sql`SELECT id, case_note_id, body, author_id, created_at FROM case_note_entries WHERE case_note_id IN ${sql(caseNoteIds)}`
    : [];

  return {
    generatedAt: new Date().toISOString(),
    controller: PRIVACY.controller,
    searchedFor: { staffAccountId: subject.user?.id ?? null, email: subject.email, name: subject.name },
    reviewWarning:
      "BEFORE SENDING: this export is a search result, not a final disclosure. It may include information about " +
      "other people (patients, colleagues, members of the public) and matches on similar names. Check every item, " +
      "remove anything that is not about the requester, and redact third-party details as required by UK GDPR / " +
      "DPA 2018 before releasing it. Respond within one month of the request.",
    staffAccount: subject.user,
    incidents,
    attachments,
    correctiveActions,
    incidentAuditEntries: auditEntries,
    safetyAlertsAcknowledged: safetyAlertAcks,
    safetyAlertsCreated,
    caseNotes,
    caseNoteEntries,
    vehicleChecks,
    vehicleDefectsReported,
  };
}

// Replace occurrences of a name inside a text column, case-insensitively.
function nameRegex(name: string) {
  return escapeRegex(name);
}

async function anonymiseSubject(
  auth: any,
  subject: { user: any; email: string | null; name: string | null },
  opts: { includeAuditTrail: boolean }
) {
  const summary: Record<string, number> = {};
  const userId = subject.user?.id ?? null;
  const label = userId ? `Former staff member #${userId}` : ANON_REPORTER;
  const rx = subject.name ? nameRegex(subject.name) : null;

  // 1. Public reporter by email: drop the email and the reporter name on
  //    reports they submitted.
  if (subject.email) {
    const rows = await sql`
      UPDATE incidents SET reporter_email = NULL,
        notified_by = CASE WHEN notified_by IS NULL THEN NULL ELSE ${label} END
      WHERE lower(reporter_email) = ${subject.email}
      RETURNING id
    `;
    summary.reportsUnlinkedFromEmail = rows.length;
    for (const r of rows as any[]) {
      await logIncidentAudit(r.id, auth, "ANONYMISED", `Reporter details anonymised following a data protection request`);
    }
    const auditRows = await sql`
      UPDATE incident_audit_log SET details = replace(details, ${subject.email}, ${ANON_REPORTER})
      WHERE details ILIKE ${"%" + subject.email + "%"} RETURNING id
    `;
    summary.auditEntriesEmailRemoved = auditRows.length;
  }

  // 2. Name in structured name fields on incidents.
  if (rx) {
    const rows = await sql`
      UPDATE incidents SET
        notified_by = regexp_replace(notified_by, ${rx}, ${label}, 'gi'),
        crew_names = regexp_replace(crew_names, ${rx}, ${label}, 'gi'),
        people_involved = regexp_replace(people_involved, ${rx}, ${label}, 'gi'),
        investigator_name = regexp_replace(investigator_name, ${rx}, ${label}, 'gi'),
        signature_name = regexp_replace(signature_name, ${rx}, ${label}, 'gi'),
        on_call_manager_name = regexp_replace(on_call_manager_name, ${rx}, ${label}, 'gi')
      WHERE notified_by ~* ${rx} OR crew_names ~* ${rx} OR people_involved ~* ${rx}
         OR investigator_name ~* ${rx} OR signature_name ~* ${rx} OR on_call_manager_name ~* ${rx}
      RETURNING id
    `;
    summary.incidentsNameFieldsAnonymised = rows.length;
    const vc = await sql`
      UPDATE vdi_checks SET checked_by = regexp_replace(checked_by, ${rx}, ${label}, 'gi')
      WHERE checked_by ~* ${rx} RETURNING id
    `;
    summary.vehicleChecksAnonymised = vc.length;
    const vd = await sql`
      UPDATE vehicle_defects SET reported_by = regexp_replace(reported_by, ${rx}, ${label}, 'gi')
      WHERE reported_by ~* ${rx} RETURNING id
    `;
    summary.vehicleDefectsAnonymised = vd.length;
    for (const r of rows as any[]) {
      await logIncidentAudit(r.id, auth, "ANONYMISED", `Named individual anonymised following a data protection request`);
    }
    if (opts.includeAuditTrail) {
      const a = await sql`
        UPDATE incident_audit_log SET
          details = regexp_replace(details, ${rx}, ${label}, 'gi'),
          actor_name = regexp_replace(actor_name, ${rx}, ${label}, 'gi')
        WHERE details ~* ${rx} OR actor_name ~* ${rx} RETURNING id
      `;
      summary.auditEntriesNameAnonymised = a.length;
    }
  }

  // 3. Staff account itself: strip identity and credentials, keep the row so
  //    foreign keys (who did what) still resolve to a placeholder.
  if (userId) {
    const randomHash = await bcrypt.hash(crypto.randomUUID() + crypto.randomUUID(), 10);
    await sql`
      UPDATE users SET name = ${label}, email = ${`anonymised-${userId}@invalid.local`}, phone = NULL,
        password_hash = ${randomHash}, active = FALSE, anonymised_at = now(), tokens_valid_after = now(),
        deactivated_at = COALESCE(deactivated_at, now())
      WHERE id = ${userId}
    `;
    if (opts.includeAuditTrail) {
      await sql`UPDATE incident_audit_log SET actor_name = ${label} WHERE actor_id = ${userId}`;
    }
    summary.staffAccountAnonymised = 1;
  }

  // Free text (descriptions, notes) is clinical/investigation record content
  // and is not edited automatically: list it for manual review instead.
  const freeTextRefs = rx
    ? ((await sql`
        SELECT ref FROM incidents
        WHERE description ~* ${rx} OR admin_notes ~* ${rx} OR outcome ~* ${rx}
           OR recommendations ~* ${rx} OR lessons_learnt ~* ${rx}
      `) as any[]).map((r) => r.ref)
    : [];
  const caseNoteHits = rx
    ? ((await sql`
        SELECT DISTINCT n.id, n.title FROM case_notes n
        LEFT JOIN case_note_entries e ON e.case_note_id = n.id
        WHERE n.title ~* ${rx} OR n.body ~* ${rx} OR e.body ~* ${rx}
      `) as any[]).map((r) => `#${r.id} ${r.title}`)
    : [];

  await logGdpr(
    auth,
    "ANONYMISE",
    `Anonymised ${userId ? `staff account #${userId}` : "a non-staff data subject"}` +
      ` (${Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(", ") || "no records changed"}).` +
      ` Audit trail names ${opts.includeAuditTrail ? "anonymised" : "retained"}.` +
      (freeTextRefs.length ? ` Free-text mentions left for manual review in ${freeTextRefs.length} incident(s).` : "")
  );
  return { summary, manualReview: { incidentsWithFreeTextMentions: freeTextRefs, caseNotesWithMentions: caseNoteHits } };
}

// ---- Retention ----
async function getRetentionSettings() {
  const [row] = await sql`
    SELECT retention_incident_months, retention_case_note_months, retention_inactive_staff_months, retention_last_run_at,
      retention_vdi_months
    FROM app_settings WHERE id = 1
  `;
  return {
    incidentMonths: row?.retention_incident_months ?? null,
    caseNoteMonths: row?.retention_case_note_months ?? null,
    inactiveStaffMonths: row?.retention_inactive_staff_months ?? null,
    vdiMonths: row?.retention_vdi_months ?? null,
    lastRunAt: row?.retention_last_run_at ?? null,
  };
}

// What a retention run would touch. Incidents are only ever eligible once
// CLOSED; the clock runs from the date the incident occurred.
async function retentionCandidates() {
  const s = await getRetentionSettings();
  const incidents = s.incidentMonths
    ? await sql`
        SELECT id, ref, occurred_at, status FROM incidents
        WHERE status = 'CLOSED' AND anonymised_at IS NULL
          AND occurred_at < now() - make_interval(months => ${s.incidentMonths})
        ORDER BY occurred_at ASC
      `
    : [];
  const caseNotes = s.caseNoteMonths
    ? await sql`
        SELECT n.id, n.title, GREATEST(n.created_at, COALESCE(MAX(e.created_at), n.created_at)) AS last_activity
        FROM case_notes n LEFT JOIN case_note_entries e ON e.case_note_id = n.id
        GROUP BY n.id
        HAVING GREATEST(n.created_at, COALESCE(MAX(e.created_at), n.created_at)) < now() - make_interval(months => ${s.caseNoteMonths})
      `
    : [];
  const staff = s.inactiveStaffMonths
    ? await sql`
        SELECT id, name, deactivated_at FROM users
        WHERE active = FALSE AND anonymised_at IS NULL AND deactivated_at IS NOT NULL
          AND deactivated_at < now() - make_interval(months => ${s.inactiveStaffMonths})
      `
    : [];
  // Vehicle checks with no open defect attached.
  const vdiChecks = s.vdiMonths
    ? await sql`
        SELECT c.id, c.created_at, v.reg AS vehicle_reg FROM vdi_checks c JOIN vehicles v ON v.id = c.vehicle_id
        WHERE c.created_at < now() - make_interval(months => ${s.vdiMonths})
          AND NOT EXISTS (SELECT 1 FROM vehicle_defects d WHERE d.vdi_check_id = c.id AND d.status = 'OPEN')
        ORDER BY c.created_at ASC
      `
    : [];
  return { settings: s, incidents, caseNotes, staff, vdiChecks };
}

async function runRetention(auth: any) {
  const { settings, incidents, caseNotes, staff, vdiChecks } = await retentionCandidates();
  let filesDeleted = 0;
  let fileErrors = 0;
  // Files are deleted from storage for incidents being anonymised now, and
  // retried for any earlier run where a storage delete failed.
  const ids = (incidents as any[]).map((i) => i.id);
  const files = await sql`
    SELECT ia.id, ia.incident_id, ia.file_key FROM incident_attachments ia
    JOIN incidents i ON i.id = ia.incident_id
    WHERE i.anonymised_at IS NOT NULL ${ids.length ? sql`OR ia.incident_id IN ${sql(ids)}` : sql``}
  `;
  for (const f of files as any[]) {
    {
      const inc = { id: f.incident_id };
      try {
        await storageDelete(f.file_key);
        await sql`DELETE FROM incident_attachments WHERE id = ${f.id}`;
        filesDeleted++;
      } catch (err) {
        fileErrors++;
        console.log(`Retention: failed to delete file for incident ${inc.id}: ${err}`);
      }
    }
  }
  for (const inc of incidents as any[]) {
    // Keep the bare record (ref, dates, category, severity, RIDDOR/CQC flags,
    // status, recommendations and lessons learnt) for statistics and
    // organisational learning; remove everything that identifies or
    // describes individuals.
    await sql`
      UPDATE incidents SET
        description = ${RETENTION_REDACTED},
        people_involved = NULL, crew_names = NULL, notified_by = NULL, reporter_email = NULL,
        location = NULL, admin_notes = NULL, outcome = NULL,
        investigator_name = NULL, signature_name = NULL, designation = NULL,
        on_call_manager_name = NULL, cad_ref = NULL,
        reported_by = NULL, responsible_manager_id = NULL,
        anonymised_at = now()
      WHERE id = ${inc.id}
    `;
    await sql`UPDATE incident_audit_log SET details = NULL, actor_name = NULL, actor_id = NULL WHERE incident_id = ${inc.id}`;
    await sql`UPDATE corrective_actions SET description = ${RETENTION_REDACTED}, owner_id = NULL, created_by = NULL WHERE incident_id = ${inc.id}`;
    await logIncidentAudit(inc.id, null, "RETENTION_ANONYMISED", "Personal data removed under the data retention policy");
  }
  for (const n of caseNotes as any[]) {
    await sql`DELETE FROM case_notes WHERE id = ${n.id}`;
  }
  for (const u of staff as any[]) {
    await anonymiseSubject(auth, { user: u, email: null, name: null }, { includeAuditTrail: false });
  }
  for (const c of vdiChecks as any[]) {
    // Resolved defects from the check are kept (vehicle history) but lose the reporter's name.
    await sql`UPDATE vehicle_defects SET reported_by = NULL WHERE vdi_check_id = ${c.id}`;
    await sql`DELETE FROM vdi_checks WHERE id = ${c.id}`;
  }
  await sql`UPDATE app_settings SET retention_last_run_at = now() WHERE id = 1`;
  const result = {
    incidentsAnonymised: incidents.length,
    attachmentsDeleted: filesDeleted,
    attachmentDeleteErrors: fileErrors,
    caseNotesDeleted: caseNotes.length,
    leaverAccountsAnonymised: staff.length,
    vehicleChecksDeleted: vdiChecks.length,
  };
  await logGdpr(
    auth,
    "RETENTION_RUN",
    `Retention run (months — incidents ${settings.incidentMonths ?? "off"}, case notes ${settings.caseNoteMonths ?? "off"}, ` +
      `leavers ${settings.inactiveStaffMonths ?? "off"}, vehicle checks ${settings.vdiMonths ?? "off"}): ` +
      Object.entries(result).map(([k, v]) => `${k} ${v}`).join(", ")
  );
  return result;
}

// Opportunistic daily run (there is no job runner in this deployment): when
// an admin/manager loads the incidents list and the last run was over 24h
// ago, run retention in the background. Does nothing until an admin has
// set at least one retention period.
let retentionRunning = false;
async function maybeRunRetention() {
  if (retentionRunning) return;
  const s = await getRetentionSettings();
  if (!s.incidentMonths && !s.caseNoteMonths && !s.inactiveStaffMonths && !s.vdiMonths) return;
  if (s.lastRunAt && Date.now() - new Date(s.lastRunAt).getTime() < 24 * 3600 * 1000) return;
  retentionRunning = true;
  try {
    await runRetention(null);
  } finally {
    retentionRunning = false;
  }
}

async function handleGdprRequest(req: Request, url: URL, path: string, method: string): Promise<Response | null> {
  if (!path.startsWith("/api/gdpr/")) return null;

  // Scheduled retention trigger (e.g. a Railway cron hitting this endpoint
  // with the same x-digest-key secret as the weekly digest).
  if (path === "/api/gdpr/retention/run" && method === "POST" && DIGEST_SECRET && req.headers.get("x-digest-key") === DIGEST_SECRET) {
    return json(await runRetention(null));
  }

  const auth = await getAuth(req);
  const keyOk = !!DIGEST_SECRET && req.headers.get("x-digest-key") === DIGEST_SECRET;
  if ((isAdmin(auth) || keyOk) && method === "POST" && path === "/api/gdpr/storage/migrate") {
    const r = await migrateBucket();
    await logGdpr(auth, "STORAGE_MIGRATION", `File copy to EU bucket: ${JSON.stringify({ ...r, failures: undefined })}`);
    return json(r);
  }
  if ((isAdmin(auth) || keyOk) && method === "POST" && path === "/api/gdpr/storage/snapshot") {
    const r = await snapshotDatabase();
    await logGdpr(auth, "DB_SNAPSHOT", `Database snapshot written to EU bucket (${r.key})`);
    return json(r);
  }
  if (!auth) return json({ error: "Unauthorized" }, 401);
  if (!isAdmin(auth)) return json({ error: "Data protection tools are restricted to admins." }, 403);

  if (path === "/api/gdpr/search" && method === "GET") {
    const subject = await resolveSubject({
      userId: url.searchParams.get("userId"),
      email: url.searchParams.get("email"),
      name: url.searchParams.get("name"),
    });
    if (!subject.user && !subject.email && !subject.name) {
      return json({ error: "Enter a staff member, an email address, or a name (3+ characters)." }, 400);
    }
    const rows = await findSubjectIncidents(subject);
    return json({
      subject,
      incidents: (rows as any[]).map((r) => ({ id: r.id, ref: r.ref, occurredAt: r.occurred_at, status: r.status, matches: matchReasons(r) })),
    });
  }

  if (path === "/api/gdpr/export" && method === "GET") {
    const subject = await resolveSubject({
      userId: url.searchParams.get("userId"),
      email: url.searchParams.get("email"),
      name: url.searchParams.get("name"),
    });
    if (!subject.user && !subject.email && !subject.name) {
      return json({ error: "Enter a staff member, an email address, or a name (3+ characters)." }, 400);
    }
    const data = await buildSubjectExport(subject);
    await logGdpr(
      auth,
      "SUBJECT_ACCESS_EXPORT",
      `Subject access export generated for ${subject.user ? `staff account #${subject.user.id}` : "a non-staff data subject"} ` +
        `(${data.incidents.length} incident(s) matched)`
    );
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="subject-access-export-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  }

  if (path === "/api/gdpr/anonymise" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "ANONYMISE") return json({ error: 'Type ANONYMISE to confirm. This cannot be undone.' }, 400);
    const subject = await resolveSubject({ userId: body.userId, email: body.email, name: body.name });
    if (!subject.user && !subject.email && !subject.name) {
      return json({ error: "Enter a staff member, an email address, or a name (3+ characters)." }, 400);
    }
    if (subject.user && subject.user.id === auth.sub) return json({ error: "You cannot anonymise your own account." }, 400);
    const result = await anonymiseSubject(auth, subject, { includeAuditTrail: body.includeAuditTrail === true });
    return json(result);
  }

  if (path === "/api/gdpr/retention" && method === "GET") {
    return json(await getRetentionSettings());
  }

  if (path === "/api/gdpr/retention" && method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const clean = (v: any, min: number) => {
      if (v === null || v === undefined || v === "" || Number(v) === 0) return null;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < min || n > 600) throw new Error(`Retention periods must be between ${min} and 600 months`);
      return n;
    };
    let incident, caseNote, staff, vdi;
    try {
      // Floors stop an accidental "1" from wiping recent records:
      // incidents at least 3 years (RIDDOR records must be kept 3 years).
      incident = clean(body.incidentMonths, 36);
      caseNote = clean(body.caseNoteMonths, 12);
      staff = clean(body.inactiveStaffMonths, 1);
      vdi = clean(body.vdiMonths, 12);
    } catch (err: any) {
      return json({ error: err.message }, 400);
    }
    await sql`
      UPDATE app_settings SET retention_incident_months = ${incident}, retention_case_note_months = ${caseNote},
        retention_inactive_staff_months = ${staff}, retention_vdi_months = ${vdi}, updated_at = now()
      WHERE id = 1
    `;
    await logGdpr(auth, "RETENTION_SETTINGS", `Retention set: incidents ${incident ?? "off"}, case notes ${caseNote ?? "off"}, leavers ${staff ?? "off"}, vehicle checks ${vdi ?? "off"} (months)`);
    return json(await getRetentionSettings());
  }

  if (path === "/api/gdpr/retention/preview" && method === "GET") {
    const c = await retentionCandidates();
    return json({
      settings: c.settings,
      incidents: (c.incidents as any[]).map((r) => ({ id: r.id, ref: r.ref, occurredAt: r.occurred_at })),
      caseNotes: (c.caseNotes as any[]).map((r) => ({ id: r.id, title: r.title, lastActivity: r.last_activity })),
      staff: (c.staff as any[]).map((r) => ({ id: r.id, name: r.name, deactivatedAt: r.deactivated_at })),
      vdiChecks: (c.vdiChecks as any[]).map((r) => ({ id: r.id, vehicleReg: r.vehicle_reg, createdAt: r.created_at })),
    });
  }

  if (path === "/api/gdpr/retention/run" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "RUN") return json({ error: "Type RUN to confirm. This cannot be undone." }, 400);
    return json(await runRetention(auth));
  }

  if (path === "/api/gdpr/log" && method === "GET") {
    const rows = await sql`SELECT * FROM gdpr_log ORDER BY created_at DESC LIMIT 200`;
    return json(rows);
  }

  if (path === "/api/gdpr/staff" && method === "GET") {
    const rows = await sql`SELECT id, name, email, role, active, anonymised_at FROM users ORDER BY name`;
    return json(rows);
  }

  return json({ error: "Not found" }, 404);
}

// =====================================================================
// Fleet management: vehicles (with MOT / service / insurance / tax due
// dates), crew vehicle daily inspections (VDI) submitted from a public
// no-login form, and defects raised from failed check items.
// =====================================================================

const VEHICLE_STATUSES = ["AVAILABLE", "OFF_ROAD", "MAINTENANCE"];
const DEFECT_STATUSES = ["OPEN", "RESOLVED"];

// Single source of truth for the VDI checklist; the public form fetches it.
const VDI_CHECKLIST: { section: string; items: string[] }[] = [
  {
    section: "Exterior",
    items: [
      "Tyres, wheels and wheel nuts",
      "Lights and indicators",
      "Blue lights and sirens",
      "Windscreen, wipers and washers",
      "Mirrors",
      "Bodywork, doors and locks",
    ],
  },
  {
    section: "Mechanical",
    items: [
      "Engine oil, coolant and screenwash levels",
      "Brakes",
      "Fuel level adequate for shift",
      "No dashboard warning lights",
    ],
  },
  {
    section: "Cab and saloon",
    items: [
      "Seatbelts",
      "Stretcher, ramp / tail-lift",
      "Oxygen cylinders and regulators",
      "Defibrillator (AED) checked and charged",
      "Medical kit and drug bags sealed",
      "Fire extinguisher",
      "Cleanliness and infection control",
      "Vehicle documents and fuel card present",
    ],
  },
];
const VDI_ITEMS = VDI_CHECKLIST.flatMap((s) => s.items);

const PUBLIC_VDI_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_VDI_MAX_PER_IP = 30;

function cleanDate(v: any): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function cleanText(v: any, max: number): string | null {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
}
function toDateStr(d: any): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}
// "OVERDUE" | "DUE_SOON" (within 30 days) | "OK" | null (no date set)
function dueStatus(d: any): string | null {
  const s = toDateStr(d);
  if (!s) return null;
  const today = new Date(new Date().toISOString().slice(0, 10)).getTime();
  const due = new Date(s).getTime();
  if (due < today) return "OVERDUE";
  if (due - today <= 30 * 86400000) return "DUE_SOON";
  return "OK";
}

function serializeVehicle(row: any) {
  return {
    id: row.id,
    reg: row.reg,
    callSign: row.call_sign,
    vehicleType: row.vehicle_type,
    makeModel: row.make_model,
    status: row.status,
    motDue: toDateStr(row.mot_due),
    serviceDue: toDateStr(row.service_due),
    insuranceDue: toDateStr(row.insurance_due),
    taxDue: toDateStr(row.tax_due),
    motStatus: dueStatus(row.mot_due),
    serviceStatus: dueStatus(row.service_due),
    insuranceStatus: dueStatus(row.insurance_due),
    taxStatus: dueStatus(row.tax_due),
    notes: row.notes,
    active: row.active,
    lastCheckAt: row.last_check_at ?? null,
    lastCheckDefects: row.last_check_defects ?? null,
    openDefects: row.open_defects !== undefined ? Number(row.open_defects) : 0,
  };
}

function serializeVdiCheck(row: any) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    vehicleReg: row.vehicle_reg,
    callSign: row.call_sign,
    checkedBy: row.checked_by,
    mileage: row.mileage,
    results: row.results,
    defectCount: row.defect_count,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function serializeDefect(row: any) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    vehicleReg: row.vehicle_reg,
    callSign: row.call_sign,
    vdiCheckId: row.vdi_check_id,
    item: row.item,
    description: row.description,
    status: row.status,
    reportedBy: row.reported_by,
    reportedAt: row.reported_at,
    resolvedAt: row.resolved_at,
    resolvedByName: row.resolved_by_name,
    resolutionNotes: row.resolution_notes,
  };
}

async function listVehicles(includeArchived: boolean) {
  return await sql`
    SELECT v.*,
      (SELECT MAX(c.created_at) FROM vdi_checks c WHERE c.vehicle_id = v.id) AS last_check_at,
      (SELECT c.defect_count FROM vdi_checks c WHERE c.vehicle_id = v.id ORDER BY c.created_at DESC LIMIT 1) AS last_check_defects,
      (SELECT COUNT(*) FROM vehicle_defects d WHERE d.vehicle_id = v.id AND d.status = 'OPEN') AS open_defects
    FROM vehicles v
    WHERE ${includeArchived} OR v.active = TRUE
    ORDER BY v.active DESC, v.call_sign NULLS LAST, v.reg
  `;
}

function normaliseReg(v: any): string | null {
  const s = String(v ?? "").toUpperCase().replace(/\s+/g, " ").trim().slice(0, 20);
  return s || null;
}
async function regTaken(reg: string, exceptId: number | null) {
  const key = reg.replace(/\s/g, "");
  const [row] = await sql`
    SELECT id FROM vehicles WHERE replace(upper(reg), ' ', '') = ${key} AND (${exceptId}::int IS NULL OR id <> ${exceptId})
  `;
  return !!row;
}

function vehicleFields(body: any) {
  return {
    reg: normaliseReg(body.reg),
    callSign: cleanText(body.callSign, 40),
    vehicleType: cleanText(body.vehicleType, 60),
    makeModel: cleanText(body.makeModel, 80),
    status: VEHICLE_STATUSES.includes(body.status) ? body.status : "AVAILABLE",
    motDue: cleanDate(body.motDue),
    serviceDue: cleanDate(body.serviceDue),
    insuranceDue: cleanDate(body.insuranceDue),
    taxDue: cleanDate(body.taxDue),
    notes: cleanText(body.notes, 2000),
  };
}

async function notifyVdiDefects(reg: string, callSign: string | null, items: string[]) {
  const emails = await getMgrAndAdminEmails();
  const label = callSign ? `${reg} (${callSign})` : reg;
  // Names of the checking crew are deliberately not included in the email.
  const list = items.map((i) => `- ${i}`).join("\n");
  await sendAlertEmail(
    emails,
    `Vehicle defect reported — ${label}`,
    `A vehicle daily inspection has reported ${items.length} defect${items.length === 1 ? "" : "s"} on ${label}:\n\n${list}\n\nPlease review it under Fleet Management in Dynamo.`,
    `<p>A vehicle daily inspection has reported ${items.length} defect${items.length === 1 ? "" : "s"} on <strong>${escapeHtml(label)}</strong>:</p>` +
      `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` +
      `<p>Please review it under Fleet Management in Dynamo.</p>`
  );
}

// Public base URL for links printed on QR codes (Railway's proxy sets the
// forwarded headers; PUBLIC_URL can override, e.g. for a custom domain).
function publicOrigin(req: Request): string {
  if (Bun.env.PUBLIC_URL) return Bun.env.PUBLIC_URL.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host}`;
}

const FLEET_QR_PAGE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/><title>Vehicle check QR codes</title><style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d1d1b; background: #f4f4f2; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 14px 16px; background: #fff; border-bottom: 1px solid #e2e1dc; position: sticky; top: 0; }
  .bar h1 { font-size: 18px; margin: 0 auto 0 0; }
  .bar label { font-size: 14px; color: #5f5f5a; display: flex; gap: 6px; align-items: center; }
  button { font: inherit; padding: 8px 14px; border-radius: 7px; border: 0; background: #b4231c; color: #fff; cursor: pointer; }
  .msg { padding: 24px 16px; max-width: 640px; }
  .sheet { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; padding: 16px; }
  .tag { background: #fff; border: 2px dashed #c9c8c2; border-radius: 10px; padding: 14px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .tag .head { background: #b4231c; color: #fff; font-weight: 700; border-radius: 6px; padding: 5px 8px; font-size: 14px; letter-spacing: .02em; }
  .tag svg { width: 100%; max-width: 200px; height: auto; display: block; margin: 10px auto 6px; }
  .tag .reg { font-size: 22px; font-weight: 800; letter-spacing: .06em; }
  .tag .sub { font-size: 13px; color: #5f5f5a; min-height: 1.2em; }
  .tag .how { font-size: 12px; color: #1d1d1b; margin-top: 6px; }
  .tag.general .head { background: #1d1d1b; }
  @media print {
    @page { size: A4; margin: 10mm; }
    body { background: #fff; }
    .bar { display: none; }
    .sheet { grid-template-columns: repeat(3, 1fr); gap: 6mm; padding: 0; }
    .tag { border-color: #999; }
    .hide-general .general { display: none; }
  }
</style></head><body>
<div class="bar">
  <h1>Vehicle check QR codes</h1>
  <label><input type="checkbox" id="incGeneral" checked/> Include general code (any vehicle)</label>
  <button onclick="window.print()">Print</button>
</div>
<div id="out" class="msg">Loading\u2026</div>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
document.getElementById("incGeneral").onchange = (e) => document.body.classList.toggle("hide-general", !e.target.checked);
(async () => {
  const out = document.getElementById("out");
  let token = null;
  try { token = localStorage.getItem("dynamo_token"); } catch {}
  if (!token) { out.innerHTML = 'Please <a href="/">sign in to Dynamo</a> as a manager, then open Fleet Management \u2192 Print QR codes again.'; return; }
  const res = await fetch("/api/fleet/qr", { headers: { Authorization: "Bearer " + token } });
  if (res.status === 401 || res.status === 403) { out.innerHTML = 'Your session has expired or you are not a manager. <a href="/">Sign in to Dynamo</a> and try again.'; return; }
  if (!res.ok) { out.textContent = "Could not load vehicles (" + res.status + ")."; return; }
  const d = await res.json();
  const tag = (head, big, sub, svg, extra) =>
    '<div class="tag' + extra + '"><div class="head">' + head + '</div>' + svg +
    '<div class="reg">' + esc(big) + '</div><div class="sub">' + esc(sub) + '</div>' +
    '<div class="how">Scan before every shift \u00b7 no login</div></div>';
  const tags = d.vehicles.map((v) => tag("VEHICLE DAILY CHECK", v.reg, [v.callSign, v.vehicleType].filter(Boolean).join(" \u00b7 "), v.svg, ""));
  tags.push(tag("VEHICLE DAILY CHECK", "Any vehicle", "Choose the vehicle on the form", d.generalSvg, " general"));
  out.className = "sheet";
  out.innerHTML = (d.vehicles.length ? "" : '<p style="grid-column:1/-1">No vehicles yet \u2014 add them in Fleet Management to get a code for each one.</p>') + tags.join("");
})().catch((e) => { document.getElementById("out").textContent = "Something went wrong: " + e.message; });
</script></body></html>`;

async function handleFleetRequest(req: Request, url: URL, path: string, method: string, ip: string): Promise<Response | null> {
  // ---- Public (no login): the crew VDI form ----
  if (path === "/api/public/vdi/setup" && method === "GET") {
    const rows = await sql`
      SELECT id, reg, call_sign FROM vehicles WHERE active = TRUE ORDER BY call_sign NULLS LAST, reg
    `;
    return json({
      vehicles: (rows as any[]).map((r) => ({ id: r.id, reg: r.reg, callSign: r.call_sign })),
      checklist: VDI_CHECKLIST,
    });
  }

  if (path === "/api/public/vdi" && method === "POST") {
    const key = `public-vdi:${ip}`;
    if (recentAttempts(key, PUBLIC_VDI_WINDOW_MS).length >= PUBLIC_VDI_MAX_PER_IP) {
      return json({ error: "Too many checks submitted from this connection. Please try again later." }, 429);
    }
    recordAttempt(key);
    const body = await req.json().catch(() => ({}));
    const vehicleId = Number(body.vehicleId);
    const checkedBy = cleanText(body.checkedBy, 120);
    if (!Number.isInteger(vehicleId) || !checkedBy) {
      return json({ error: "Please choose the vehicle and enter your name." }, 400);
    }
    const [vehicle] = await sql`SELECT id, reg, call_sign FROM vehicles WHERE id = ${vehicleId} AND active = TRUE`;
    if (!vehicle) return json({ error: "That vehicle isn't available — please choose another." }, 400);
    const mileageNum = body.mileage === "" || body.mileage === undefined || body.mileage === null ? null : Math.round(Number(body.mileage));
    if (mileageNum !== null && (!Number.isFinite(mileageNum) || mileageNum < 0 || mileageNum > 2000000)) {
      return json({ error: "Mileage doesn't look right — please check it." }, 400);
    }
    const submitted: any[] = Array.isArray(body.results) ? body.results : [];
    const byItem = new Map<string, any>();
    for (const r of submitted) if (r && typeof r.item === "string") byItem.set(r.item, r);
    const results = VDI_ITEMS.map((item) => {
      const r = byItem.get(item);
      const ok = r ? r.ok === true : null;
      return { item, ok, note: ok === false ? cleanText(r?.note, 500) : null };
    });
    const unanswered = results.filter((r) => r.ok === null).length;
    if (unanswered) return json({ error: `Please answer every item (${unanswered} left).` }, 400);
    const failed = results.filter((r) => r.ok === false);
    for (const f of failed) {
      if (!f.note) return json({ error: `Please describe the problem with "${f.item}".` }, 400);
    }
    const notes = cleanText(body.notes, 2000);
    const [check] = await sql`
      INSERT INTO vdi_checks (vehicle_id, checked_by, mileage, results, defect_count, notes)
      VALUES (${vehicleId}, ${checkedBy}, ${mileageNum}, ${JSON.stringify(results)}::text::jsonb, ${failed.length}, ${notes})
      RETURNING id, created_at
    `;
    for (const f of failed) {
      await sql`
        INSERT INTO vehicle_defects (vehicle_id, vdi_check_id, item, description, reported_by)
        VALUES (${vehicleId}, ${check.id}, ${f.item}, ${f.note}, ${checkedBy})
      `;
    }
    if (failed.length) {
      notifyVdiDefects(vehicle.reg, vehicle.call_sign, failed.map((f) => `${f.item}: ${f.note}`)).catch((err) =>
        console.log(`VDI defect notify failed for vehicle ${vehicleId}: ${err}`)
      );
    }
    return json({ id: check.id, defectCount: failed.length, vehicleReg: vehicle.reg, createdAt: check.created_at }, 201);
  }

  if (!path.startsWith("/api/fleet/")) return null;

  // ---- Managers / admins only ----
  const auth = await getAuth(req);
  if (!auth) return json({ error: "Unauthorized" }, 401);
  if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);

  if (path === "/api/fleet/qr" && method === "GET") {
    const origin = publicOrigin(req);
    const qr = (text: string) => QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    const generalUrl = `${origin}/vdi`;
    const vehicles = ((await listVehicles(false)) as any[]).map(serializeVehicle);
    return json({
      generalUrl,
      generalSvg: await qr(generalUrl),
      vehicles: await Promise.all(
        vehicles.map(async (v) => {
          const vUrl = `${origin}/vdi?reg=${encodeURIComponent(v.reg.replace(/\s+/g, ""))}`;
          return { id: v.id, reg: v.reg, callSign: v.callSign, vehicleType: v.vehicleType, url: vUrl, svg: await qr(vUrl) };
        })
      ),
    });
  }

  if (path === "/api/fleet/summary" && method === "GET") {
    const vehicles = ((await listVehicles(false)) as any[]).map(serializeVehicle);
    const today = new Date().toISOString().slice(0, 10);
    const dueKeys = ["motStatus", "serviceStatus", "insuranceStatus", "taxStatus"] as const;
    const [{ count: checksToday }] = await sql`
      SELECT COUNT(*) AS count FROM vdi_checks WHERE created_at >= ${today}::date
    `;
    return json({
      vehicles: vehicles.length,
      available: vehicles.filter((v) => v.status === "AVAILABLE").length,
      offRoad: vehicles.filter((v) => v.status !== "AVAILABLE").length,
      overdueItems: vehicles.reduce((n, v) => n + dueKeys.filter((k) => v[k] === "OVERDUE").length, 0),
      dueSoonItems: vehicles.reduce((n, v) => n + dueKeys.filter((k) => v[k] === "DUE_SOON").length, 0),
      openDefects: vehicles.reduce((n, v) => n + v.openDefects, 0),
      checksToday: Number(checksToday),
      notCheckedToday: vehicles.filter((v) => v.status === "AVAILABLE" && (!v.lastCheckAt || toDateStr(v.lastCheckAt)! < today)).length,
    });
  }

  if (path === "/api/fleet/vehicles" && method === "GET") {
    const rows = await listVehicles(url.searchParams.get("archived") === "1");
    return json((rows as any[]).map(serializeVehicle));
  }

  if (path === "/api/fleet/vehicles" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const f = vehicleFields(body);
    if (!f.reg) return json({ error: "Registration is required" }, 400);
    if (await regTaken(f.reg, null)) return json({ error: "A vehicle with that registration already exists" }, 400);
    try {
      const [row] = await sql`
        INSERT INTO vehicles (reg, call_sign, vehicle_type, make_model, status, mot_due, service_due, insurance_due, tax_due, notes)
        VALUES (${f.reg}, ${f.callSign}, ${f.vehicleType}, ${f.makeModel}, ${f.status}, ${f.motDue}, ${f.serviceDue}, ${f.insuranceDue}, ${f.taxDue}, ${f.notes})
        RETURNING *
      `;
      return json(serializeVehicle(row), 201);
    } catch (err: any) {
      if (String(err?.message || "").includes("duplicate key")) return json({ error: "A vehicle with that registration already exists" }, 400);
      throw err;
    }
  }

  const vehicleIdMatch = path.match(/^\/api\/fleet\/vehicles\/(\d+)$/);
  if (vehicleIdMatch && method === "PUT") {
    const id = Number(vehicleIdMatch[1]);
    const body = await req.json().catch(() => ({}));
    const f = vehicleFields(body);
    if (!f.reg) return json({ error: "Registration is required" }, 400);
    const active = body.active === false ? false : true;
    if (await regTaken(f.reg, id)) return json({ error: "A vehicle with that registration already exists" }, 400);
    try {
      const [row] = await sql`
        UPDATE vehicles SET reg = ${f.reg}, call_sign = ${f.callSign}, vehicle_type = ${f.vehicleType},
          make_model = ${f.makeModel}, status = ${f.status}, mot_due = ${f.motDue}, service_due = ${f.serviceDue},
          insurance_due = ${f.insuranceDue}, tax_due = ${f.taxDue}, notes = ${f.notes}, active = ${active}, updated_at = now()
        WHERE id = ${id} RETURNING *
      `;
      if (!row) return json({ error: "Not found" }, 404);
      return json(serializeVehicle(row));
    } catch (err: any) {
      if (String(err?.message || "").includes("duplicate key")) return json({ error: "A vehicle with that registration already exists" }, 400);
      throw err;
    }
  }

  if (path === "/api/fleet/checks" && method === "GET") {
    const vehicleId = url.searchParams.get("vehicleId");
    const vid = vehicleId ? Number(vehicleId) : null;
    const rows = await sql`
      SELECT c.*, v.reg AS vehicle_reg, v.call_sign FROM vdi_checks c
      JOIN vehicles v ON v.id = c.vehicle_id
      WHERE (${vid}::int IS NULL OR c.vehicle_id = ${vid})
      ORDER BY c.created_at DESC LIMIT 200
    `;
    return json((rows as any[]).map(serializeVdiCheck));
  }

  if (path === "/api/fleet/defects" && method === "GET") {
    const status = url.searchParams.get("status");
    const st = DEFECT_STATUSES.includes(status || "") ? status : null;
    const rows = await sql`
      SELECT d.*, v.reg AS vehicle_reg, v.call_sign, u.name AS resolved_by_name FROM vehicle_defects d
      JOIN vehicles v ON v.id = d.vehicle_id
      LEFT JOIN users u ON u.id = d.resolved_by
      WHERE (${st}::text IS NULL OR d.status = ${st})
      ORDER BY (d.status = 'OPEN') DESC, d.reported_at DESC LIMIT 300
    `;
    return json((rows as any[]).map(serializeDefect));
  }

  if (path === "/api/fleet/defects" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const vehicleId = Number(body.vehicleId);
    const item = cleanText(body.item, 120);
    const description = cleanText(body.description, 2000);
    if (!Number.isInteger(vehicleId) || !item) return json({ error: "Vehicle and defect are required" }, 400);
    const [v] = await sql`SELECT id FROM vehicles WHERE id = ${vehicleId}`;
    if (!v) return json({ error: "Vehicle not found" }, 404);
    const [row] = await sql`
      INSERT INTO vehicle_defects (vehicle_id, item, description, reported_by)
      VALUES (${vehicleId}, ${item}, ${description}, ${auth.name}) RETURNING id
    `;
    const [full] = await sql`
      SELECT d.*, v.reg AS vehicle_reg, v.call_sign, NULL AS resolved_by_name FROM vehicle_defects d
      JOIN vehicles v ON v.id = d.vehicle_id WHERE d.id = ${row.id}
    `;
    return json(serializeDefect(full), 201);
  }

  const defectIdMatch = path.match(/^\/api\/fleet\/defects\/(\d+)$/);
  if (defectIdMatch && method === "PUT") {
    const id = Number(defectIdMatch[1]);
    const body = await req.json().catch(() => ({}));
    const status = DEFECT_STATUSES.includes(body.status) ? body.status : null;
    if (!status) return json({ error: "Invalid status" }, 400);
    const notes = cleanText(body.resolutionNotes, 2000);
    const [row] = status === "RESOLVED"
      ? await sql`
          UPDATE vehicle_defects SET status = 'RESOLVED', resolved_at = now(), resolved_by = ${auth.sub}, resolution_notes = ${notes}
          WHERE id = ${id} RETURNING id
        `
      : await sql`
          UPDATE vehicle_defects SET status = 'OPEN', resolved_at = NULL, resolved_by = NULL, resolution_notes = NULL
          WHERE id = ${id} RETURNING id
        `;
    if (!row) return json({ error: "Not found" }, 404);
    const [full] = await sql`
      SELECT d.*, v.reg AS vehicle_reg, v.call_sign, u.name AS resolved_by_name FROM vehicle_defects d
      JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN users u ON u.id = d.resolved_by WHERE d.id = ${id}
    `;
    return json(serializeDefect(full));
  }

  return json({ error: "Not found" }, 404);
}

await ensureSchema();
await seed();

Bun.serve({
  port: Number(Bun.env.PORT) || 8080,
  // 120s: the public report form can include several photo uploads in one
  // request. Photos are now compressed client-side before upload (see
  // PublicReport.jsx), which fixed the common case, but a crew submitting
  // from a weak-signal scene can still be much slower than a desktop
  // connection, and live logs showed real submissions failing right around
  // the old 60s mark ("client has closed the request" / "connection
  // closed"). This is Bun's per-connection idle timeout, capped at 255s.
  idleTimeout: 120,
  async fetch(req, server) {
    const ip = clientIp(req, server);
    const isApi = new URL(req.url).pathname.startsWith("/api/");
    try {
      const res = await handleRequest(req, ip);
      return withSecurityHeaders(res, isApi);
    } catch (err) {
      console.log(`Unhandled error on ${req.method} ${new URL(req.url).pathname}: ${err}`);
      return withSecurityHeaders(json({ error: "Internal server error" }, 500), true);
    }
  },
});

// One-off storage maintenance, driven by environment variables so it can be
// run without calling the API: results go to the deploy logs.
async function bootMaintenance() {
  try {
    if (Bun.env.SNAPSHOT_ON_BOOT === "1") {
      const r = await snapshotDatabase();
      console.log(`DB_SNAPSHOT ${JSON.stringify(r)}`);
      await logGdpr(null, "DB_SNAPSHOT", `Database snapshot written to EU bucket (${r.key})`);
    }
    if (Bun.env.PURGE_SNAPSHOTS === "1") {
      const page: any = await s3.list({ prefix: "backups/", maxKeys: 1000 });
      let n = 0;
      for (const o of page.contents || []) { await s3.file(o.key).delete(); n++; }
      console.log(`PURGE_SNAPSHOTS deleted=${n}`);
      if (n) await logGdpr(null, "DB_SNAPSHOT_DELETED", `${n} temporary database snapshot(s) deleted`);
    }
    if (legacyS3) {
      const r = await migrateBucket();
      console.log(`STORAGE_MIGRATION ${JSON.stringify(r)}`);
      await logGdpr(null, "STORAGE_MIGRATION", `File copy to EU bucket: ${JSON.stringify({ ...r, failures: undefined })}`);
    }
  } catch (err) {
    console.log(`BOOT_MAINTENANCE_ERROR ${err}`);
  }
}
setTimeout(() => { bootMaintenance(); }, 2000);

async function handleRequest(req: Request, ip: string): Promise<Response> {
  {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/health") return json({ ok: true });

    if (path === "/privacy" && method === "GET") {
      return new Response(await renderPrivacyPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/fleet/qr" && method === "GET") {
      return new Response(FLEET_QR_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (path === "/gdpr" && method === "GET") {
      return new Response(GDPR_ADMIN_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const gdprResponse = await handleGdprRequest(req, url, path, method);
    if (gdprResponse) return gdprResponse;
    const fleetResponse = await handleFleetRequest(req, url, path, method, ip);
    if (fleetResponse) return fleetResponse;

    if (path === "/api/auth/login" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const emailKey = String(body.email || "").trim().toLowerCase();
      const ipKey = `login-ip:${ip}`;
      const userKey = `login-email:${emailKey}`;
      if (
        recentAttempts(userKey, LOGIN_WINDOW_MS).length >= LOGIN_MAX_PER_EMAIL ||
        recentAttempts(ipKey, LOGIN_WINDOW_MS).length >= LOGIN_MAX_PER_IP
      ) {
        return json({ error: "Too many failed sign-in attempts. Please wait 15 minutes and try again." }, 429);
      }
      const [user] = await sql`SELECT * FROM users WHERE lower(email) = ${emailKey} AND active = TRUE`;
      const ok = user ? await bcrypt.compare(String(body.password || ""), user.password_hash) : false;
      if (!user || !ok) {
        recordAttempt(userKey);
        recordAttempt(ipKey);
        console.log(`Failed login attempt from ${ip}`);
        return json({ error: "Invalid email or password" }, 401);
      }
      attemptBuckets.delete(userKey);
      // This site is restricted to managers and admins.
      if (!isMgrOrAdmin(user)) return json({ error: "Access to this site is restricted to managers." }, 403);
      const token = signToken(user);
      return json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }

    if (path === "/api/auth/me" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const [user] = await sql`SELECT id, name, email, phone, role FROM users WHERE id = ${auth.sub}`;
      if (!user) return json({ error: "Unauthorized" }, 401);
      return json(user);
    }

    if (path === "/api/me" && method === "PUT") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const body = await req.json();
      if (body.newPassword) {
        const [current] = await sql`SELECT * FROM users WHERE id = ${auth.sub}`;
        if (!current) return json({ error: "Not found" }, 404);
        const ok = await bcrypt.compare(body.currentPassword || "", current.password_hash);
        if (!ok) return json({ error: "Current password is incorrect" }, 400);
        const hash = await bcrypt.hash(body.newPassword, 10);
        await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${auth.sub}`;
      }
      try {
        const [row] = await sql`
          UPDATE users SET name = ${body.name}, email = ${body.email}, phone = ${body.phone || null}
          WHERE id = ${auth.sub} RETURNING id, name, email, phone, role
        `;
        if (!row) return json({ error: "Not found" }, 404);
        return json(row);
      } catch (err: any) {
        if (String(err?.message || "").includes("duplicate key")) {
          return json({ error: "That email is already in use" }, 400);
        }
        throw err;
      }
    }

    if (path === "/api/staff" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const rows = await sql`SELECT id, name, email, phone, role, active FROM users ORDER BY name`;
      return json(rows.map(serializeStaff));
    }

    if (path === "/api/staff" && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const hash = await bcrypt.hash(body.password || "Password123!", 10);
      try {
        const [row] = await sql`
          INSERT INTO users (name, email, password_hash, phone, role, active)
          VALUES (${body.name}, ${body.email}, ${hash}, ${body.phone || null}, ${body.role === "ADMIN" ? "ADMIN" : "MANAGER"}, ${body.active !== undefined ? body.active : true})
          RETURNING id, name, email, phone, role, active
        `;
        return json(row, 201);
      } catch (err: any) {
        if (String(err?.message || "").includes("duplicate key")) {
          return json({ error: "That email is already in use" }, 400);
        }
        throw err;
      }
    }

    if (path === "/api/staff/reset-password" && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const userIds: number[] = Array.isArray(body.userIds) ? body.userIds.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n)) : [];
      if (userIds.length === 0) return json({ error: "Select at least one staff member" }, 400);
      const results: { id: number; name: string; email: string; tempPassword: string }[] = [];
      for (const id of userIds) {
        const [row] = await sql`SELECT id, name, email FROM users WHERE id = ${id}`;
        if (!row) continue;
        const tempPassword = genTempPassword();
        const hash = await bcrypt.hash(tempPassword, 10);
        await sql`UPDATE users SET password_hash = ${hash}, tokens_valid_after = now() WHERE id = ${id}`;
        results.push({ id: row.id, name: row.name, email: row.email, tempPassword });
      }
      return json({ results });
    }

    const staffIdMatch = path.match(/^\/api\/staff\/(\d+)$/);
    if (staffIdMatch && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(staffIdMatch[1]);
      const [row] = await sql`SELECT id, name, email, phone, role, active FROM users WHERE id = ${id}`;
      if (!row) return json({ error: "Not found" }, 404);
      return json(serializeStaff(row));
    }

    if (staffIdMatch && method === "PUT") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(staffIdMatch[1]);
      const body = await req.json();
      if (body.password) {
        const hash = await bcrypt.hash(body.password, 10);
        await sql`UPDATE users SET password_hash = ${hash}, tokens_valid_after = now() WHERE id = ${id}`;
      }
      if (body.active === false) {
        // Deactivated accounts lose access immediately; the retention clock
        // for leavers starts from the first deactivation.
        await sql`UPDATE users SET tokens_valid_after = now(), deactivated_at = COALESCE(deactivated_at, now()) WHERE id = ${id}`;
      } else if (body.active === true || body.active === undefined) {
        await sql`UPDATE users SET deactivated_at = NULL WHERE id = ${id}`;
      }
      const [row] = await sql`
        UPDATE users SET name = ${body.name}, phone = ${body.phone || null},
          role = ${body.role === "ADMIN" ? "ADMIN" : "MANAGER"}, active = ${body.active !== undefined ? body.active : true}
        WHERE id = ${id} RETURNING id, name, email, phone, role, active
      `;
      if (!row) return json({ error: "Not found" }, 404);
      return json(serializeStaff(row));
    }

    if (staffIdMatch && method === "DELETE") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(staffIdMatch[1]);
      if (id === auth.sub) return json({ error: "You cannot delete your own account" }, 400);
      await sql`DELETE FROM users WHERE id = ${id}`;
      return new Response(null, { status: 204 });
    }

    if (path === "/api/incidents" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (isMgrOrAdmin(auth)) {
        // Fire-and-forget: never blocks the list from loading.
        escalateBreachedIncidents().catch((err) => console.log(`Escalation sweep failed: ${err}`));
        maybeRunRetention().catch((err) => console.log(`Retention run failed: ${err}`));
      }
      const rows =
        isMgrOrAdmin(auth)
          ? await sql`
              SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
              LEFT JOIN users u ON u.id = i.reported_by
              LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
              ORDER BY i.created_at DESC
            `
          : await sql`
              SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
              LEFT JOIN users u ON u.id = i.reported_by
              LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
              WHERE i.reported_by = ${auth.sub}
              ORDER BY i.created_at DESC
            `;
      const daysToRespond = await getDaysToRespond();
      const hoursToAllocate = await getHoursToAllocate();
      return json(rows.map((r: any) => serializeIncident(r, daysToRespond, hoursToAllocate)));
    }

    if (path === "/api/public/incidents" && method === "POST") {
      const reportKey = `public-report:${ip}`;
      if (recentAttempts(reportKey, PUBLIC_REPORT_WINDOW_MS).length >= PUBLIC_REPORT_MAX_PER_IP) {
        return json({ error: "Too many reports submitted from this connection. Please try again later." }, 429);
      }
      recordAttempt(reportKey);
      // No authentication required: this is the QR-code / public incident
      // report form. Anyone with the link can submit a report.
      // The form sends multipart/form-data when photos are attached (so it
      // can carry files alongside the fields), and plain JSON otherwise.
      const contentType = req.headers.get("content-type") || "";
      const isMultipart = contentType.includes("multipart/form-data");
      let body: any;
      let photoFiles: File[] = [];
      if (isMultipart) {
        const form = await req.formData();
        body = {};
        for (const [key, value] of form.entries()) {
          if (key === "photos") continue;
          if (typeof value === "string") body[key] = value;
        }
        if (typeof body.anonymous === "string") body.anonymous = body.anonymous === "true";
        if (typeof body.onCallManagerInformed === "string") {
          body.onCallManagerInformed = body.onCallManagerInformed === "true";
        }
        photoFiles = form.getAll("photos").filter((v): v is File => typeof v !== "string" && v.size > 0);
        const MAX_PHOTOS = 6;
        const MAX_PHOTO_SIZE = 20 * 1024 * 1024;
        if (photoFiles.length > MAX_PHOTOS) {
          return json({ error: `Too many photos — up to ${MAX_PHOTOS} are allowed` }, 400);
        }
        for (const f of photoFiles) {
          if (f.size > MAX_PHOTO_SIZE) {
            return json({ error: `"${f.name}" is too large (20MB max per photo)` }, 400);
          }
        }
      } else {
        body = await req.json();
      }
      if (!body.occurredAt || !body.description) {
        return json({ error: "Date of incident and description are required" }, 400);
      }
      if (!String(body.notifiedBy || "").trim() || !String(body.vehicleReg || "").trim() || !String(body.callSign || "").trim()) {
        return json({ error: "Name of person reporting, vehicle registration and call sign are required" }, 400);
      }
      const ref = await nextIncidentRef();
      const category = INCIDENT_CATEGORIES.includes(body.category) ? body.category : null;
      // The public QR form has no severity picker — this endpoint has no
      // login, so a reporter-chosen severity can't be trusted. Severity is
      // set properly once an admin reviews the report (see IncidentDetailModal.jsx).
      const severity = "LOW";
      // Anonymous reporting is only offered for near-miss reports (see
      // PublicReport.jsx) — encourages reporting without fear of it being
      // tied to an individual. When set, we never store the reporter's
      // email even if one was somehow submitted.
      const isAnonymous = category === "NEAR_MISS" && body.anonymous === true;
      const reporterEmail = isAnonymous ? null : body.reporterEmail || null;
      const [row] = await sql`
        INSERT INTO incidents (
          ref, reported_by, occurred_at, location, severity, category, description, status,
          cad_ref, call_sign, crew_names, notified_by, vehicle_reg, reporter_email,
          on_call_manager_informed, on_call_manager_name, on_call_manager_called_at, is_anonymous
        )
        VALUES (
          ${ref}, NULL, ${body.occurredAt}, ${body.location || null}, ${severity}, ${category}, ${body.description}, 'OPEN',
          ${body.cadRef || null}, ${body.callSign || null}, ${body.crewNames || null}, ${body.notifiedBy || null},
          ${body.vehicleReg || null}, ${reporterEmail},
          ${body.onCallManagerInformed === true}, ${body.onCallManagerName || null}, ${body.onCallManagerCalledAt || null}, ${isAnonymous}
        )
        RETURNING id
      `;
      await logIncidentAudit(
        row.id,
        null,
        "CREATED",
        isAnonymous
          ? `Incident ${ref} submitted anonymously via public QR report form`
          : `Incident ${ref} submitted via public QR report form${reporterEmail ? ` by ${reporterEmail}` : ""}`
      );
      for (const file of photoFiles) {
        const key = `incidents/${row.id}/${Date.now()}-${sanitizeFileName(file.name)}`;
        const buf = await file.arrayBuffer();
        await s3.file(key).write(buf, { type: file.type || "application/octet-stream" });
        await sql`
          INSERT INTO incident_attachments (incident_id, kind, file_key, file_name, content_type, file_size, uploaded_by)
          VALUES (${row.id}, 'PHOTO', ${key}, ${file.name}, ${file.type || null}, ${file.size}, NULL)
        `;
      }
      if (photoFiles.length) {
        await logIncidentAudit(
          row.id,
          null,
          "ATTACHMENT_ADDED",
          `${photoFiles.length} photo${photoFiles.length === 1 ? "" : "s"} attached via public QR report form`
        );
      }
      if (reporterEmail) {
        // Don't block the response on the email provider; log any failure.
        sendIncidentAckEmail(reporterEmail, ref, body.occurredAt);
      }
      const daysToRespond = await getDaysToRespond();
      const hoursToAllocate = await getHoursToAllocate();
      const [full] = await sql`
        SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
        LEFT JOIN users u ON u.id = i.reported_by
        LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
        WHERE i.id = ${row.id}
      `;
      return json(serializeIncident(full, daysToRespond, hoursToAllocate), 201);
    }

    if (path === "/api/incidents" && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const ref = await nextIncidentRef();
      const category = INCIDENT_CATEGORIES.includes(body.category) ? body.category : null;
      const [row] = await sql`
        INSERT INTO incidents (
          ref, reported_by, occurred_at, location, severity, category, description, people_involved, status,
          cad_ref, call_sign, crew_names, notified_by, responsible_manager_id,
          on_call_manager_informed, on_call_manager_name, on_call_manager_called_at
        )
        VALUES (
          ${ref}, ${auth.sub}, ${body.occurredAt}, ${body.location || null}, ${body.severity || "LOW"}, ${category}, ${body.description}, ${body.peopleInvolved || null}, 'OPEN',
          ${body.cadRef || null}, ${body.callSign || null}, ${body.crewNames || null}, ${body.notifiedBy || null}, ${body.responsibleManagerId || null},
          ${body.onCallManagerInformed === true}, ${body.onCallManagerName || null}, ${body.onCallManagerCalledAt || null}
        )
        RETURNING id
      `;
      await logIncidentAudit(row.id, auth, "CREATED", `Incident ${ref} reported by ${auth.name}`);
      if (body.severity === "HIGH" || body.severity === "CRITICAL") {
        // Fire-and-forget: never blocks the response.
        notifyHighSeverityIncident(ref, category, body.location || null, body.description || "").catch((err) =>
          console.log(`High-severity notify failed for ${ref}: ${err}`)
        );
      }
      const [full] = await sql`
        SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
        LEFT JOIN users u ON u.id = i.reported_by
        LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
        WHERE i.id = ${row.id}
      `;
      const daysToRespond = await getDaysToRespond();
      const hoursToAllocate = await getHoursToAllocate();
      return json(serializeIncident(full, daysToRespond, hoursToAllocate), 201);
    }

    const incidentIdMatch = path.match(/^\/api\/incidents\/(\d+)$/);
    if (incidentIdMatch && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(incidentIdMatch[1]);
      const [row] = await sql`
        SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
        LEFT JOIN users u ON u.id = i.reported_by
        LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
        WHERE i.id = ${id}
      `;
      if (!row) return json({ error: "Not found" }, 404);
      if (!isMgrOrAdmin(auth) && row.reported_by !== auth.sub) return json({ error: "Forbidden" }, 403);
      const daysToRespond = await getDaysToRespond();
      const hoursToAllocate = await getHoursToAllocate();
      const attachments = await sql`
        SELECT ia.*, u.name AS uploaded_by_name FROM incident_attachments ia
        LEFT JOIN users u ON u.id = ia.uploaded_by
        WHERE ia.incident_id = ${id} ORDER BY ia.created_at DESC
      `;
      return json({
        ...serializeIncident(row, daysToRespond, hoursToAllocate),
        attachments: attachments.map(serializeIncidentAttachment),
      });
    }

    if (incidentIdMatch && method === "PUT") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(incidentIdMatch[1]);
      const body = await req.json();
      const [before] = await sql`
        SELECT i.*, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
        LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
        WHERE i.id = ${id}
      `;
      if (!before) return json({ error: "Not found" }, 404);
      if (before.status === "CLOSED") {
        return json({ error: "This incident is closed and is now read-only." }, 403);
      }
      if (body.relatedIncidentId && Number(body.relatedIncidentId) === id) {
        return json({ error: "An incident cannot be related to itself" }, 400);
      }
      const severity = INCIDENT_SEVERITIES.includes(body.severity) ? body.severity : before.severity;
      await sql`
        UPDATE incidents SET
          status = ${body.status},
          severity = ${severity},
          likelihood = ${body.likelihood || null},
          impact = ${body.impact || null},
          admin_notes = ${body.adminNotes || null},
          cad_ref = ${body.cadRef || null},
          call_sign = ${body.callSign || null},
          crew_names = ${body.crewNames || null},
          notified_by = ${body.notifiedBy || null},
          date_sent_to_manager = ${body.dateSentToManager || null},
          info_request_by = ${body.infoRequestBy || null},
          completed_response_date = ${body.completedResponseDate || null},
          outcome = ${body.outcome || null},
          recommendations = ${body.recommendations || null},
          lessons_learnt = ${body.lessonsLearnt || null},
          signature_name = ${body.signatureName || null},
          investigator_name = ${body.investigatorName || null},
          designation = ${body.designation || null},
          sign_off_date = ${body.signOffDate || null},
          responsible_manager_id = ${body.responsibleManagerId || null},
          on_call_manager_informed = ${body.onCallManagerInformed === true},
          on_call_manager_name = ${body.onCallManagerName || null},
          on_call_manager_called_at = ${body.onCallManagerCalledAt || null},
          riddor_reportable = ${body.riddorReportable === true},
          cqc_notifiable = ${body.cqcNotifiable === true},
          related_incident_id = ${body.relatedIncidentId || null}
        WHERE id = ${id}
      `;
      const [full] = await sql`
        SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
        LEFT JOIN users u ON u.id = i.reported_by
        LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
        WHERE i.id = ${id}
      `;
      if (!full) return json({ error: "Not found" }, 404);
      if (before.status !== full.status) {
        await logIncidentAudit(id, auth, "STATUS_CHANGED", `${before.status} → ${full.status} (by ${auth.name})`);
      }
      if (before.severity !== full.severity) {
        await logIncidentAudit(id, auth, "SEVERITY_CHANGED", `${before.severity} → ${full.severity} (by ${auth.name})`);
      }
      if ((before.responsible_manager_id || null) !== (full.responsible_manager_id || null)) {
        await logIncidentAudit(
          id,
          auth,
          "MANAGER_ASSIGNED",
          full.responsible_manager_name
            ? `Responsible manager set to ${full.responsible_manager_name} (by ${auth.name})`
            : `Responsible manager cleared (by ${auth.name})`
        );
      }
      await logIncidentAudit(id, auth, "UPDATED", `Investigation details updated by ${auth.name}`);
      const daysToRespond = await getDaysToRespond();
      const hoursToAllocate = await getHoursToAllocate();
      return json(serializeIncident(full, daysToRespond, hoursToAllocate));
    }

    if (path === "/api/incidents/export-summary" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const rows = await sql`
        SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
        LEFT JOIN users u ON u.id = i.reported_by
        LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
        WHERE (${from}::date IS NULL OR i.occurred_at >= ${from}::date)
          AND (${to}::date IS NULL OR i.occurred_at < (${to}::date + INTERVAL '1 day'))
        ORDER BY i.occurred_at DESC
      `;
      const daysToRespond = await getDaysToRespond();
      const hoursToAllocate = await getHoursToAllocate();
      const incidents = rows.map((r: any) => serializeIncident(r, daysToRespond, hoursToAllocate));
      const buf = await buildIncidentSummaryDocx(incidents, { from, to });
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="Incident-Summary-${new Date().toISOString().slice(0, 10)}.docx"`,
        },
      });
    }

    const incidentExportMatch = path.match(/^\/api\/incidents\/(\d+)\/export$/);
    if (incidentExportMatch && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(incidentExportMatch[1]);
      const [row] = await sql`
        SELECT i.*, u.name AS reporter_name, m.name AS responsible_manager_name, rel.ref AS related_incident_ref FROM incidents i
        LEFT JOIN users u ON u.id = i.reported_by
        LEFT JOIN users m ON m.id = i.responsible_manager_id
        LEFT JOIN incidents rel ON rel.id = i.related_incident_id
        WHERE i.id = ${id}
      `;
      if (!row) return json({ error: "Not found" }, 404);
      if (!isMgrOrAdmin(auth) && row.reported_by !== auth.sub) return json({ error: "Forbidden" }, 403);
      const daysToRespond = await getDaysToRespond();
      const hoursToAllocate = await getHoursToAllocate();
      const incident = serializeIncident(row, daysToRespond, hoursToAllocate);
      const auditRows = await sql`
        SELECT * FROM incident_audit_log WHERE incident_id = ${id} ORDER BY created_at ASC
      `;
      incident.auditTrail = auditRows.map(serializeIncidentAuditEntry);

      // Pull in the photo attachments so they're visible directly in the
      // exported report, not just listed by filename.
      const attachmentRows = await sql`
        SELECT * FROM incident_attachments WHERE incident_id = ${id} AND kind = 'PHOTO' ORDER BY created_at ASC
      `;
      const photos: EmbeddablePhoto[] = [];
      let skippedPhotoCount = 0;
      for (const a of attachmentRows as any[]) {
        const type = docxImageType(a.content_type);
        if (!type) {
          skippedPhotoCount++;
          continue;
        }
        try {
          const arrayBuf = await storageRead(a.file_key);
          const bytes = new Uint8Array(arrayBuf);
          let width = 0;
          let height = 0;
          try {
            const dims = imageSize(bytes);
            width = dims.width || 0;
            height = dims.height || 0;
          } catch (dimErr) {
            console.log(`Could not read dimensions for ${a.file_key}: ${dimErr}`);
          }
          photos.push({ fileName: a.file_name, type, bytes, width, height });
        } catch (err) {
          console.log(`Failed to load photo ${a.file_key} for export: ${err}`);
          skippedPhotoCount++;
        }
      }

      await logIncidentAudit(id, auth, "EXPORTED", `Word document exported by ${auth.name}`);
      const buf = await buildIncidentDocx(incident, photos, skippedPhotoCount);
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${String(incident.ref).replace(/[\\/]/g, "-")}.docx"`,
        },
      });
    }

    const incidentAuditMatch = path.match(/^\/api\/incidents\/(\d+)\/audit$/);
    if (incidentAuditMatch && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(incidentAuditMatch[1]);
      const [row] = await sql`SELECT reported_by FROM incidents WHERE id = ${id}`;
      if (!row) return json({ error: "Not found" }, 404);
      if (!isMgrOrAdmin(auth) && row.reported_by !== auth.sub) return json({ error: "Forbidden" }, 403);
      const auditRows = await sql`
        SELECT * FROM incident_audit_log WHERE incident_id = ${id} ORDER BY created_at ASC
      `;
      return json(auditRows.map(serializeIncidentAuditEntry));
    }

    const incidentAttachmentsMatch = path.match(/^\/api\/incidents\/(\d+)\/attachments$/);
    if (incidentAttachmentsMatch && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(incidentAttachmentsMatch[1]);
      const [incident] = await sql`SELECT * FROM incidents WHERE id = ${id}`;
      if (!incident) return json({ error: "Not found" }, 404);
      if (!isMgrOrAdmin(auth) && incident.reported_by !== auth.sub) return json({ error: "Forbidden" }, 403);
      if (incident.status === "CLOSED") {
        return json({ error: "This incident is closed and is now read-only." }, 403);
      }
      const form = await req.formData();
      const kind = form.get("kind") === "STATEMENT" ? "STATEMENT" : "PHOTO";
      const file = form.get("file");
      if (!file || typeof file === "string") return json({ error: "File is required" }, 400);
      if (file.size > 20 * 1024 * 1024) return json({ error: "File is too large (20MB max)" }, 400);
      const key = `incidents/${id}/${Date.now()}-${sanitizeFileName(file.name)}`;
      const buf = await file.arrayBuffer();
      await s3.file(key).write(buf, { type: file.type || "application/octet-stream" });
      const [row] = await sql`
        INSERT INTO incident_attachments (incident_id, kind, file_key, file_name, content_type, file_size, uploaded_by)
        VALUES (${id}, ${kind}, ${key}, ${file.name}, ${file.type || null}, ${file.size}, ${auth.sub})
        RETURNING id
      `;
      const [full] = await sql`
        SELECT ia.*, u.name AS uploaded_by_name FROM incident_attachments ia
        LEFT JOIN users u ON u.id = ia.uploaded_by WHERE ia.id = ${row.id}
      `;
      return json(serializeIncidentAttachment(full), 201);
    }

    const incidentAttachmentDownloadMatch = path.match(/^\/api\/incidents\/(\d+)\/attachments\/(\d+)\/download$/);
    if (incidentAttachmentDownloadMatch && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(incidentAttachmentDownloadMatch[1]);
      const attachmentId = Number(incidentAttachmentDownloadMatch[2]);
      const [incident] = await sql`SELECT * FROM incidents WHERE id = ${id}`;
      if (!incident) return json({ error: "Not found" }, 404);
      if (!isMgrOrAdmin(auth) && incident.reported_by !== auth.sub) return json({ error: "Forbidden" }, 403);
      const [attachment] = await sql`SELECT * FROM incident_attachments WHERE id = ${attachmentId} AND incident_id = ${id}`;
      if (!attachment) return json({ error: "Not found" }, 404);
      const downloadUrl = await storagePresign(attachment.file_key);
      return json({ url: downloadUrl, fileName: attachment.file_name });
    }

    const incidentAttachmentRenameMatch = path.match(/^\/api\/incidents\/(\d+)\/attachments\/(\d+)$/);
    if (incidentAttachmentRenameMatch && method === "PATCH") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(incidentAttachmentRenameMatch[1]);
      const attachmentId = Number(incidentAttachmentRenameMatch[2]);
      const [incident] = await sql`SELECT * FROM incidents WHERE id = ${id}`;
      if (!incident) return json({ error: "Not found" }, 404);
      if (!isMgrOrAdmin(auth) && incident.reported_by !== auth.sub) return json({ error: "Forbidden" }, 403);
      if (incident.status === "CLOSED") {
        return json({ error: "This incident is closed and is now read-only." }, 403);
      }
      const [attachment] = await sql`SELECT * FROM incident_attachments WHERE id = ${attachmentId} AND incident_id = ${id}`;
      if (!attachment) return json({ error: "Not found" }, 404);
      const body = await req.json().catch(() => ({}));
      const requestedName = String(body?.fileName || "").trim();
      if (!requestedName) return json({ error: "File name is required" }, 400);
      if (requestedName.length > 180) return json({ error: "File name is too long" }, 400);
      // Preserve the original extension if the new name doesn't supply one,
      // so the file still opens correctly after renaming.
      const originalExt = (attachment.file_name.match(/\.[^.]+$/) || [""])[0];
      const hasExt = /\.[^./\\]+$/.test(requestedName);
      const finalName = (hasExt ? requestedName : requestedName + originalExt).slice(0, 180);
      const [updated] = await sql`
        UPDATE incident_attachments SET file_name = ${finalName} WHERE id = ${attachmentId} AND incident_id = ${id}
        RETURNING id
      `;
      if (!updated) return json({ error: "Not found" }, 404);
      const [full] = await sql`
        SELECT ia.*, u.name AS uploaded_by_name FROM incident_attachments ia
        LEFT JOIN users u ON u.id = ia.uploaded_by WHERE ia.id = ${attachmentId}
      `;
      return json(serializeIncidentAttachment(full));
    }

    // ---- Corrective actions (CAPA) ----
    const incidentActionsMatch = path.match(/^\/api\/incidents\/(\d+)\/actions$/);
    if (incidentActionsMatch && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(incidentActionsMatch[1]);
      const [incident] = await sql`SELECT reported_by FROM incidents WHERE id = ${id}`;
      if (!incident) return json({ error: "Not found" }, 404);
      if (!isMgrOrAdmin(auth) && incident.reported_by !== auth.sub) return json({ error: "Forbidden" }, 403);
      const rows = await sql`
        SELECT ca.*, i.ref AS incident_ref, o.name AS owner_name, c.name AS created_by_name
        FROM corrective_actions ca
        JOIN incidents i ON i.id = ca.incident_id
        LEFT JOIN users o ON o.id = ca.owner_id
        LEFT JOIN users c ON c.id = ca.created_by
        WHERE ca.incident_id = ${id} ORDER BY ca.created_at DESC
      `;
      return json(rows.map(serializeCorrectiveAction));
    }

    if (incidentActionsMatch && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(incidentActionsMatch[1]);
      const [incident] = await sql`SELECT * FROM incidents WHERE id = ${id}`;
      if (!incident) return json({ error: "Not found" }, 404);
      const body = await req.json();
      if (!body.description) return json({ error: "Description is required" }, 400);
      const [row] = await sql`
        INSERT INTO corrective_actions (incident_id, description, owner_id, due_date, created_by)
        VALUES (${id}, ${body.description}, ${body.ownerId || null}, ${body.dueDate || null}, ${auth.sub})
        RETURNING id
      `;
      await logIncidentAudit(id, auth, "ACTION_ADDED", `Corrective action added by ${auth.name}: ${body.description}`);
      const [full] = await sql`
        SELECT ca.*, i.ref AS incident_ref, o.name AS owner_name, c.name AS created_by_name
        FROM corrective_actions ca
        JOIN incidents i ON i.id = ca.incident_id
        LEFT JOIN users o ON o.id = ca.owner_id
        LEFT JOIN users c ON c.id = ca.created_by
        WHERE ca.id = ${row.id}
      `;
      return json(serializeCorrectiveAction(full), 201);
    }

    if (path === "/api/actions" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const overdueOnly = url.searchParams.get("overdue") === "1";
      const rows = overdueOnly
        ? await sql`
            SELECT ca.*, i.ref AS incident_ref, o.name AS owner_name, c.name AS created_by_name
            FROM corrective_actions ca
            JOIN incidents i ON i.id = ca.incident_id
            LEFT JOIN users o ON o.id = ca.owner_id
            LEFT JOIN users c ON c.id = ca.created_by
            WHERE ca.status <> 'DONE' AND ca.due_date IS NOT NULL AND ca.due_date < CURRENT_DATE
            ORDER BY ca.due_date ASC
          `
        : await sql`
            SELECT ca.*, i.ref AS incident_ref, o.name AS owner_name, c.name AS created_by_name
            FROM corrective_actions ca
            JOIN incidents i ON i.id = ca.incident_id
            LEFT JOIN users o ON o.id = ca.owner_id
            LEFT JOIN users c ON c.id = ca.created_by
            WHERE ca.status <> 'DONE'
            ORDER BY ca.due_date ASC NULLS LAST, ca.created_at DESC
          `;
      return json(rows.map(serializeCorrectiveAction));
    }

    const actionIdMatch = path.match(/^\/api\/actions\/(\d+)$/);
    if (actionIdMatch && method === "PUT") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(actionIdMatch[1]);
      const [before] = await sql`SELECT * FROM corrective_actions WHERE id = ${id}`;
      if (!before) return json({ error: "Not found" }, 404);
      const body = await req.json();
      const status = ["OPEN", "IN_PROGRESS", "DONE"].includes(body.status) ? body.status : before.status;
      // Dates/timestamps come back from postgres as JS Date objects; re-interpolating
      // a Date directly into a template produces its locale toString() (e.g.
      // "Mon Sep 28 2026 00:00:00 GMT+0000 (...)") rather than an ISO value, which
      // postgres then rejects as invalid input. Normalize before reusing.
      const toDateStr = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
      const toTimestamp = (d: any) => (d instanceof Date ? d.toISOString() : d);
      const existingDueDate = toDateStr(before.due_date);
      const existingCompletedAt = toTimestamp(before.completed_at);
      await sql`
        UPDATE corrective_actions SET
          description = ${body.description ?? before.description},
          owner_id = ${body.ownerId !== undefined ? body.ownerId || null : before.owner_id},
          due_date = ${body.dueDate !== undefined ? body.dueDate || null : existingDueDate},
          status = ${status},
          completed_at = ${status === "DONE" ? (existingCompletedAt || sql`now()`) : null}
        WHERE id = ${id}
      `;
      if (before.status !== status) {
        await logIncidentAudit(before.incident_id, auth, "ACTION_STATUS_CHANGED", `${before.status} → ${status} (by ${auth.name})`);
      }
      const [full] = await sql`
        SELECT ca.*, i.ref AS incident_ref, o.name AS owner_name, c.name AS created_by_name
        FROM corrective_actions ca
        JOIN incidents i ON i.id = ca.incident_id
        LEFT JOIN users o ON o.id = ca.owner_id
        LEFT JOIN users c ON c.id = ca.created_by
        WHERE ca.id = ${id}
      `;
      return json(serializeCorrectiveAction(full));
    }

    if (actionIdMatch && method === "DELETE") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(actionIdMatch[1]);
      await sql`DELETE FROM corrective_actions WHERE id = ${id}`;
      return new Response(null, { status: 204 });
    }

    // ---- Safety alerts / staff acknowledgement ----
    if (path === "/api/safety-alerts" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const rows = isMgrOrAdmin(auth)
        ? await sql`
            SELECT sa.*, i.ref AS incident_ref, c.name AS created_by_name,
              (SELECT COUNT(*) FROM safety_alert_acks WHERE alert_id = sa.id) AS ack_count,
              (SELECT COUNT(*) FROM users WHERE active = TRUE) AS staff_count,
              EXISTS(SELECT 1 FROM safety_alert_acks WHERE alert_id = sa.id AND user_id = ${auth.sub}) AS acknowledged
            FROM safety_alerts sa
            LEFT JOIN incidents i ON i.id = sa.incident_id
            LEFT JOIN users c ON c.id = sa.created_by
            WHERE sa.active = TRUE
            ORDER BY sa.created_at DESC
          `
        : await sql`
            SELECT sa.*, i.ref AS incident_ref, c.name AS created_by_name,
              EXISTS(SELECT 1 FROM safety_alert_acks WHERE alert_id = sa.id AND user_id = ${auth.sub}) AS acknowledged
            FROM safety_alerts sa
            LEFT JOIN incidents i ON i.id = sa.incident_id
            LEFT JOIN users c ON c.id = sa.created_by
            WHERE sa.active = TRUE
            ORDER BY sa.created_at DESC
          `;
      return json(rows.map(serializeSafetyAlert));
    }

    if (path === "/api/safety-alerts" && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      if (!body.title || !body.body) return json({ error: "Title and body are required" }, 400);
      const [row] = await sql`
        INSERT INTO safety_alerts (incident_id, title, body, created_by)
        VALUES (${body.incidentId || null}, ${body.title}, ${body.body}, ${auth.sub})
        RETURNING id
      `;
      if (body.incidentId) {
        await logIncidentAudit(body.incidentId, auth, "SAFETY_ALERT_CREATED", `Safety alert "${body.title}" raised by ${auth.name}`);
      }
      const [full] = await sql`
        SELECT sa.*, i.ref AS incident_ref, c.name AS created_by_name
        FROM safety_alerts sa
        LEFT JOIN incidents i ON i.id = sa.incident_id
        LEFT JOIN users c ON c.id = sa.created_by
        WHERE sa.id = ${row.id}
      `;
      return json(serializeSafetyAlert(full), 201);
    }

    const safetyAlertAckMatch = path.match(/^\/api\/safety-alerts\/(\d+)\/ack$/);
    if (safetyAlertAckMatch && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      const id = Number(safetyAlertAckMatch[1]);
      const [alert] = await sql`SELECT id FROM safety_alerts WHERE id = ${id}`;
      if (!alert) return json({ error: "Not found" }, 404);
      await sql`
        INSERT INTO safety_alert_acks (alert_id, user_id) VALUES (${id}, ${auth.sub})
        ON CONFLICT (alert_id, user_id) DO NOTHING
      `;
      return json({ acknowledged: true });
    }

    const safetyAlertAcksMatch = path.match(/^\/api\/safety-alerts\/(\d+)\/acks$/);
    if (safetyAlertAcksMatch && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(safetyAlertAcksMatch[1]);
      const rows = await sql`
        SELECT u.id, u.name, u.email, a.acknowledged_at
        FROM users u
        LEFT JOIN safety_alert_acks a ON a.user_id = u.id AND a.alert_id = ${id}
        WHERE u.active = TRUE
        ORDER BY (a.acknowledged_at IS NULL) ASC, u.name ASC
      `;
      return json(
        rows.map((r: any) => ({ id: r.id, name: r.name, email: r.email, acknowledgedAt: r.acknowledged_at }))
      );
    }

    const safetyAlertIdMatch = path.match(/^\/api\/safety-alerts\/(\d+)$/);
    if (safetyAlertIdMatch && method === "PUT") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const id = Number(safetyAlertIdMatch[1]);
      const body = await req.json();
      const [row] = await sql`
        UPDATE safety_alerts SET active = ${body.active !== undefined ? body.active : true} WHERE id = ${id} RETURNING id
      `;
      if (!row) return json({ error: "Not found" }, 404);
      return json({ id: row.id, active: body.active !== undefined ? body.active : true });
    }

    // ---- Weekly digest ----
    if (path === "/api/digest/run" && method === "POST") {
      const auth = await getAuth(req);
      const digestKey = req.headers.get("x-digest-key");
      const allowed = isMgrOrAdmin(auth) || (DIGEST_SECRET && digestKey === DIGEST_SECRET);
      if (!allowed) return json({ error: "Unauthorized" }, 401);
      const result = await runDigest();
      return json(result);
    }

    if (path === "/api/settings" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      return json({ daysToRespond: await getDaysToRespond(), hoursToAllocate: await getHoursToAllocate() });
    }

    if (path === "/api/settings" && method === "PUT") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const days = Math.max(1, Math.min(5, Math.round(Number(body.daysToRespond) || 5)));
      const hours = Math.max(1, Math.min(72, Math.round(Number(body.hoursToAllocate) || 24)));
      await sql`
        INSERT INTO app_settings (id, days_to_respond, hours_to_allocate) VALUES (1, ${days}, ${hours})
        ON CONFLICT (id) DO UPDATE SET days_to_respond = ${days}, hours_to_allocate = ${hours}, updated_at = now()
      `;
      return json({ daysToRespond: days, hoursToAllocate: hours });
    }

    if (path === "/api/case-notes" && method === "GET") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const notes = await sql`
        SELECT n.id, n.title, n.body, n.created_at, u.name AS author_name
        FROM case_notes n
        LEFT JOIN users u ON u.id = n.author_id
        ORDER BY n.created_at DESC
      `;
      const entryRows = await sql`
        SELECT e.id, e.case_note_id, e.body, e.created_at, u.name AS author_name
        FROM case_note_entries e
        LEFT JOIN users u ON u.id = e.author_id
        ORDER BY e.created_at ASC
      `;
      const entriesByNote: Record<number, any[]> = {};
      for (const e of entryRows as any[]) {
        (entriesByNote[e.case_note_id] ||= []).push({
          id: `e${e.id}`,
          body: e.body,
          authorName: e.author_name || "Unknown",
          createdAt: e.created_at,
        });
      }
      return json(
        notes.map((r: any) => ({
          id: r.id,
          title: r.title,
          body: r.body,
          createdAt: r.created_at,
          authorName: r.author_name || "Unknown",
          entries: [
            { id: `n${r.id}`, body: r.body, authorName: r.author_name || "Unknown", createdAt: r.created_at },
            ...(entriesByNote[r.id] || []),
          ],
        }))
      );
    }

    if (path === "/api/case-notes" && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      if (!body.title || !body.body) {
        return json({ error: "Title and note body are required" }, 400);
      }
      const [row] = await sql`
        INSERT INTO case_notes (title, body, author_id)
        VALUES (${body.title}, ${body.body}, ${auth.sub})
        RETURNING id, title, body, created_at
      `;
      return json(
        { id: row.id, title: row.title, body: row.body, createdAt: row.created_at, authorName: auth.name },
        201
      );
    }

    const caseNoteEntryMatch = path.match(/^\/api\/case-notes\/(\d+)\/entries$/);
    if (caseNoteEntryMatch && method === "POST") {
      const auth = await getAuth(req);
      if (!auth) return json({ error: "Unauthorized" }, 401);
      if (!isMgrOrAdmin(auth)) return json({ error: "Forbidden" }, 403);
      const noteId = Number(caseNoteEntryMatch[1]);
      const body = await req.json();
      if (!body.body) {
        return json({ error: "Note text is required" }, 400);
      }
      const [note] = await sql`SELECT id FROM case_notes WHERE id = ${noteId}`;
      if (!note) return json({ error: "Case note not found" }, 404);
      const [row] = await sql`
        INSERT INTO case_note_entries (case_note_id, body, author_id)
        VALUES (${noteId}, ${body.body}, ${auth.sub})
        RETURNING id, body, created_at
      `;
      return json(
        { id: `e${row.id}`, body: row.body, authorName: auth.name, createdAt: row.created_at },
        201
      );
    }

    if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

    if (method === "GET") {
      return new Response(injectPrivacyLink(INDEX_HTML_RAW), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return json({ error: "Not found" }, 404);
  }
}


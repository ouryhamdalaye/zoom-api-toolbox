import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { BASE_URL, ACCOUNT_ID, ZOOM_AUTH_BASE64 } = process.env;

const PAGE_SIZE = 300;
const MAX_RETRIES = 5;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_FROM = "2026-10-06";
const DEFAULT_TZ = "Europe/Zurich";
// "scheduled" = réunions à venir + passées non expirées ; "previous_meetings" = réunions dont la fin est passée.
const LIST_TYPES = ["scheduled", "previous_meetings"];
const RECURRING_NO_FIXED_TIME = 3;
const RECURRING_FIXED_TIME = 8;
const MEETING_TYPES = {
  1: "instantanée",
  2: "planifiée",
  3: "récurrente sans heure fixe",
  4: "PMI",
  8: "récurrente à heure fixe",
  10: "écran de partage",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { fromDate: DEFAULT_FROM, toDate: null, tz: DEFAULT_TZ, emails: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: node audit-meeting-security.js [options]

Liste les réunions qui débutent dans la période pour chaque utilisateur Zoom sous licence
(type 2) et indique si Focus mode et Prevent screen capture sont activés.
Une réunion récurrente est retenue si au moins une de ses séances débute dans la période.

Options:
  --from, -f <date>      Début de période (YYYY-MM-DD, inclus) [défaut: ${DEFAULT_FROM}]
  --to, -t <date>        Fin de période (YYYY-MM-DD, inclus) [défaut: aucune limite]
  --tz <timezone>        Fuseau des dates de période [défaut: ${DEFAULT_TZ}]
  --emails, -e <liste>   Limiter à ces hôtes (emails séparés par des virgules)
  --help, -h             Afficher cette aide

Scopes requis (app Server-to-Server OAuth) :
  user:read:list_users:admin, meeting:read:list_meetings:admin, meeting:read:meeting:admin
      `);
      process.exit(0);
    } else if (arg === "--from" || arg === "-f") {
      config.fromDate = args[++i];
    } else if (arg === "--to" || arg === "-t") {
      config.toDate = args[++i];
    } else if (arg === "--tz") {
      config.tz = args[++i];
    } else if (arg === "--emails" || arg === "-e") {
      config.emails = args[++i]
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    } else {
      console.error(`❌ Argument inconnu : ${arg}`);
      console.error("💡 Utilisez --help pour voir l'aide");
      process.exit(1);
    }
  }

  if (!DATE_REGEX.test(config.fromDate || "") || (config.toDate !== null && !DATE_REGEX.test(config.toDate))) {
    console.error("❌ Format de date invalide. Utilisez YYYY-MM-DD");
    process.exit(1);
  }

  if (config.toDate && config.fromDate > config.toDate) {
    console.error("❌ La date de début doit être antérieure ou égale à la date de fin");
    process.exit(1);
  }

  return config;
}

function validateEnv() {
  const required = { BASE_URL, ACCOUNT_ID, ZOOM_AUTH_BASE64 };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error("❌ Variables d'environnement manquantes :");
    missing.forEach((name) => console.error(`   - ${name}`));
    console.error("\n💡 Vérifiez votre fichier .env");
    process.exit(1);
  }
}

// Minuit de `dateStr` dans le fuseau `tz`, en instant UTC.
function startOfDayInTz(dateStr, tz) {
  const utcMidnight = new Date(`${dateStr}T00:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(utcMidnight)
      .map((p) => [p.type, p.value])
  );
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = asIfUtc - utcMidnight.getTime();
  return new Date(utcMidnight.getTime() - offsetMs);
}

// "YYYY-MM-DD HH:mm" dans le fuseau `tz`.
function formatLocal(iso, tz) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function getAccessToken() {
  console.log("🔐 Authentification en cours...");

  try {
    const res = await axios.post("https://zoom.us/oauth/token", null, {
      params: {
        grant_type: "account_credentials",
        account_id: ACCOUNT_ID,
      },
      headers: {
        Authorization: `Basic ${ZOOM_AUTH_BASE64}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    console.log("✅ Token d'accès obtenu");
    return res.data.access_token;
  } catch (error) {
    const data = error.response?.data;
    console.error("❌ Échec de l'authentification OAuth");
    if (error.response) {
      console.error(`   Status : ${error.response.status}`);
      console.error(`   Message : ${data?.reason || data?.error_description || data?.message || JSON.stringify(data)}`);
    } else {
      console.error(`   ${error.message}`);
    }
    console.error("\n💡 Vérifiez que l'app Server-to-Server OAuth est activée et que ACCOUNT_ID / ZOOM_AUTH_BASE64 sont corrects");
    process.exit(1);
  }
}

async function zoomGet(token, urlPath, params = {}) {
  let attempt = 0;

  while (true) {
    try {
      const res = await axios.get(`${BASE_URL}${urlPath}`, {
        params,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      return res.data;
    } catch (error) {
      const status = error.response?.status;

      if (status === 429 && attempt < MAX_RETRIES) {
        attempt += 1;
        const retryAfter = Number(error.response.headers?.["retry-after"]);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        console.warn(`⏳ Limite de débit atteinte (429). Nouvelle tentative ${attempt}/${MAX_RETRIES} dans ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }

      if (status === 401) {
        console.error("❌ Token invalide ou expiré (401).");
        process.exit(1);
      }

      if (status === 400 && error.response?.data?.code === 4711) {
        console.error(`❌ Scope manquant pour ${urlPath} : ${error.response.data.message}`);
        process.exit(1);
      }

      throw error;
    }
  }
}

async function paginate(token, urlPath, params, key) {
  const items = [];
  let nextPageToken = "";

  do {
    const data = await zoomGet(token, urlPath, {
      ...params,
      page_size: PAGE_SIZE,
      ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
    });
    items.push(...(data[key] || []));
    nextPageToken = data.next_page_token || "";
  } while (nextPageToken);

  return items;
}

async function getLicensedUsers(token, emails) {
  const users = await paginate(token, "/users", { status: "active" }, "users");
  const licensed = users.filter((u) => u.type === 2);

  if (!emails) return licensed;

  const wanted = new Set(emails);
  const filtered = licensed.filter((u) => wanted.has(u.email.toLowerCase()));
  const found = new Set(filtered.map((u) => u.email.toLowerCase()));
  emails
    .filter((e) => !found.has(e))
    .forEach((e) => console.warn(`⚠️  ${e} : introuvable parmi les utilisateurs actifs sous licence`));
  return filtered;
}

async function listUserMeetings(token, user) {
  const byId = new Map();

  for (const type of LIST_TYPES) {
    const meetings = await paginate(token, `/users/${encodeURIComponent(user.id)}/meetings`, { type }, "meetings");
    meetings.forEach((m) => {
      if (!byId.has(m.id)) byId.set(m.id, m);
    });
  }

  return [...byId.values()];
}

function errorLabel(error) {
  const status = error.response?.status;
  return status === 404 ? "réunion introuvable (supprimée ou expirée)" : `erreur ${status || error.message}`;
}

// Séances non supprimées d'une réunion récurrente, passées comprises.
async function getRecurringMeeting(token, meetingId) {
  const upcoming = await zoomGet(token, `/meetings/${meetingId}`);
  const previous = await zoomGet(token, `/meetings/${meetingId}`, { show_previous_occurrences: true });

  const byOccurrence = new Map();
  [...(previous.occurrences || []), ...(upcoming.occurrences || [])].forEach((o) => byOccurrence.set(o.occurrence_id, o));
  const starts = [...byOccurrence.values()].filter((o) => o.status !== "deleted").map((o) => o.start_time);

  return { detail: upcoming, starts };
}

function inPeriod(startTime, period) {
  if (!startTime) return false;
  const start = new Date(startTime);
  return start >= period.from && (!period.to || start < period.to);
}

function settingLabel(value) {
  if (value === true) return "OUI";
  if (value === false) return "NON";
  return "non renvoyé";
}

async function auditUser(token, user, period) {
  const rows = [];
  const withoutFixedTime = [];

  for (const meeting of await listUserMeetings(token, user)) {
    if (meeting.type === RECURRING_NO_FIXED_TIME) {
      withoutFixedTime.push(meeting);
      continue;
    }

    let detail;
    let starts;

    try {
      if (meeting.type === RECURRING_FIXED_TIME) {
        ({ detail, starts } = await getRecurringMeeting(token, meeting.id));
        starts = starts.filter((s) => inPeriod(s, period));
        if (starts.length === 0) continue;
      } else {
        if (!inPeriod(meeting.start_time, period)) continue;
        starts = [meeting.start_time];
        detail = await zoomGet(token, `/meetings/${meeting.id}`);
      }
    } catch (error) {
      // Détail illisible : la ligne est gardée pour ne pas masquer la réunion (séances inconnues si récurrente).
      const reason = errorLabel(error);
      starts = meeting.type === RECURRING_FIXED_TIME ? [] : [meeting.start_time];
      rows.push(buildRow(user, meeting, starts, { focus_mode: reason, prevent_screen_capture: reason }));
      continue;
    }

    rows.push(
      buildRow(user, meeting, starts, {
        focus_mode: settingLabel(detail.settings?.focus_mode),
        prevent_screen_capture: settingLabel(detail.settings?.prevent_screen_capture),
      })
    );
  }

  rows.sort((a, b) => a.first_start_in_period.localeCompare(b.first_start_in_period));
  return { rows, withoutFixedTime };
}

function buildRow(user, meeting, starts, security) {
  const sorted = [...starts].sort();
  return {
    host_email: user.email,
    host_name: user.display_name || `${user.first_name || ""} ${user.last_name || ""}`.trim(),
    meeting_id: meeting.id,
    topic: meeting.topic,
    meeting_type: MEETING_TYPES[meeting.type] || meeting.type,
    first_start_in_period: sorted[0] || "",
    sessions_in_period: sorted.length,
    created_at: meeting.created_at || "",
    ...security,
  };
}

function escapeCsv(value) {
  const str = value == null ? "" : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function writeCsv(rows, config) {
  const outputDir = path.join(__dirname, "outputfiles");
  fs.mkdirSync(outputDir, { recursive: true });

  const suffix = config.toDate ? `${config.fromDate}_au_${config.toDate}` : `depuis_${config.fromDate}`;
  const outputPath = path.join(outputDir, `audit_securite_reunions_${suffix}.csv`);
  const headers = [
    "host_email",
    "host_name",
    "meeting_id",
    "topic",
    "meeting_type",
    "first_start_in_period",
    "sessions_in_period",
    "created_at",
    "focus_mode",
    "prevent_screen_capture",
  ];
  const lines = [headers.map((h) => (h === "first_start_in_period" ? `first_start_in_period (${config.tz})` : h)).join(",")];
  rows.forEach((row) => {
    const local = { ...row, first_start_in_period: formatLocal(row.first_start_in_period, config.tz) };
    lines.push(headers.map((h) => escapeCsv(local[h])).join(","));
  });

  // BOM pour qu'Excel ouvre correctement les accents.
  fs.writeFileSync(outputPath, `﻿${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

function printSummary(results, tz) {
  console.log("\n📊 Récapitulatif par hôte");
  console.log("=".repeat(50));

  for (const { user, rows, withoutFixedTime } of results) {
    if (rows.length === 0) {
      console.log(`\n👤 ${user.email} — aucune réunion ne débute dans la période`);
    } else {
      const count = (field, value) => rows.filter((r) => r[field] === value).length;
      console.log(`\n👤 ${user.email} — ${rows.length} réunion(s)`);
      console.log(`   Focus mode             : ${count("focus_mode", "OUI")} OUI / ${count("focus_mode", "NON")} NON`);
      console.log(`   Prevent screen capture : ${count("prevent_screen_capture", "OUI")} OUI / ${count("prevent_screen_capture", "NON")} NON`);
      rows
        .filter((r) => r.focus_mode !== "OUI" || r.prevent_screen_capture !== "OUI")
        .forEach((r) =>
          console.log(
            `   ⚠️  ${formatLocal(r.first_start_in_period, tz) || "date ?"} ${r.topic} — focus: ${r.focus_mode}, capture: ${r.prevent_screen_capture}`
          )
        );
    }

    withoutFixedTime.forEach((m) =>
      console.log(`   ℹ️  Ignorée (récurrente sans heure fixe, pas de date de début) : ${m.topic}`)
    );
  }
}

async function main() {
  const config = parseArgs();
  validateEnv();

  const period = {
    from: startOfDayInTz(config.fromDate, config.tz),
    to: config.toDate ? startOfDayInTz(nextDay(config.toDate), config.tz) : null,
  };

  console.log("🚀 Audit Focus mode / Prevent screen capture\n");
  console.log("=".repeat(50));
  console.log(
    `📅 Réunions qui débutent du ${config.fromDate} ${config.toDate ? `au ${config.toDate} inclus` : "sans date de fin"} (${config.tz})`
  );

  const token = await getAccessToken();

  const users = await getLicensedUsers(token, config.emails);
  console.log(`👥 ${users.length} utilisateur(s) actif(s) sous licence`);

  const results = [];
  for (const user of users) {
    const { rows, withoutFixedTime } = await auditUser(token, user, period);
    console.log(`📥 ${user.email} : ${rows.length} réunion(s) dans la période`);
    results.push({ user, rows, withoutFixedTime });
  }

  const allRows = results.flatMap((r) => r.rows);
  const outputPath = writeCsv(allRows, config);
  printSummary(results, config.tz);

  console.log("\n" + "=".repeat(50));
  console.log(`✅ ${allRows.length} réunion(s) auditée(s)`);
  console.log(`📁 Fichier créé : ${outputPath}`);
}

main().catch((err) => {
  console.error("❌ Erreur fatale :", err.response?.data ? JSON.stringify(err.response.data) : err.message);
  process.exit(1);
});

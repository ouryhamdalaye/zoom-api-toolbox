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
const EXPORT_ALL_FROM_DATE = "2011-01-01";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayStr() {
  return formatDate(new Date());
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    hostEmail: null,
    fromDate: null,
    toDate: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: node export-links.js <hostEmail> [options]

Arguments:
  <hostEmail>            Email de l'hôte Zoom [requis]

Options:
  --from, -f <date>      Date de début (YYYY-MM-DD) [optionnel, défaut: aujourd'hui]
  --to, -t <date>        Date de fin (YYYY-MM-DD) [optionnel, défaut: tout jusqu'à aujourd'hui]
  --help, -h             Afficher cette aide

Exemples:
  node export-links.js host@example.com
  node export-links.js host@example.com --from 2024-01-01
  node export-links.js host@example.com -f 2024-01-01 -t 2024-12-31
  npm run export-links -- host@example.com --from 2024-01-01
      `);
      process.exit(0);
    } else if (arg === "--from" || arg === "-f") {
      config.fromDate = args[++i];
    } else if (arg === "--to" || arg === "-t") {
      config.toDate = args[++i];
    } else if (!config.hostEmail) {
      config.hostEmail = arg;
    } else if (!config.fromDate && DATE_REGEX.test(arg)) {
      config.fromDate = arg;
    } else if (!config.toDate && DATE_REGEX.test(arg)) {
      config.toDate = arg;
    } else {
      console.error(`❌ Argument inconnu : ${arg}`);
      console.error("💡 Utilisez --help pour voir l'aide");
      process.exit(1);
    }
  }

  if (!config.hostEmail) {
    console.error("❌ Erreur : l'email de l'hôte est requis");
    console.error("Usage: node export-links.js <hostEmail> [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
    process.exit(1);
  }

  const today = todayStr();
  const exportAll = !config.fromDate && !config.toDate;

  config.fromDate = config.fromDate || today;
  config.toDate = config.toDate || today;

  if (exportAll) {
    config.fromDate = EXPORT_ALL_FROM_DATE;
  }

  if (!DATE_REGEX.test(config.fromDate) || !DATE_REGEX.test(config.toDate)) {
    console.error("❌ Format de date invalide. Utilisez YYYY-MM-DD");
    process.exit(1);
  }

  if (config.fromDate > config.toDate) {
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

function parseDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Découpe [from, to] en tranches d'un mois max (limite API Zoom).
 * Zoom utilise un `to` exclusif : from=2024-01-01 & to=2024-02-01 couvre janvier.
 */
function* generateDateRanges(fromStr, toStr) {
  let currentFrom = parseDate(fromStr);
  const end = parseDate(toStr);
  const dayAfterEnd = new Date(end);
  dayAfterEnd.setUTCDate(dayAfterEnd.getUTCDate() + 1);

  while (currentFrom <= end) {
    const chunkTo = new Date(currentFrom);
    chunkTo.setUTCMonth(chunkTo.getUTCMonth() + 1);

    const rangeTo = chunkTo < dayAfterEnd ? chunkTo : dayAfterEnd;

    yield {
      from: formatDate(currentFrom),
      to: formatDate(rangeTo),
    };

    currentFrom = rangeTo;
  }
}

function escapeCsvField(value) {
  const str = value == null ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatApiError(error) {
  if (!error.response) {
    return error.message;
  }

  const { status, data } = error.response;
  const message =
    data?.message ||
    data?.error_description ||
    data?.error ||
    JSON.stringify(data);

  return `HTTP ${status} — ${message}`;
}

async function withRetry(requestFn, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      const status = error.response?.status;

      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfterHeader = error.response.headers?.["retry-after"];
        const waitMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : Math.min(1000 * 2 ** attempt, 30000);

        console.warn(
          `⚠️  Rate limit (429) sur ${label}. Nouvelle tentative dans ${Math.round(waitMs / 1000)}s...`
        );
        await sleep(waitMs);
        continue;
      }

      throw error;
    }
  }
}

async function getAccessToken() {
  console.log("🔐 Authentification OAuth...");

  const response = await withRetry(
    () =>
      axios.post("https://zoom.us/oauth/token", null, {
        params: {
          grant_type: "account_credentials",
          account_id: ACCOUNT_ID,
        },
        headers: {
          Authorization: `Basic ${ZOOM_AUTH_BASE64}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }),
    "oauth/token"
  );

  const token = response.data?.access_token;
  if (!token) {
    throw new Error("Réponse OAuth invalide : access_token manquant");
  }

  return token;
}

async function listRecordings(token, hostEmail, from, to, nextPageToken = "") {
  const params = {
    from,
    to,
    page_size: PAGE_SIZE,
  };

  if (nextPageToken) {
    params.next_page_token = nextPageToken;
  }

  const response = await withRetry(
    () =>
      axios.get(
        `${BASE_URL}/users/${encodeURIComponent(hostEmail)}/recordings`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          params,
        }
      ),
    `recordings ${from} → ${to}`
  );

  return response.data;
}

async function fetchAllMeetings(token, hostEmail, fromDate, toDate) {
  const meetings = [];
  const ranges = [...generateDateRanges(fromDate, toDate)];

  console.log(`📅 Période : ${fromDate} → ${toDate}`);
  console.log(`📦 ${ranges.length} tranche(s) de dates (max 1 mois chacune)\n`);

  for (const range of ranges) {
    console.log(`📄 Tranche ${range.from} → ${range.to}`);

    let nextPageToken = "";
    let page = 0;

    do {
      page++;
      let data;

      try {
        data = await listRecordings(
          token,
          hostEmail,
          range.from,
          range.to,
          nextPageToken
        );
      } catch (error) {
        if (error.response?.status === 401) {
          console.warn("⚠️  Token expiré ou invalide, renouvellement...");
          token = await getAccessToken();
          data = await listRecordings(
            token,
            hostEmail,
            range.from,
            range.to,
            nextPageToken
          );
        } else {
          throw error;
        }
      }

      const pageMeetings = data.meetings || [];
      meetings.push(...pageMeetings);

      const totalRecords = data.total_records ?? "?";
      console.log(
        `   ✓ Page ${page} : ${pageMeetings.length} réunion(s) (total API : ${totalRecords})`
      );

      if (
        page === 1 &&
        typeof data.total_records === "number" &&
        data.total_records > pageMeetings.length &&
        !data.next_page_token
      ) {
        console.warn(
          `   ⚠️  ${data.total_records} enregistrement(s) annoncé(s) mais pagination absente`
        );
      }

      nextPageToken = data.next_page_token || "";
    } while (nextPageToken);
  }

  return meetings;
}

function writeCsv(meetings, outputPath) {
  const rows = meetings.map((meeting) =>
    [meeting.topic, meeting.start_time, meeting.share_url]
      .map(escapeCsvField)
      .join(",")
  );

  const content = ["topic,start_time,share_url", ...rows].join("\n") + "\n";
  fs.writeFileSync(outputPath, content, "utf8");
}

async function main() {
  validateEnv();
  const { hostEmail, fromDate, toDate } = parseArgs();

  console.log("🔗 Export des liens de partage Zoom\n");
  console.log(`👤 Hôte : ${hostEmail}\n`);

  try {
    let token = await getAccessToken();
    console.log("✅ Token d'accès obtenu\n");

    const meetings = await fetchAllMeetings(token, hostEmail, fromDate, toDate);

    if (meetings.length === 0) {
      console.warn("\n⚠️  Aucun enregistrement trouvé pour cette période.");
    } else {
      console.log(`\n✅ ${meetings.length} réunion(s) récupérée(s)`);
    }

    const outputDir = path.join(__dirname, "outputfiles");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, `zoom_links_${hostEmail}.csv`);
    writeCsv(meetings, outputPath);

    console.log(`💾 CSV écrit : ${outputPath}`);
  } catch (error) {
    console.error("\n❌ Erreur :");
    console.error(`   ${formatApiError(error)}`);

    if (error.response?.status === 401) {
      console.error("\n💡 Vérifiez ZOOM_AUTH_BASE64, ACCOUNT_ID et les permissions OAuth (recording:read).");
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Erreur fatale :", error.message);
  process.exit(1);
});

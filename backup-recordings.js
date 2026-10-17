import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const { BASE_URL, ACCOUNT_ID, ZOOM_AUTH_BASE64 } = process.env;

const PAGE_SIZE = 300;
const MAX_RETRIES = 5;
const DOWNLOAD_RETRIES = 3;
const TOKEN_TTL_MS = 50 * 60 * 1000; // token Zoom valable 1 h
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MANIFEST_NAME = "checksums.sha256"; // format sha256sum, chemins relatifs à --dest

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!bytes) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 2 : 0)} ${units[i]}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    dest: null,
    fromDate: null,
    toDate: null,
    emails: null,
    dryRun: false,
    verify: false,
    maxFiles: Infinity,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: node backup-recordings.js --dest <dossier> --from YYYY-MM-DD --to YYYY-MM-DD [options]
       node backup-recordings.js --dest <dossier> --verify

Télécharge les enregistrements cloud de tous les utilisateurs (actifs et inactifs)
directement dans <dossier> (ex. un disque externe) : vidéo, audio, transcription,
chat, sous-titres, timeline, et audio séparé par participant s'il existe.
Relançable : les fichiers déjà complets sont ignorés, les téléchargements
interrompus (.part) sont repris de zéro.

Chaque fichier est haché en SHA-256 pendant le téléchargement ; les empreintes
sont écrites dans <dossier>/${MANIFEST_NAME} (compatible sha256sum -c).
--verify relit tout le disque et compare avec ce manifeste (aucun appel Zoom).

Options:
  --dest, -d <dossier>   Dossier de destination, ex. E:\\ZoomBackup [requis]
  --from, -f <date>      Date de début incluse (YYYY-MM-DD) [requis]
  --to, -t <date>        Date de fin incluse (YYYY-MM-DD) [requis]
  --emails, -e <liste>   Limiter à ces hôtes (séparés par des virgules)
  --max-files <n>        S'arrêter après n fichiers téléchargés (test)
  --dry-run              Lister et totaliser sans rien télécharger
  --verify               Revérifier les empreintes SHA-256 du disque
  --help, -h             Afficher cette aide

Exemples:
  node backup-recordings.js -d E:\\ZoomBackup -f 2026-10-01 -t 2026-10-07 --dry-run
  node backup-recordings.js -d E:\\ZoomBackup -f 2026-10-01 -t 2026-10-07 --max-files 3
  node backup-recordings.js -d E:\\ZoomBackup -f 2018-01-01 -t 2026-10-17
  node backup-recordings.js -d E:\\ZoomBackup --verify
      `);
      process.exit(0);
    } else if (arg === "--dest" || arg === "-d") {
      config.dest = args[++i];
    } else if (arg === "--from" || arg === "-f") {
      config.fromDate = args[++i];
    } else if (arg === "--to" || arg === "-t") {
      config.toDate = args[++i];
    } else if (arg === "--emails" || arg === "-e") {
      config.emails = new Set(
        args[++i].split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
      );
    } else if (arg === "--max-files") {
      config.maxFiles = Number(args[++i]);
    } else if (arg === "--dry-run") {
      config.dryRun = true;
    } else if (arg === "--verify") {
      config.verify = true;
    } else {
      console.error(`❌ Argument inconnu : ${arg}`);
      console.error("💡 Utilisez --help pour voir l'aide");
      process.exit(1);
    }
  }

  if (config.verify) {
    if (!config.dest) {
      console.error("❌ --dest est requis");
      process.exit(1);
    }
    return config;
  }

  if (!config.dest || !config.fromDate || !config.toDate) {
    console.error("❌ --dest, --from et --to sont requis");
    console.error("💡 Utilisez --help pour voir l'aide");
    process.exit(1);
  }

  if (!DATE_REGEX.test(config.fromDate) || !DATE_REGEX.test(config.toDate)) {
    console.error("❌ Format de date invalide. Utilisez YYYY-MM-DD");
    process.exit(1);
  }

  if (config.fromDate > config.toDate) {
    console.error("❌ La date de début doit être antérieure ou égale à la date de fin");
    process.exit(1);
  }

  if (!(config.maxFiles > 0)) {
    console.error("❌ --max-files doit être un entier positif");
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
 * Même découpage que export-links.js ; les doublons éventuels aux bornes
 * sont éliminés par id de fichier.
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

    yield { from: formatDate(currentFrom), to: formatDate(rangeTo) };
    currentFrom = rangeTo;
  }
}

function formatApiError(error) {
  if (!error.response) return error.message;
  const { status, data } = error.response;
  const message =
    data?.message || data?.error_description || data?.error ||
    (typeof data?.pipe === "function" ? "" : JSON.stringify(data));
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

// -----------------------------------------------------
// 🔐 TOKEN (renouvelé automatiquement, les téléchargements durent des heures)

let cachedToken = null;
let tokenObtainedAt = 0;

async function getAccessToken(force = false) {
  if (!force && cachedToken && Date.now() - tokenObtainedAt < TOKEN_TTL_MS) {
    return cachedToken;
  }

  const response = await withRetry(
    () =>
      axios.post("https://zoom.us/oauth/token", null, {
        params: { grant_type: "account_credentials", account_id: ACCOUNT_ID },
        headers: {
          Authorization: `Basic ${ZOOM_AUTH_BASE64}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }),
    "oauth/token"
  );

  const token = response.data?.access_token;
  if (!token) throw new Error("Réponse OAuth invalide : access_token manquant");

  cachedToken = token;
  tokenObtainedAt = Date.now();
  return token;
}

async function apiGet(url, params, label) {
  const doRequest = async () =>
    axios.get(`${BASE_URL}${url}`, {
      headers: { Authorization: `Bearer ${await getAccessToken()}`, Accept: "application/json" },
      params,
    });

  try {
    return (await withRetry(doRequest, label)).data;
  } catch (error) {
    if (error.response?.status === 401) {
      await getAccessToken(true);
      return (await withRetry(doRequest, label)).data;
    }
    throw error;
  }
}

// -----------------------------------------------------
// 👥 UTILISATEURS ET ENREGISTREMENTS

async function listUsers() {
  const users = [];
  for (const status of ["active", "inactive"]) {
    let nextPageToken = "";
    do {
      const data = await apiGet(
        "/users",
        { status, page_size: PAGE_SIZE, ...(nextPageToken && { next_page_token: nextPageToken }) },
        `users ${status}`
      );
      users.push(...(data.users || []));
      nextPageToken = data.next_page_token || "";
    } while (nextPageToken);
  }
  return users;
}

async function listUserMeetings(user, fromDate, toDate) {
  const meetings = [];
  for (const range of generateDateRanges(fromDate, toDate)) {
    let nextPageToken = "";
    do {
      const data = await apiGet(
        `/users/${encodeURIComponent(user.id)}/recordings`,
        {
          from: range.from,
          to: range.to,
          page_size: PAGE_SIZE,
          ...(nextPageToken && { next_page_token: nextPageToken }),
        },
        `recordings ${user.email} ${range.from} → ${range.to}`
      );
      meetings.push(...(data.meetings || []));
      nextPageToken = data.next_page_token || "";
    } while (nextPageToken);
  }
  return meetings;
}

// -----------------------------------------------------
// 💾 TÉLÉCHARGEMENT

function safeName(str, maxLength = 60) {
  const cleaned = String(str || "sans_titre")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .replace(/[. ]+$/, ""); // Windows refuse les noms finissant par . ou espace
  return cleaned || "sans_titre";
}

function meetingFolderName(meeting) {
  // 2026-10-06T14:30:00Z → 2026-10-06_1430 (UTC)
  const stamp = String(meeting.start_time || "").replace(/:\d\dZ?$/, "").replace("T", "_").replace(":", "");
  return `${stamp}_${safeName(meeting.topic)}`;
}

function fileName(file) {
  const ext = (file.file_extension || file.file_type || "bin").toLowerCase();
  // Les fichiers audio par participant n'ont pas de recording_type mais un file_name ("Audio de X")
  const kind = file.isParticipantAudio
    ? `participant_${safeName(file.file_name || "audio", 40)}`
    : safeName(file.recording_type || file.file_type || "file", 40);
  return `${kind.replace(/ /g, "_")}_${file.id}.${ext}`;
}

function fileKind(file) {
  return file.isParticipantAudio ? "participant_audio" : file.recording_type || file.file_type || "inconnu";
}

// -----------------------------------------------------
// 🔏 EMPREINTES SHA-256

function hashingStream(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function toManifestPath(dest, filePath) {
  return path.relative(dest, filePath).split(path.sep).join("/");
}

function loadManifest(dest) {
  const manifest = new Map();
  const manifestPath = path.join(dest, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return manifest;

  for (const line of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64}) [ *](.+)$/);
    if (match) manifest.set(match[2], match[1]);
  }
  return manifest;
}

function addToManifest(dest, manifest, filePath, sha256) {
  const relPath = toManifestPath(dest, filePath);
  manifest.set(relPath, sha256);
  fs.appendFileSync(path.join(dest, MANIFEST_NAME), `${sha256}  ${relPath}\n`, "utf8");
}

function listFilesRecursive(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFilesRecursive(fullPath));
    else result.push(fullPath);
  }
  return result;
}

async function verifyBackup(dest) {
  console.log(`🔏 Vérification des empreintes SHA-256 dans ${dest}\n`);

  const manifest = loadManifest(dest);
  if (manifest.size === 0) {
    console.error(`❌ Manifeste ${MANIFEST_NAME} absent ou vide`);
    process.exit(1);
  }

  const ROOT_FILES = new Set([MANIFEST_NAME, "downloaded.log", "errors.log"]);
  const onDisk = new Set(
    listFilesRecursive(dest)
      .map((p) => toManifestPath(dest, p))
      .filter((p) => !ROOT_FILES.has(p))
  );

  const stats = { ok: 0, mismatch: 0, missing: 0, bytes: 0 };
  let index = 0;

  for (const [relPath, expected] of manifest) {
    index++;
    const filePath = path.join(dest, ...relPath.split("/"));
    onDisk.delete(relPath);

    if (!fs.existsSync(filePath)) {
      stats.missing++;
      console.error(`   ❌ MANQUANT  ${relPath}`);
      continue;
    }

    const actual = await hashFile(filePath);
    stats.bytes += fs.statSync(filePath).size;
    if (actual === expected) {
      stats.ok++;
      if (index % 100 === 0) console.log(`   … ${index}/${manifest.size} (${formatBytes(stats.bytes)})`);
    } else {
      stats.mismatch++;
      console.error(`   ❌ CORROMPU  ${relPath}`);
    }
  }

  const partial = [...onDisk].filter((p) => p.endsWith(".part"));
  const untracked = [...onDisk].filter((p) => !p.endsWith(".part"));

  console.log("\n📊 Bilan");
  console.log(`   OK              : ${stats.ok} (${formatBytes(stats.bytes)})`);
  console.log(`   Corrompus       : ${stats.mismatch}`);
  console.log(`   Manquants       : ${stats.missing}`);
  console.log(`   Hors manifeste  : ${untracked.length}`);
  untracked.slice(0, 20).forEach((p) => console.log(`      ? ${p}`));
  if (partial.length) console.log(`   Téléchargements inachevés (.part) : ${partial.length}`);

  if (stats.mismatch || stats.missing) process.exit(2);
}

function isAlreadyDownloaded(outPath, file) {
  if (!fs.existsSync(outPath)) return false;
  if (!file.file_size) return true; // pas de taille annoncée : le fichier final n'existe qu'une fois complet
  return fs.statSync(outPath).size === file.file_size;
}

async function downloadFile(file, outPath) {
  const partPath = `${outPath}.part`;

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      const response = await axios.get(file.download_url, {
        headers: { Authorization: `Bearer ${await getAccessToken()}` },
        responseType: "stream",
        maxRedirects: 10,
        timeout: 60000, // délai avant les premiers octets
      });

      // Hachage à la volée : aucune relecture du disque pendant la sauvegarde
      const hash = crypto.createHash("sha256");
      await pipeline(response.data, hashingStream(hash), fs.createWriteStream(partPath));

      const size = fs.statSync(partPath).size;
      if (file.file_size && size !== file.file_size) {
        throw new Error(`taille reçue ${size} ≠ attendue ${file.file_size}`);
      }

      fs.renameSync(partPath, outPath);
      return { size, sha256: hash.digest("hex") };
    } catch (error) {
      if (error.response?.status === 401) await getAccessToken(true);
      if (attempt === DOWNLOAD_RETRIES) throw error;
      console.warn(`      ⚠️  Essai ${attempt} échoué (${formatApiError(error)}), nouvel essai...`);
      await sleep(5000 * attempt);
    }
  }
}

function appendLog(dest, name, line) {
  fs.appendFileSync(path.join(dest, name), `${new Date().toISOString()}\t${line}\n`, "utf8");
}

// -----------------------------------------------------

async function main() {
  const config = parseArgs();
  const { dest, fromDate, toDate, emails, dryRun, maxFiles } = config;

  if (config.verify) {
    await verifyBackup(dest);
    return;
  }

  validateEnv();

  console.log(`💾 Sauvegarde des enregistrements Zoom ${dryRun ? "(DRY RUN, aucun téléchargement)" : ""}\n`);
  console.log(`📁 Destination : ${dest}`);
  console.log(`📅 Période : ${fromDate} → ${toDate} (incluses)`);
  if (emails) console.log(`👤 Hôtes : ${[...emails].join(", ")}`);
  if (maxFiles !== Infinity) console.log(`🔢 Limite : ${maxFiles} fichier(s)`);
  console.log("");

  if (!dryRun) fs.mkdirSync(dest, { recursive: true });

  await getAccessToken();
  let users = await listUsers();
  if (emails) users = users.filter((u) => emails.has(String(u.email).toLowerCase()));
  console.log(`👥 ${users.length} utilisateur(s) à parcourir\n`);

  const manifest = dryRun ? new Map() : loadManifest(dest);
  const seenFileIds = new Set();
  const byKind = new Map(); // type de fichier → { count, bytes }
  const stats = { meetings: 0, files: 0, totalBytes: 0, skipped: 0, downloaded: 0, downloadedBytes: 0, failed: 0 };
  const startedAt = Date.now();

  outer: for (const user of users) {
    const meetings = await listUserMeetings(user, fromDate, toDate);
    if (meetings.length === 0) continue;

    console.log(`👤 ${user.email} : ${meetings.length} réunion(s)`);

    for (const meeting of meetings) {
      const files = [
        ...(meeting.recording_files || []),
        ...(meeting.participant_audio_files || []).map((f) => ({ ...f, isParticipantAudio: true })),
      ].filter((f) => f.status === "completed" && f.download_url && !seenFileIds.has(f.id));
      if (files.length === 0) continue;
      stats.meetings++;

      const dir = path.join(dest, safeName(user.email, 100), meetingFolderName(meeting));

      for (const file of files) {
        seenFileIds.add(file.id);
        stats.files++;
        stats.totalBytes += file.file_size || 0;
        const kind = byKind.get(fileKind(file)) || { count: 0, bytes: 0 };
        kind.count++;
        kind.bytes += file.file_size || 0;
        byKind.set(fileKind(file), kind);

        const outPath = path.join(dir, fileName(file));
        const label = `${meetingFolderName(meeting)}/${fileName(file)} (${formatBytes(file.file_size)})`;

        if (isAlreadyDownloaded(outPath, file)) {
          stats.skipped++;
          if (!dryRun && !manifest.has(toManifestPath(dest, outPath))) {
            addToManifest(dest, manifest, outPath, await hashFile(outPath));
          }
          continue;
        }

        if (dryRun) {
          console.log(`   • ${label}`);
          continue;
        }

        if (stats.downloaded >= maxFiles) break outer;

        fs.mkdirSync(dir, { recursive: true });
        console.log(`   ⬇️  ${label}`);
        try {
          const { size, sha256 } = await downloadFile(file, outPath);
          addToManifest(dest, manifest, outPath, sha256);
          stats.downloaded++;
          stats.downloadedBytes += size;
          appendLog(dest, "downloaded.log", `${outPath}\t${size}\t${sha256}`);
        } catch (error) {
          stats.failed++;
          console.error(`      ❌ ${formatApiError(error)}`);
          appendLog(dest, "errors.log", `${outPath}\t${file.download_url}\t${formatApiError(error)}`);
        }
      }
    }
  }

  const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log("\n📊 Bilan");
  console.log(`   Réunions avec fichiers : ${stats.meetings}`);
  console.log(`   Fichiers vus           : ${stats.files} (${formatBytes(stats.totalBytes)})`);
  for (const [kindName, { count, bytes }] of [...byKind].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`      - ${kindName.padEnd(36)} ${String(count).padStart(5)}  ${formatBytes(bytes)}`);
  }
  console.log(`   Déjà présents          : ${stats.skipped}`);
  if (!dryRun) {
    console.log(`   Téléchargés            : ${stats.downloaded} (${formatBytes(stats.downloadedBytes)}) en ${minutes} min`);
    console.log(`   Échecs                 : ${stats.failed}${stats.failed ? ` → voir ${path.join(dest, "errors.log")}` : ""}`);
  }

  try {
    const target = fs.existsSync(dest) ? dest : path.parse(path.resolve(dest)).root;
    const { bavail, bsize } = fs.statfsSync(target);
    console.log(`   Espace libre sur la destination : ${formatBytes(bavail * bsize)}`);
  } catch {
    // statfs indisponible : pas bloquant
  }

  if (stats.failed > 0) process.exit(2);
}

main().catch((error) => {
  console.error("\n❌ Erreur fatale :", formatApiError(error));
  if (error.response?.status === 401 || error.response?.status === 403) {
    console.error("💡 Vérifiez les scopes de l'app S2S : user:read:list_users:admin, cloud_recording:read:list_user_recordings:admin");
  }
  process.exit(1);
});

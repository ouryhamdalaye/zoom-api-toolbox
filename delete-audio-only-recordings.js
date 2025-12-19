import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const {
  ACCOUNT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
} = process.env;

// -----------------------------------------------------
// 🔧 PARSING DES ARGUMENTS

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    fromDate: null,
    toDate: null,
    dryRun: true, // Par défaut, mode simulation pour sécurité
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: node delete-audio-only-recordings.js [options]

Options:
  --from, -f <date>      Date de début (format: YYYY-MM-DD) [requis]
  --to, -t <date>        Date de fin (format: YYYY-MM-DD) [requis]
  --dry-run              Mode simulation (par défaut) [optionnel]
  --no-dry-run           Mode actif (suppression réelle) [optionnel]
  --help, -h             Afficher cette aide

Exemples:
  node delete-audio-only-recordings.js --from 2025-10-06 --to 2025-10-07
  node delete-audio-only-recordings.js -f 2025-10-06 -t 2025-10-07 --no-dry-run
      `);
      process.exit(0);
    } else if (arg === "--from" || arg === "-f") {
      config.fromDate = args[++i];
    } else if (arg === "--to" || arg === "-t") {
      config.toDate = args[++i];
    } else if (arg === "--dry-run") {
      config.dryRun = true;
    } else if (arg === "--no-dry-run") {
      config.dryRun = false;
    }
  }

  // Validation
  if (!config.fromDate || !config.toDate) {
    console.error("❌ Erreur : --from et --to sont requis");
    console.error("💡 Utilisez --help pour voir l'aide");
    process.exit(1);
  }

  // Validation du format de date (simple)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(config.fromDate) || !dateRegex.test(config.toDate)) {
    console.error("❌ Erreur : Format de date invalide. Utilisez YYYY-MM-DD");
    process.exit(1);
  }

  return config;
}

const { fromDate: FROM_DATE, toDate: TO_DATE, dryRun: DRY_RUN } = parseArgs();

// -----------------------------------------------------

async function getAccessToken() {
  const res = await axios.post(
    "https://zoom.us/oauth/token",
    null,
    {
      params: {
        grant_type: "account_credentials",
        account_id: ACCOUNT_ID,
      },
      auth: {
        username: CLIENT_ID,
        password: CLIENT_SECRET,
      },
    }
  );

  return res.data.access_token;
}

async function listRecordings(token, nextPageToken = "") {
  const res = await axios.get(
    "https://api.zoom.us/v2/accounts/me/recordings",
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      params: {
        from: FROM_DATE,
        to: TO_DATE,
        page_size: 300,
        next_page_token: nextPageToken,
      },
    }
  );

  return res.data;
}

async function moveToTrash(token, meetingId, meetingUuid, fileId) {
  // ⚠️ PAS de action=delete → mise à la corbeille
  // Essayer d'abord avec l'UUID (recommandé par Zoom pour les enregistrements)
  // Si l'UUID n'est pas disponible, utiliser l'ID numérique
  const meetingIdentifier = meetingUuid || meetingId;
  
  await axios.delete(
    `https://api.zoom.us/v2/meetings/${meetingIdentifier}/recordings/${fileId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );
}

async function main() {
  const token = await getAccessToken();
  let nextPageToken = "";
  let matched = 0;
  let trashed = 0;
  let errors = 0;

  console.log(`🚦 Mode : ${DRY_RUN ? "DRY-RUN (simulation)" : "CORBEILLE ACTIVE"}`);
  console.log(`📅 Période : ${FROM_DATE} → ${TO_DATE}\n`);

  do {
    const data = await listRecordings(token, nextPageToken);

    for (const meeting of data.meetings) {
      for (const file of meeting.recording_files || []) {
        if (file.recording_type === "audio_only") {
          matched++;

          // Formater la date de l'enregistrement
          const recordingDate = file.recording_start 
            ? new Date(file.recording_start).toLocaleString('fr-FR', { 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit' 
              })
            : 'N/A';

          console.log(
            `🎧 audio_only | Meeting ID: ${meeting.id} | UUID: ${meeting.uuid || 'N/A'} | Meeting: "${meeting.topic}" | Date: ${recordingDate} | File ID: ${file.id}`
          );

          if (!DRY_RUN) {
            let success = false;
            
            // Essayer d'abord avec l'UUID si disponible (recommandé par Zoom)
            if (meeting.uuid) {
              try {
                await moveToTrash(token, meeting.id, meeting.uuid, file.id);
                trashed++;
                success = true;
                console.log("   🗑️ déplacé dans la corbeille (avec UUID)");
              } catch (error) {
                const errorMsg = error.response?.data?.message || error.message;
                const errorCode = error.response?.data?.code || error.response?.status;
                console.log(`   ⚠️  Erreur avec UUID (${errorCode}): ${errorMsg}`);
                
                // Si erreur 3301, essayer avec l'ID numérique
                if (errorCode === 3301 && meeting.id) {
                  console.log(`   🔄 Tentative avec l'ID numérique...`);
                  try {
                    await moveToTrash(token, meeting.id, null, file.id);
                    trashed++;
                    success = true;
                    console.log("   🗑️ déplacé dans la corbeille (avec ID numérique)");
                  } catch (retryError) {
                    const retryErrorMsg = retryError.response?.data?.message || retryError.message;
                    const retryErrorCode = retryError.response?.data?.code || retryError.response?.status;
                    console.log(`   ❌ Échec également avec l'ID numérique (${retryErrorCode}): ${retryErrorMsg}`);
                  }
                }
              }
            } else {
              // Pas d'UUID, utiliser directement l'ID numérique
              try {
                await moveToTrash(token, meeting.id, null, file.id);
                trashed++;
                success = true;
                console.log("   🗑️ déplacé dans la corbeille");
              } catch (error) {
                const errorMsg = error.response?.data?.message || error.message;
                const errorCode = error.response?.data?.code || error.response?.status;
                console.log(`   ⚠️  Erreur (${errorCode}): ${errorMsg}`);
              }
            }
            
            if (!success) {
              errors++;
              console.log(`   ⏭️  Passage au suivant...`);
            }
          } else {
            console.log("   👀 DRY-RUN : aucune action");
          }
        }
      }
    }

    nextPageToken = data.next_page_token;
  } while (nextPageToken);

  console.log("\n📊 RÉSUMÉ");
  console.log(`- Fichiers audio_only trouvés : ${matched}`);
  console.log(`- Fichiers mis à la corbeille : ${trashed}`);
  if (errors > 0) {
    console.log(`- Erreurs rencontrées : ${errors}`);
  }
}

main().catch((err) => {
  console.error("❌ Erreur :", err.response?.data || err.message);
});

import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

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
    outputFile: null,
    pretty: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: node get-zoom-recordings.js [options]

Options:
  --from, -f <date>      Date de début (format: YYYY-MM-DD) [requis]
  --to, -t <date>        Date de fin (format: YYYY-MM-DD) [requis]
  --output, -o <file>    Sauvegarder le JSON dans un fichier [optionnel]
  --compact              Afficher le JSON en une seule ligne [optionnel]
  --help, -h             Afficher cette aide

Exemples:
  node get-zoom-recordings.js --from 2025-10-06 --to 2025-10-07
  node get-zoom-recordings.js -f 2025-10-06 -t 2025-10-07 --output recordings.json
  node get-zoom-recordings.js -f 2025-10-06 -t 2025-10-07 --compact
      `);
      process.exit(0);
    } else if (arg === "--from" || arg === "-f") {
      config.fromDate = args[++i];
    } else if (arg === "--to" || arg === "-t") {
      config.toDate = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      config.outputFile = args[++i];
    } else if (arg === "--compact") {
      config.pretty = false;
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

const { fromDate: FROM_DATE, toDate: TO_DATE, outputFile, pretty } = parseArgs();

// -----------------------------------------------------

async function getAccessToken() {
  console.log("🔐 Authentification en cours...");
  
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

async function main() {
  // Vérification des variables d'environnement
  if (!ACCOUNT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Variables d'environnement manquantes :");
    if (!ACCOUNT_ID) console.error("   - ACCOUNT_ID");
    if (!CLIENT_ID) console.error("   - CLIENT_ID");
    if (!CLIENT_SECRET) console.error("   - CLIENT_SECRET");
    console.error("\n💡 Assurez-vous que votre fichier .env contient ces variables.");
    process.exit(1);
  }

  console.log("📹 Récupération des enregistrements Zoom\n");
  console.log(`📅 Période : ${FROM_DATE} → ${TO_DATE}\n`);

  try {
    const token = await getAccessToken();
    console.log("✅ Token d'accès obtenu\n");

    let allRecordings = {
      from: FROM_DATE,
      to: TO_DATE,
      total_records: 0,
      page_count: 0,
      meetings: [],
    };

    let nextPageToken = "";
    let pageCount = 0;

    do {
      pageCount++;
      console.log(`📄 Récupération de la page ${pageCount}...`);
      
      const data = await listRecordings(token, nextPageToken);
      
      allRecordings.meetings.push(...(data.meetings || []));
      allRecordings.total_records += data.meetings?.length || 0;
      allRecordings.page_count = pageCount;

      nextPageToken = data.next_page_token;
      
      if (nextPageToken) {
        console.log(`   ✓ ${data.meetings?.length || 0} réunions récupérées (page suivante disponible)\n`);
      } else {
        console.log(`   ✓ ${data.meetings?.length || 0} réunions récupérées (dernière page)\n`);
      }
    } while (nextPageToken);

    console.log(`✅ Total : ${allRecordings.total_records} réunions récupérées sur ${pageCount} page(s)\n`);

    // Formatage du JSON
    const jsonOutput = pretty 
      ? JSON.stringify(allRecordings, null, 2)
      : JSON.stringify(allRecordings);

    // Affichage ou sauvegarde
    if (outputFile) {
      fs.writeFileSync(outputFile, jsonOutput, "utf8");
      console.log(`💾 JSON sauvegardé dans : ${outputFile}`);
    } else {
      console.log("📋 Réponse JSON :\n");
      console.log(jsonOutput);
    }

  } catch (error) {
    console.error("\n❌ Erreur :");
    if (error.response) {
      console.error(`   Status : ${error.response.status}`);
      console.error(`   Message : ${error.response.data?.message || JSON.stringify(error.response.data)}`);
    } else {
      console.error(`   ${error.message}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Erreur fatale :", err.message);
  process.exit(1);
});


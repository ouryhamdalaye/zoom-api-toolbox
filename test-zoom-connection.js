import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const {
  ACCOUNT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
} = process.env;

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

async function testConnection(token) {
  console.log("🧪 Test de connexion à l'API Zoom...");
  
  try {
    // Test 1: Récupérer les informations de l'utilisateur actuel
    const userRes = await axios.get(
      "https://api.zoom.us/v2/users/me",
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log("✅ Connexion réussie !\n");
    console.log("📋 Informations du compte :");
    console.log(`   - Email : ${userRes.data.email}`);
    console.log(`   - Nom : ${userRes.data.first_name} ${userRes.data.last_name}`);
    console.log(`   - Type de compte : ${userRes.data.type}`);
    console.log(`   - Statut : ${userRes.data.status}`);
    
    return true;
  } catch (error) {
    console.error("❌ Erreur lors du test de connexion :");
    if (error.response) {
      console.error(`   Status : ${error.response.status}`);
      console.error(`   Message : ${error.response.data.message || JSON.stringify(error.response.data)}`);
    } else {
      console.error(`   ${error.message}`);
    }
    return false;
  }
}

async function main() {
  console.log("🚀 Test de connexion Zoom API\n");
  console.log("=" .repeat(50));
  
  // Vérification des variables d'environnement
  console.log("\n📝 Vérification des variables d'environnement...");
  const missingVars = [];
  
  if (!ACCOUNT_ID) missingVars.push("ACCOUNT_ID");
  if (!CLIENT_ID) missingVars.push("CLIENT_ID");
  if (!CLIENT_SECRET) missingVars.push("CLIENT_SECRET");
  
  if (missingVars.length > 0) {
    console.error("❌ Variables d'environnement manquantes :");
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error("\n💡 Assurez-vous que votre fichier .env contient ces variables.");
    process.exit(1);
  }
  
  console.log("✅ Toutes les variables d'environnement sont présentes");
  console.log(`   - Account ID : ${ACCOUNT_ID.substring(0, 8)}...`);
  console.log(`   - Client ID : ${CLIENT_ID.substring(0, 8)}...`);
  
  try {
    // Obtention du token
    const token = await getAccessToken();
    console.log("✅ Token d'accès obtenu\n");
    
    // Test de connexion
    const success = await testConnection(token);
    
    console.log("\n" + "=".repeat(50));
    if (success) {
      console.log("✅ Test de connexion terminé avec succès !");
      process.exit(0);
    } else {
      console.log("❌ Test de connexion échoué");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Erreur lors de l'authentification :");
    if (error.response) {
      console.error(`   Status : ${error.response.status}`);
      console.error(`   Message : ${error.response.data.error_description || error.response.data.message || JSON.stringify(error.response.data)}`);
    } else {
      console.error(`   ${error.message}`);
    }
    console.error("\n💡 Vérifiez vos identifiants dans le fichier .env");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Erreur fatale :", err.message);
  process.exit(1);
});


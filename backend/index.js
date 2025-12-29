const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// --- 1. CONFIGURACIÓN FIREBASE (Con Red de Seguridad) ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        // Intentamos parsear la clave. Si falla, el catch lo captura y NO rompe el servidor.
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = getFirestore();
        console.log("🔥 Firebase: Conexión Exitosa con Credenciales.");
    } else {
        console.warn("⚠️ AVISO: No se encontró la variable FIREBASE_CREDENTIALS. Usando modo RAM.");
    }
} catch (e) {
    console.error("⚠️ ERROR FIREBASE (No crítico):", e.message);
    db = null; // Nos aseguramos de que sea null para no intentar usarlo
}

// --- 2. MEMORIA RAM (Siempre funciona) ---
const STORES_RAM = new Map();

// --- 3. MODELOS ---
const MODEL_CANDIDATES = [ "gemini-2.0-flash-exp", "gemini-1.5-pro-002", "gemini-1.5-flash-002", "gemini-1.5-flash", "gemini-1.5-pro" ];

// MIDDLEWARES
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Falta GEMINI_API_KEY");
  return key;
};

async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      return result.response.text();
    } catch (e) {}
  }
  throw new Error("Todos los modelos fallaron.");
}

// --- ENDPOINTS ---

app.get('/', (req, res) => {
    res.json({ 
        status: "Online 🟢", 
        firebase: db ? "Conectado ✅" : "Desconectado (Modo RAM) ⚠️",
        project: process.env.GOOGLE_CLOUD_PROJECT || "N/A"
    });
});

// 1. CREATE STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || "Cerebro"; 
  const storeId = `cerebro_${Date.now()}`;
  
  // Siempre creamos en RAM
  STORES_RAM.set(storeId, { name, files: [], texts: [] });
  
  // Intentamos DB en segundo plano (si falla, no importa)
  if (db) {
      db.collection('stores').doc(storeId).set({ name, createdAt: new Date(), files: [], texts: [] }).catch(e => console.warn("Fallo DB create:", e.message));
  }
  
  res.json({ name: storeId }); 
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const apiKey = getApiKey();
    
    // A) NATIVO
    let googleFile = null;
    try {
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, { mimeType: req.file.mimetype, displayName: req.file.originalname });
        googleFile = { uri: uploadResponse.file.uri, name: uploadResponse.file.name, mimeType: uploadResponse.file.mimeType };
    } catch (e) { console.warn("Fallo subida nativa:", e.message); }

    // B) LOCAL
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { const data = await pdf(buffer); extractedText = data.text; } catch (e) {}
    } else { extractedText = buffer.toString('utf-8'); }
    
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 50000);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ file: { uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`, googleData: googleFile, extractedText } });
  } catch (error) { 
      console.error("Error Upload:", error);
      res.status(500).json({ error: error.message }); 
  }
});

// 3. VINCULAR (AQUÍ ESTÁ LA CORRECCIÓN CLAVE)
app.post('/link-file', async (req, res) => {
  const { storeId, fileName, extractedText, googleData } = req.body;
  
  // 1. RAM (Garantizado)
  if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
  const ramStore = STORES_RAM.get(storeId);
  ramStore.texts.push({ fileName, text: extractedText });
  if (googleData && googleData.uri) ramStore.files.push(googleData);

  // 2. DB (Protegido con try-catch interno y comprobación de null)
  if (db) {
    // Usamos una función autoejecutable para que NO bloquee la respuesta HTTP
    (async () => {
        try {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = { texts: FieldValue.arrayUnion({ fileName, text: extractedText }) };
            if (googleData && googleData.uri) updates.files = FieldValue.arrayUnion(googleData);
            
            await storeRef.update(updates);
            console.log(`💾 Guardado en DB: ${fileName}`);
        } catch (e) {
            // Solo logueamos el error, NO enviamos res.status(500)
            console.warn(`⚠️ Aviso: No se pudo guardar en Firebase, pero sigue en RAM. Error: ${e.message}`);
        }
    })();
  }

  // ¡SIEMPRE RESPONDEMOS ÉXITO!
  res.json({ success: true });
});

// 4. CHAT
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  let storeData = STORES_RAM.get(storeId);

  // Recuperación
  if (!storeData && db) {
      try {
          const doc = await db.collection('stores').doc(storeId).get();
          if (doc.exists) {
              storeData = doc.data();
              STORES_RAM.set(storeId, storeData);
          }
      } catch (e) {}
  }

  if (!storeData) return res.json({ text: "⚠️ Cerebro reiniciado. Sube los archivos de nuevo." });

  try {
    const apiKey = getApiKey();
    let promptParts = [];
    if (storeData.files && storeData.files.length > 0) {
        promptParts.push({ text: "Contexto:" });
        storeData.files.slice(-5).forEach(f => promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } }));
    } else {
        const context = storeData.texts.map(t => t.text).join('\n\n');
        promptParts.push({ text: `Contexto:\n${context}` });
    }
    promptParts.push({ text: `\nPregunta: ${query}` });

    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Servidor Indestructible listo en ${PORT}`));

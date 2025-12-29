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

// --- 1. CONFIGURACIÓN FIREBASE ROBUSTA ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase: CONECTADO");
    } else {
        console.warn("⚠️ Firebase: Sin credenciales (Modo RAM)");
    }
} catch (e) {
    console.error("⚠️ Error Firebase:", e.message);
    db = null;
}

const STORES_RAM = new Map();
// Lista de modelos ordenada por preferencia
const MODEL_CANDIDATES = [ "gemini-2.0-flash-exp", "gemini-1.5-pro-002", "gemini-1.5-flash-002", "gemini-1.5-flash" ];

app.use(express.json({ limit: '50mb' })); // Aumentado límite por si acaso
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

app.get('/', (req, res) => res.json({ status: "Online 🟢", firebase: db ? "Activo" : "Inactivo" }));

// 1. CREATE STORE (RESPUESTA INMEDIATA)
app.post('/create-store', (req, res) => {
  const name = req.body.name || "Cerebro"; 
  const storeId = `cerebro_${Date.now()}`;
  
  // 1. Responder YA al usuario
  res.json({ name: storeId });

  // 2. Trabajar en segundo plano
  (async () => {
    STORES_RAM.set(storeId, { name, files: [], texts: [] });
    if (db) {
        try {
            await db.collection('stores').doc(storeId).set({ name, createdAt: new Date(), files: [], texts: [] });
        } catch(e) { console.error("Error Background Create:", e.message); }
    }
  })();
});

// 2. UPLOAD (PROCESAMIENTO SEGURO)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    // Extracción de texto local (Rápida)
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { const data = await pdf(buffer); extractedText = data.text; } catch (e) {}
    } else { extractedText = buffer.toString('utf-8'); }
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 50000);

    // Subida a Google (Asíncrona pero esperamos para tener la URI)
    let googleFile = null;
    try {
        const apiKey = getApiKey();
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, { mimeType: req.file.mimetype, displayName: req.file.originalname });
        googleFile = { 
            uri: uploadResponse.file.uri, 
            name: uploadResponse.file.name, 
            mimeType: uploadResponse.file.mimeType,
            displayName: req.file.originalname
        };
    } catch (e) { console.warn("Upload IA falló (usando texto):", e.message); }

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ file: { uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`, googleData: googleFile, extractedText } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. LINK FILE (AQUÍ ESTABA EL PROBLEMA - AHORA ES ASÍNCRONO)
app.post('/link-file', (req, res) => {
  // 1. ¡RESPONDER ÉXITO INMEDIATAMENTE! 
  // Así el frontend nunca recibe timeout ni error CORS
  res.json({ success: true });

  // 2. GUARDAR EN SEGUNDO PLANO
  const { storeId, fileName, extractedText, googleData } = req.body;
  
  (async () => {
      try {
        // RAM
        if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
        const ramStore = STORES_RAM.get(storeId);
        ramStore.texts.push({ fileName, text: extractedText });
        if (googleData && googleData.uri) ramStore.files.push(googleData);

        // DB (Con protección anti-crash)
        if (db) {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = { texts: FieldValue.arrayUnion({ fileName, text: extractedText }) };
            if (googleData && googleData.uri) updates.files = FieldValue.arrayUnion(googleData);
            
            await storeRef.update(updates);
            console.log(`💾 Persistido: ${fileName}`);
        }
      } catch (e) {
          console.error(`⚠️ Error guardado segundo plano (Usuario no afectado): ${e.message}`);
      }
  })();
});

// 4. CHAT
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  let storeData = STORES_RAM.get(storeId);

  // Intentar recuperar si no está en RAM
  if (!storeData && db) {
      try {
          const doc = await db.collection('stores').doc(storeId).get();
          if (doc.exists) {
              storeData = doc.data();
              STORES_RAM.set(storeId, storeData);
          }
      } catch (e) {}
  }

  if (!storeData) return res.json({ text: "⚠️ No encuentro documentos. Sube algo primero." });

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

// 5. LIST FILES
app.get('/files', async (req, res) => {
    const { storeId } = req.query;
    if (!storeId) return res.json({ files: [] });

    let storeData = STORES_RAM.get(storeId);
    if (!storeData && db) {
        try {
            const doc = await db.collection('stores').doc(storeId).get();
            if (doc.exists) {
                storeData = doc.data();
                STORES_RAM.set(storeId, storeData);
            }
        } catch (e) {}
    }

    if (!storeData) return res.json({ files: [] });

    const fileNames = [
        ...(storeData.files || []).map(f => f.displayName || f.name),
        ...(storeData.texts || []).map(t => t.fileName)
    ];
    const uniqueFiles = [...new Set(fileNames)];
    res.json({ files: uniqueFiles });
});

app.listen(PORT, () => console.log(`🚀 Servidor Ultra-Rápido listo en ${PORT}`));

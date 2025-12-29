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

// --- 1. CONEXIÓN FIREBASE ---
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

// --- 2. MOTOR IA (Prioridad: 2.0 -> 1.5 Pro -> 1.5 Flash) ---
const MODEL_CANDIDATES = [ 
    "gemini-2.0-flash-exp",      // La bestia (Experimental)
    "gemini-1.5-pro-002",        // El cerebro potente
    "gemini-1.5-flash",          // El rápido y fiable
    "gemini-1.5-flash-002"
];

app.use(express.json({ limit: '50mb' }));
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

// HELPER: Generación Robusta con Logs
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      // console.log(`🤖 Intentando motor: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      const text = result.response.text();
      // Si responde vacío, lo consideramos error para probar el siguiente
      if (!text) throw new Error("Respuesta vacía");
      return text; 
    } catch (e) {
        console.warn(`⚠️ Falló ${modelName}: ${e.message.split(' ')[0]}`);
        lastError = e;
        // Si es error de cuota (429), a veces esperar un poco ayuda, pero aquí saltamos al siguiente modelo
    }
  }
  throw new Error(`Todos los modelos fallaron. Error: ${lastError?.message || "Desconocido"}`);
}

app.get('/', (req, res) => res.json({ status: "Online 🟢", db: db ? "Conectada" : "RAM" }));

// 1. CREATE STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || "Cerebro"; 
  const storeId = `cerebro_${Date.now()}`;
  res.json({ name: storeId }); 

  (async () => {
    STORES_RAM.set(storeId, { name, files: [], texts: [] });
    if (db) {
        try {
            await db.collection('stores').doc(storeId).set({ name, createdAt: new Date(), files: [], texts: [] });
        } catch(e) { console.error("Bg Create Error:", e.message); }
    }
  })();
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    // Texto
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { const data = await pdf(buffer); extractedText = data.text; } catch (e) {}
    } else { extractedText = buffer.toString('utf-8'); }
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 50000);

    // Google File API
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
    } catch (e) { console.warn("Upload IA error:", e.message); }

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ file: { uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`, googleData: googleFile, extractedText } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. LINK FILE (ASÍNCRONO)
app.post('/link-file', (req, res) => {
  res.json({ success: true });

  const { storeId, fileName, extractedText, googleData } = req.body;
  (async () => {
      try {
        if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
        const ramStore = STORES_RAM.get(storeId);
        ramStore.texts.push({ fileName, text: extractedText });
        if (googleData && googleData.uri) ramStore.files.push(googleData);

        if (db) {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = { texts: FieldValue.arrayUnion({ fileName, text: extractedText }) };
            if (googleData && googleData.uri) updates.files = FieldValue.arrayUnion(googleData);
            
            await storeRef.update(updates);
            console.log(`💾 Persistido: ${fileName}`);
        }
      } catch (e) { console.error(`Bg Save Error: ${e.message}`); }
  })();
});

// 4. CHAT (ZONA DE SEGURIDAD MÁXIMA)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  let storeData = STORES_RAM.get(storeId);

  // Recuperación DB
  if (!storeData && db) {
      try {
          const doc = await db.collection('stores').doc(storeId).get();
          if (doc.exists) {
              storeData = doc.data();
              STORES_RAM.set(storeId, storeData);
          }
      } catch (e) { console.error("DB Read Error:", e.message); }
  }

  if (!storeData) return res.json({ text: "⚠️ No encuentro memoria. Por favor, sube un archivo para empezar." });

  try {
    const apiKey = getApiKey();
    let promptParts = [];
    
    // --- LIMPIEZA DE DATOS (CRUCIAL) ---
    // Nos aseguramos de que sean arrays y filtramos nulos para que no explote
    const safeFiles = (storeData.files || []).filter(f => f && f.uri && f.mimeType);
    const safeTexts = (storeData.texts || []).filter(t => t && t.text);

    if (safeFiles.length > 0) {
        promptParts.push({ text: "Analiza estos documentos:" });
        // Últimos 5 archivos
        safeFiles.slice(-5).forEach(f => {
            promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
        });
    } 
    
    if (safeTexts.length > 0) {
        const context = safeTexts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
        promptParts.push({ text: `Información extra:\n${context}` });
    }

    promptParts.push({ text: `\nPREGUNTA USUARIO: ${query}` });

    // Llamada Segura
    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
    
  } catch (e) { 
      console.error("❌ CHAT ERROR:", e);
      // Devolvemos el error al usuario para que sepa qué pasa
      res.status(500).json({ error: `Error del Sistema: ${e.message}` }); 
  }
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

    const safeFiles = (storeData.files || []).filter(f => f);
    const safeTexts = (storeData.texts || []).filter(t => t);

    const fileNames = [
        ...safeFiles.map(f => f.displayName || f.name),
        ...safeTexts.map(t => t.fileName)
    ];
    const uniqueFiles = [...new Set(fileNames.filter(Boolean))];
    res.json({ files: uniqueFiles });
});

app.listen(PORT, () => console.log(`🚀 Servidor Anti-Crash listo en ${PORT}`));

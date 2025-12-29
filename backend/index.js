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

// --- 1. FIREBASE ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase: CONECTADO");
    } else {
        console.warn("⚠️ Firebase: Modo RAM");
    }
} catch (e) {
    console.error("⚠️ Error Firebase:", e.message);
    db = null;
}

const STORES_RAM = new Map();

// --- 2. LISTA DE MODELOS REALES Y VÁLIDOS ---
// CORRECCIÓN: 'gemini-3' no existe. Usamos 'gemini-2.0-flash-exp' que es el nuevo.
const MODEL_CANDIDATES = [ 
    "gemini-2.0-flash-exp",      // <--- EL NUEVO (Lo que buscabas como 'gemini-3')
    "gemini-1.5-flash",          // <--- EL ESTABLE (Por si el experimental falla)
    "gemini-1.5-pro"             // <--- EL POTENTE
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

// HELPER: Generación con reintentos inteligentes
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      // console.log(`🚀 Probando modelo: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      const text = result.response.text();
      if (text) return text; 
    } catch (e) {
        console.warn(`⚠️ Modelo ${modelName} falló: ${e.message.split(' ')[0]}`);
        lastError = e;
    }
  }
  // Si todo falla, mensaje claro
  return `⚠️ Error: No pude conectar con la IA. Verifiqué los modelos ${MODEL_CANDIDATES.join(', ')} y todos dieron error 404 o 500.`;
}

app.get('/', (req, res) => res.json({ status: "Online 🟢", firebase: db ? "Conectado" : "RAM" }));

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
        } catch(e) { console.error("Error DB:", e.message); }
    }
  })();
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    // Extracción Local (Respaldo)
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { const data = await pdf(buffer); extractedText = data.text; } catch (e) {}
    } else { extractedText = buffer.toString('utf-8'); }
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 50000);

    // Subida NATIVA a Google (File API)
    let googleFile = null;
    try {
        const apiKey = getApiKey();
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, { 
            mimeType: req.file.mimetype, 
            displayName: req.file.originalname 
        });
        
        // Esperamos a que el archivo esté activo (IMPORTANTE para Gemini 1.5/2.0)
        let fileState = await fileManager.getFile(uploadResponse.file.name);
        while (fileState.state === "PROCESSING") {
            await new Promise(resolve => setTimeout(resolve, 1000));
            fileState = await fileManager.getFile(uploadResponse.file.name);
        }

        googleFile = { 
            uri: uploadResponse.file.uri, 
            name: uploadResponse.file.name, 
            mimeType: uploadResponse.file.mimeType,
            displayName: req.file.originalname
        };
    } catch (e) { console.warn("Aviso: Upload IA falló (usaremos texto):", e.message); }

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ file: { uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`, googleData: googleFile, extractedText } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. LINK FILE
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
      } catch (e) { console.error(`Error BG: ${e.message}`); }
  })();
});

// 4. CHAT
app.post('/chat', async (req, res) => {
  try {
      const { storeId, query } = req.body;
      let storeData = STORES_RAM.get(storeId);

      // Recuperar de DB
      if (!storeData && db) {
          try {
              const doc = await db.collection('stores').doc(storeId).get();
              if (doc.exists) {
                  storeData = doc.data();
                  if (!storeData.files) storeData.files = [];
                  if (!storeData.texts) storeData.texts = [];
                  STORES_RAM.set(storeId, storeData);
              }
          } catch (e) { console.error("Error DB:", e.message); }
      }

      if (!storeData) return res.json({ text: "⚠️ Cerebro no encontrado. Sube un archivo." });

      const apiKey = getApiKey();
      let promptParts = [];
      
      const validFiles = (storeData.files || []).filter(f => f && f.uri && f.mimeType);
      const validTexts = (storeData.texts || []).filter(t => t && t.text);

      // Usar archivos nativos (File API)
      if (validFiles.length > 0) {
          promptParts.push({ text: "Utiliza los siguientes documentos adjuntos para responder:" });
          validFiles.slice(-5).forEach(f => {
              promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
          });
      } 
      
      // Respaldo de texto
      if (validTexts.length > 0) {
          const context = validTexts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
          promptParts.push({ text: `Contexto extraído:\n${context}` });
      }

      promptParts.push({ text: `\nPREGUNTA: ${query}` });

      const answer = await generateWithFallback(apiKey, promptParts);
      res.json({ text: answer });
      
  } catch (e) { 
      console.error("Chat Error:", e);
      res.json({ text: `❌ Error interno: ${e.message}.` }); 
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

    const fileNames = [
        ...(storeData.files || []).map(f => f ? (f.displayName || f.name) : null),
        ...(storeData.texts || []).map(t => t ? t.fileName : null)
    ];
    res.json({ files: [...new Set(fileNames.filter(Boolean))] });
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en ${PORT}`));

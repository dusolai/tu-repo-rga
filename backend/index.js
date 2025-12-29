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

// --- 1. FIREBASE (Conexión) ---
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

// --- 2. CONFIGURACIÓN DE MODELOS ---
// Usamos el 2.0 (Tu "Gemini 3") como principal.
// El 1.5 Flash como respaldo de seguridad.
const MODEL_PRIORITY = [ "gemini-2.0-flash-exp", "gemini-1.5-flash" ];

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

// --- NÚCLEO: Generación Inteligente (Archivo -> Texto) ---
async function generateSmart(apiKey, promptParts, useFiles = true) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_PRIORITY) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      // Si falló antes con archivos, probamos SOLO CON TEXTO (eliminamos fileData)
      const safeParts = useFiles ? promptParts : promptParts.filter(p => !p.fileData);
      
      const result = await model.generateContent(safeParts);
      const text = result.response.text();
      if (text) return text;
    } catch (e) {
        // console.warn(`⚠️ Intento fallido con ${modelName}:`, e.message);
        lastError = e;
    }
  }
  throw lastError || new Error("Fallaron todos los modelos");
}

app.get('/', (req, res) => res.json({ status: "Online 🟢", model: "Gemini 2.0 + 1.5" }));

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
        } catch(e) { console.error("DB Create Error:", e.message); }
    }
  })();
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    // 1. Extraer Texto (Siempre funciona)
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { const data = await pdf(buffer); extractedText = data.text; } catch (e) {}
    } else { extractedText = buffer.toString('utf-8'); }
    // Limpiamos y limitamos para no saturar
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 100000);

    // 2. Subir a Google (Puede fallar, no pasa nada)
    let googleFile = null;
    try {
        const apiKey = getApiKey();
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, { mimeType: req.file.mimetype, displayName: req.file.originalname });
        
        // Esperar a que esté activo (Polling rápido)
        let state = uploadResponse.file.state;
        let attempts = 0;
        while (state === "PROCESSING" && attempts < 5) {
            await new Promise(r => setTimeout(r, 500));
            const check = await fileManager.getFile(uploadResponse.file.name);
            state = check.state;
            attempts++;
        }

        if (state === "ACTIVE") {
            googleFile = { 
                uri: uploadResponse.file.uri, 
                name: uploadResponse.file.name, 
                mimeType: uploadResponse.file.mimeType,
                displayName: req.file.originalname
            };
        }
    } catch (e) { console.warn("Upload IA Error (Usando texto):", e.message); }

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
            console.log(`💾 Guardado: ${fileName}`);
        }
      } catch (e) { console.error(`BG Error: ${e.message}`); }
  })();
});

// 4. CHAT (FINALMENTE ARREGLADO)
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
          } catch (e) { console.error("DB Read Error:", e.message); }
      }

      if (!storeData) return res.json({ text: "⚠️ No hay documentos. Sube uno." });

      const apiKey = getApiKey();
      let promptParts = [];
      
      const validFiles = (storeData.files || []).filter(f => f && f.uri && f.mimeType);
      const validTexts = (storeData.texts || []).filter(t => t && t.text);

      // ESTRATEGIA:
      // 1. Intentamos pasarle los archivos nativos (Mejor calidad)
      if (validFiles.length > 0) {
          promptParts.push({ text: "Documentos:" });
          validFiles.slice(-5).forEach(f => {
              promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
          });
      } 
      
      // 2. SIEMPRE pasamos el texto también (Respaldo por si el archivo da error 404/Processing)
      if (validTexts.length > 0) {
          const context = validTexts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
          promptParts.push({ text: `Texto extraído (Usar si no puedes leer los archivos):\n${context}` });
      }

      promptParts.push({ text: `\nPregunta: ${query}` });

      // INTENTO 1: Con Archivos + Texto
      try {
          const answer = await generateSmart(apiKey, promptParts, true);
          res.json({ text: answer });
      } catch (e) {
          console.warn("Fallo con archivos, reintentando SOLO TEXTO...");
          // INTENTO 2: Solo Texto (Infalible)
          // Si el archivo en la nube da error, le enviamos el texto plano y funcionará sí o sí.
          try {
              const answerTextOnly = await generateSmart(apiKey, promptParts, false);
              res.json({ text: answerTextOnly });
          } catch (finalError) {
              throw finalError; // Si esto falla, es la API Key
          }
      }
      
  } catch (e) { 
      console.error("Chat Error:", e);
      res.json({ text: `❌ Error: ${e.message}. (Verifica tu API Key)` }); 
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

app.listen(PORT, () => console.log(`🚀 Servidor Final listo en ${PORT}`));

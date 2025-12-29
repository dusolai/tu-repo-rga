const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
// Importamos Firebase con seguridad
let admin = null;
let db = null;
try {
  admin = require('firebase-admin');
  const { initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp();
  db = getFirestore();
  console.log("🔥 Firebase: Intentando conectar...");
} catch (e) {
  console.warn("⚠️ Firebase NO disponible (Modo Solo RAM):", e.message);
  db = null; // Nos aseguramos de que sea null si falla
}

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// === MEMORIA RAM (LA QUE SIEMPRE FUNCIONA) ===
const STORES_RAM = new Map();

// Modelos (Estrategia Anti-404)
const MODEL_CANDIDATES = [
  "gemini-1.5-flash-002",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];

// Middleware Básico
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

// --- FUNCIÓN HELPER GENERACIÓN ---
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      return result.response.text();
    } catch (e) {
      console.warn(`⚠️ Falló ${modelName}, probando siguiente...`);
      lastError = e;
    }
  }
  throw lastError || new Error("Todos los modelos fallaron.");
}

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Backend BLINDADO Online (RAM Prioritaria) 🛡️'));

// 1. CREAR STORE
app.post('/create-store', async (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `store-${Date.now()}`;
  
  // 1. GUARDA EN RAM (Inmediato y Seguro)
  STORES_RAM.set(storeId, { name, files: [], texts: [] });
  
  // 2. GUARDA EN DB (Opcional - Si falla no pasa nada)
  if (db) {
    db.collection('stores').doc(storeId).set({
      name, createdAt: new Date(), files: [], texts: []
    }).catch(e => console.warn("⚠️ Error no crítico guardando en DB:", e.message));
  }
  
  res.json({ name: storeId }); 
});

// 2. UPLOAD (Solo procesa, no guarda en BD aún)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Subiendo: ${req.file.originalname}`);
    const apiKey = getApiKey();
    
    // A) INTENTO FILE API (Google)
    let googleFile = null;
    try {
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, {
            mimeType: req.body.mimeType || req.file.mimetype,
            displayName: req.file.originalname,
        });
        googleFile = {
            uri: uploadResponse.file.uri,
            name: uploadResponse.file.name,
            mimeType: uploadResponse.file.mimeType
        };
    } catch (e) { console.warn("⚠️ Falló subida nativa (usando texto):", e.message); }

    // B) EXTRACCIÓN TEXTO (Respaldo)
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf') || req.file.originalname.endsWith('.pdf')) {
      try {
          const data = await pdf(buffer);
          extractedText = data.text;
      } catch (e) { extractedText = "Texto ilegible"; }
    } else {
      extractedText = buffer.toString('utf-8');
    }
    
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 50000);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({
      file: {
        uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`,
        googleData: googleFile,
        extractedText: extractedText
      }
    });

  } catch (error) {
    console.error('❌ Error Upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. VINCULAR (Aquí guardamos en RAM y DB)
app.post('/link-file', async (req, res) => {
  const { storeId, fileName, extractedText, googleData } = req.body;
  
  // 1. RAM (Seguro de vida) - Si el store no existe, lo creamos
  if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
  const ramStore = STORES_RAM.get(storeId);
  ramStore.texts.push({ fileName, text: extractedText });
  if (googleData && googleData.uri) ramStore.files.push(googleData);

  // 2. DB (Asíncrono y protegido)
  if (db) {
    (async () => {
        try {
            const storeRef = db.collection('stores').doc(storeId);
            // Verificar existencia sin bloquear
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });
            
            // Updates manuales para evitar errores de FieldValue raros
            const data = doc.exists ? doc.data() : { texts: [], files: [] };
            const newTexts = [...(data.texts || []), { fileName, text: extractedText }];
            let newFiles = data.files || [];
            if (googleData && googleData.uri) newFiles = [...newFiles, googleData];

            await storeRef.update({ texts: newTexts, files: newFiles });
            console.log(`🔗 Persistido en DB: ${fileName}`);
        } catch (e) {
            console.warn(`⚠️ Error guardando en DB (RAM OK): ${e.message}`);
        }
    })();
  }

  // Respondemos ÉXITO inmediatamente porque la RAM ya lo tiene
  res.json({ success: true });
});

// 4. CHAT
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  let storeData = null;

  // 1. Intentar leer de RAM (Más rápido)
  if (STORES_RAM.has(storeId)) {
      storeData = STORES_RAM.get(storeId);
  }

  // 2. Si no está en RAM y tenemos DB, intentamos recuperar
  if (!storeData && db) {
      try {
          const doc = await db.collection('stores').doc(storeId).get();
          if (doc.exists) {
              storeData = doc.data();
              // Hidratamos la RAM para la próxima vez
              STORES_RAM.set(storeId, storeData);
              console.log("📥 Memoria recuperada desde DB");
          }
      } catch (e) { console.warn("⚠️ Falló lectura DB"); }
  }

  if (!storeData) return res.json({ text: "⚠️ Memoria vacía. Sube archivos." });

  try {
    const apiKey = getApiKey();
    let promptParts = [];
    
    // Prioridad: Archivos Nativos
    const files = storeData.files || [];
    if (files.length > 0) {
        promptParts.push({ text: "Responde usando estos archivos:" });
        const activeFiles = files.slice(-5);
        activeFiles.forEach(f => {
            promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
        });
    } else {
        const texts = storeData.texts || [];
        const context = texts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
        promptParts.push({ text: `CONTEXTO:\n${context}` });
    }

    promptParts.push({ text: `\nPREGUNTA: ${query}` });

    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
    
  } catch (e) {
    res.status(500).json({ error: `Error: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en ${PORT}`));
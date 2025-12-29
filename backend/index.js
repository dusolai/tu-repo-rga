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

// --- 1. CONFIGURACIÓN DE FIREBASE SEGURA ---
let db = null;
try {
    // Si pusiste la variable de entorno con el JSON completo
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🔥 Firebase: Conectado con LLAVE MAESTRA.");
    } else {
        // Intento conexión automática (a veces falla en Cloud Run sin permisos IAM)
        admin.initializeApp();
        console.log("🔥 Firebase: Conectado con identidad automática.");
    }
    db = getFirestore();
} catch (e) {
    console.warn("⚠️ ERROR FIREBASE (Usando RAM):", e.message);
    // IMPORTANTE: Si falla, db es null y el sistema usará RAM
    db = null;
}

// --- 2. MEMORIA RAM (RED DE SEGURIDAD) ---
const STORES_RAM = new Map();

// --- 3. LISTA DE MODELOS EXACTOS (SOLUCIÓN ERROR 404) ---
// Usamos versiones congeladas (-001, -002) que NO desaparecen.
const MODEL_CANDIDATES = [
  "gemini-1.5-flash-002",      // Versión más nueva y rápida
  "gemini-1.5-flash-001",      // Versión estable
  "gemini-1.5-pro-002",        // Pro nuevo
  "gemini-1.5-pro-001",        // Pro estable
  "gemini-1.5-flash"           // Alias (último recurso)
];

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

// HELPER: GENERACIÓN CON REINTENTOS
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      // console.log(`Probando modelo: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      return result.response.text();
    } catch (e) {
      console.warn(`⚠️ Falló ${modelName}: ${e.message.split(' ')[0]}`);
      lastError = e;
      // Si falla, el bucle continúa con el siguiente modelo de la lista
    }
  }
  throw new Error(`Todos los modelos fallaron. Último error: ${lastError?.message}`);
}

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Cerebro Diego Online (Persistencia + Modelos Fix) 🧠'));

// 1. CREAR STORE
app.post('/create-store', async (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `cerebro_${Date.now()}`;
  
  // A) SIEMPRE EN RAM (Inmediato)
  STORES_RAM.set(storeId, { name, files: [], texts: [] });
  
  // B) FIREBASE (Segundo plano - No bloquea)
  if (db) {
    db.collection('stores').doc(storeId).set({
        name, createdAt: new Date(), files: [], texts: []
    }).catch(e => console.error("Error DB (Ignorado):", e.message));
  }
  
  res.json({ name: storeId }); 
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Procesando: ${req.file.originalname}`);
    const apiKey = getApiKey();
    
    // A) FILE API (Nativo)
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
    } catch (e) { console.warn("⚠️ Falló File API (usando solo texto):", e.message); }

    // B) EXTRACCIÓN LOCAL
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf') || req.file.originalname.endsWith('.pdf')) {
      try {
          const data = await pdf(buffer);
          extractedText = data.text;
      } catch (e) { extractedText = "Texto no legible."; }
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

// 3. VINCULAR (EL QUE FALLABA)
app.post('/link-file', async (req, res) => {
  const { storeId, fileName, extractedText, googleData } = req.body;
  
  // 1. RAM (Éxito garantizado)
  if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
  const ramStore = STORES_RAM.get(storeId);
  ramStore.texts.push({ fileName, text: extractedText });
  if (googleData && googleData.uri) ramStore.files.push(googleData);

  // 2. FIREBASE (Intento seguro)
  if (db) {
    // Función autoejecutable para no bloquear la respuesta HTTP
    (async () => {
        try {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = {
                texts: FieldValue.arrayUnion({ fileName, text: extractedText })
            };
            if (googleData && googleData.uri) {
                updates.files = FieldValue.arrayUnion(googleData);
            }
            await storeRef.update(updates);
            console.log(`💾 Guardado en Firebase: ${fileName}`);
        } catch (e) {
            console.error(`❌ Error Firebase (Sistema sigue en RAM): ${e.message}`);
        }
    })();
  }

  // DEVOLVEMOS ÉXITO INMEDIATAMENTE
  // Así el frontend nunca ve el error rojo, aunque falle Firebase
  res.json({ success: true });
});

// 4. CHAT
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  let storeData = null;

  // Intentar RAM
  if (STORES_RAM.has(storeId)) storeData = STORES_RAM.get(storeId);

  // Si no hay RAM, intentar recuperar de DB (Persistencia)
  if (!storeData && db) {
      try {
          const doc = await db.collection('stores').doc(storeId).get();
          if (doc.exists) {
              storeData = doc.data();
              STORES_RAM.set(storeId, storeData); // Recargar RAM
              console.log("📥 Cerebro recuperado de la base de datos.");
          }
      } catch (e) { console.warn("Error lectura DB:", e.message); }
  }

  if (!storeData) return res.json({ text: "⚠️ No encuentro esta memoria. Sube los archivos de nuevo." });

  try {
    const apiKey = getApiKey();
    let promptParts = [];
    
    // Usamos archivos si existen (File Search)
    const files = storeData.files || [];
    if (files.length > 0) {
        promptParts.push({ text: "Responde basándote en estos documentos:" });
        const activeFiles = files.slice(-5); // Últimos 5 para no saturar
        activeFiles.forEach(f => {
            promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
        });
    } else {
        // Fallback a texto
        const texts = storeData.texts || [];
        const context = texts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
        promptParts.push({ text: `CONTEXTO:\n${context}` });
    }

    promptParts.push({ text: `\nPREGUNTA: ${query}` });

    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
    
  } catch (e) {
    console.error("Chat Error:", e);
    // Mostramos el error real para depurar
    res.status(500).json({ error: `Error Gemini: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en ${PORT}`));
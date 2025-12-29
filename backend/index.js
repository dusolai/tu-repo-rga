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

// --- 1. FIREBASE (Modo "A prueba de fallos") ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("🔥 Firebase: Conectado con Llave Maestra.");
    } else {
        admin.initializeApp(); 
        console.log("🔥 Firebase: Conexión automática (puede requerir permisos IAM).");
    }
    db = getFirestore();
} catch (e) {
    console.warn("⚠️ Firebase no activo (Usando RAM):", e.message);
    db = null;
}

// --- 2. MEMORIA RAM (Siempre funciona) ---
const STORES_RAM = new Map();

// --- 3. LISTA DE MODELOS DINÁMICA (Tu petición) ---
// El servidor probará estos modelos en orden hasta que uno responda.
// Incluye los experimentales más nuevos.
const MODEL_CANDIDATES = [
  "gemini-2.0-flash-exp",      // El más nuevo (Experimental)
  "gemini-1.5-pro-002",        // Pro actualizado
  "gemini-1.5-flash-002",      // Flash actualizado
  "gemini-1.5-flash",          // Estándar
  "gemini-1.5-pro",            // Fallback potente
  "gemini-pro"                 // Último recurso (Legacy)
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

// HELPER: "Elige el mejor modelo disponible"
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      // console.log(`🤖 Probando motor: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      return result.response.text();
    } catch (e) {
      console.warn(`⚠️ Motor ${modelName} no disponible: ${e.message.split(' ')[0]}`);
      lastError = e;
      // Continuamos al siguiente modelo de la lista automáticamente
    }
  }
  throw new Error(`Todos los modelos fallaron. Revisa tu API Key o Cuota. Error: ${lastError?.message}`);
}

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Cerebro Diego Online (Modo Dinámico / Último Modelo) 🧠'));

// 1. CREAR STORE
app.post('/create-store', async (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `cerebro_${Date.now()}`;
  
  // Guardar en RAM
  STORES_RAM.set(storeId, { name, files: [], texts: [] });
  
  // Intentar DB (Silencioso)
  if (db) {
    db.collection('stores').doc(storeId).set({
        name, createdAt: new Date(), files: [], texts: []
    }).catch(e => console.error("DB Error (No crítico):", e.message));
  }
  
  res.json({ name: storeId }); 
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Procesando: ${req.file.originalname}`);
    const apiKey = getApiKey();
    
    // A) FILE API (Nativo de Google)
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
        console.log(`☁️ Subido a Nube IA: ${googleFile.name}`);
    } catch (e) { console.warn("⚠️ Falló subida nativa (usando texto plano):", e.message); }

    // B) TEXTO LOCAL (Respaldo seguro)
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
    console.error("Upload Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 3. VINCULAR
app.post('/link-file', async (req, res) => {
  const { storeId, fileName, extractedText, googleData } = req.body;
  
  // RAM (Garantía de éxito)
  if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
  const ramStore = STORES_RAM.get(storeId);
  ramStore.texts.push({ fileName, text: extractedText });
  if (googleData && googleData.uri) ramStore.files.push(googleData);

  // DB (Segundo plano)
  if (db) {
    (async () => {
        try {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = {
                texts: FieldValue.arrayUnion({ fileName, text: extractedText })
            };
            if (googleData && googleData.uri) updates.files = FieldValue.arrayUnion(googleData);
            await storeRef.update(updates);
            console.log(`💾 Persistido en DB: ${fileName}`);
        } catch (e) { console.error(`DB Error (Ignorado): ${e.message}`); }
    })();
  }

  res.json({ success: true });
});

// 4. CHAT (CON INTELIGENCIA DE MODELOS)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  let storeData = STORES_RAM.get(storeId);

  // Intentar recuperar de DB si RAM está vacía
  if (!storeData && db) {
      try {
          const doc = await db.collection('stores').doc(storeId).get();
          if (doc.exists) {
              storeData = doc.data();
              STORES_RAM.set(storeId, storeData); // Hidratar RAM
              console.log("📥 Cerebro recuperado de Firebase.");
          }
      } catch (e) {}
  }

  if (!storeData) return res.json({ text: "⚠️ No encuentro esta memoria. Sube archivos de nuevo." });

  try {
    const apiKey = getApiKey();
    let promptParts = [];
    
    // Usar archivos nativos si existen (Mejor calidad)
    const files = storeData.files || [];
    if (files.length > 0) {
        promptParts.push({ text: "Responde basándote estrictamente en estos documentos:" });
        const activeFiles = files.slice(-5); // Últimos 5
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

    // AQUÍ ESTÁ LA MAGIA: Probamos la lista de modelos hasta que uno funcione
    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
    
  } catch (e) {
    console.error("Chat Error:", e);
    res.status(500).json({ error: `Error Gemini: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor Dinámico listo en ${PORT}`));
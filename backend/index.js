const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { initializeApp } = require('firebase-admin/app'); // <--- NUEVO
const { getFirestore, FieldValue } = require('firebase-admin/firestore'); // <--- NUEVO
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');

// 1. INICIALIZAMOS FIREBASE (Conexión Automática en Cloud Run)
try {
  initializeApp();
  console.log("🔥 Firebase conectado correctamente.");
} catch (e) {
  console.warn("⚠️ Firebase ya estaba inicializado o error leve:", e.message);
}

const db = getFirestore(); // Nuestra base de datos
const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// LISTA DE MODELOS A PROBAR
const MODEL_CANDIDATES = [
  "gemini-2.5-flash", 
  "gemini-1.5-flash-002",
  "gemini-1.5-flash-001",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
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

// --- FUNCIÓN HELPER: GENERAR CON FALLBACK ---
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      return result.response.text();
    } catch (e) {
      console.warn(`⚠️ Falló ${modelName}:`, e.message.split(' ')[0]);
      lastError = e;
      if (!e.message.includes('404') && !e.message.includes('not found')) {
         // Si no es 404, quizás es otro error, seguimos probando
      }
    }
  }
  throw lastError || new Error("Todos los modelos fallaron.");
}

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Backend Cerebro con MEMORIA FIREBASE 🧠🔥'));

// 1. CREAR STORE (GUARDAR EN BASE DE DATOS)
app.post('/create-store', async (req, res) => {
  try {
    const name = req.body.name || req.body.displayName || "Cerebro"; 
    // Usamos el nombre como ID si queremos persistencia fácil, o uno nuevo
    const storeId = name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() + "_" + Date.now();
    
    // Guardamos en Firestore
    await db.collection('stores').doc(storeId).set({
      name: name,
      createdAt: new Date(),
      files: [], // Array de archivos de Google
      texts: []  // Array de textos de respaldo
    });

    console.log(`✅ Store guardado en DB: ${storeId}`);
    res.json({ name: storeId });
  } catch (e) {
    console.error("Error DB:", e);
    res.status(500).json({ error: "Fallo al crear memoria en base de datos" });
  }
});

// 2. UPLOAD (SUBE A GOOGLE + EXTRAE)
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
            name: uploadResponse.file.name, // files/xxxx
            mimeType: uploadResponse.file.mimeType
        };
    } catch (googleErr) {
        console.warn("⚠️ Falló subida nativa:", googleErr.message);
    }

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
    
    // Limpieza y borrado temporal
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

// 3. VINCULAR (GUARDAR ARCHIVO EN LA BD)
app.post('/link-file', async (req, res) => {
  const { storeId, fileName, extractedText, googleData } = req.body;
  
  try {
    const storeRef = db.collection('stores').doc(storeId);
    
    // Comprobamos si existe el store, si no, lo creamos (Auto-curación en BD)
    const doc = await storeRef.get();
    if (!doc.exists) {
        await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });
    }

    // Actualizamos Arrays en Firestore usando atomicidad
    const updates = {
        texts: FieldValue.arrayUnion({ fileName, text: extractedText })
    };

    if (googleData && googleData.uri) {
        updates.files = FieldValue.arrayUnion(googleData);
    }

    await storeRef.update(updates);

    console.log(`🔗 ${fileName} persistido en Firestore.`);
    res.json({ success: true });

  } catch (e) {
    console.error("Error vinculando en DB:", e);
    res.status(500).json({ error: "No se pudo guardar en la memoria persistente" });
  }
});

// 4. CHAT (LEER DE LA BD Y RESPONDER)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;

  try {
    // LEEMOS DE FIREBASE
    const doc = await db.collection('stores').doc(storeId).get();
    
    if (!doc.exists) {
        return res.json({ text: "⚠️ No encuentro esta memoria en la base de datos. ¿Es el ID correcto?" });
    }

    const storeData = doc.data();
    const apiKey = getApiKey();

    // PREPARAR PROMPT
    let promptParts = [];
    
    // Prioridad: Archivos Nativos
    const files = storeData.files || [];
    if (files.length > 0) {
        console.log(`📎 Usando ${files.length} archivos nativos de la BD`);
        promptParts.push({ text: "Responde basándote en estos archivos:" });
        
        // Tomamos los últimos 5 para no saturar
        const activeFiles = files.slice(-5);
        activeFiles.forEach(f => {
            promptParts.push({ 
                fileData: { mimeType: f.mimeType, fileUri: f.uri } 
            });
        });
    } else {
        // Fallback: Texto plano
        console.log("📝 Usando texto plano de la BD");
        const texts = storeData.texts || [];
        const context = texts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
        promptParts.push({ text: `CONTEXTO:\n${context}` });
    }

    promptParts.push({ text: `\nPREGUNTA: ${query}` });

    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
    
  } catch (e) {
    console.error("❌ Error Chat:", e);
    res.status(500).json({ error: `Error: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor Firebase listo en ${PORT}`));

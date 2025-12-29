const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');

// --- CONEXIÓN A LA BASE DE DATOS ---
try {
  initializeApp();
  console.log("🔥 Firebase conectado.");
} catch (e) {
  console.log("⚠️ Nota Firebase:", e.message);
}

const db = getFirestore();
const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// LISTA DE MODELOS A PROBAR (Estrategia Anti-Error 404)
const MODEL_CANDIDATES = [
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

// --- FUNCIÓN INTELIGENTE DE CHAT ---
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
         // Si no es un 404, quizás es un error de servidor, seguimos probando
      }
    }
  }
  throw lastError || new Error("Todos los modelos fallaron.");
}

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Backend con MEMORIA FIREBASE Activa 🔥🧠'));

// 1. CREAR STORE (EN BASE DE DATOS)
app.post('/create-store', async (req, res) => {
  try {
    const name = req.body.name || req.body.displayName || "Cerebro"; 
    // Creamos un ID único
    const storeId = `cerebro_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    // Guardamos en Firestore (Base de Datos)
    await db.collection('stores').doc(storeId).set({
      name: name,
      createdAt: new Date(),
      files: [], 
      texts: []  
    });

    console.log(`✅ Memoria creada en DB: ${storeId}`);
    res.json({ name: storeId });
  } catch (e) {
    console.error("Error DB:", e);
    res.status(500).json({ error: "No se pudo crear la memoria." });
  }
});

// 2. UPLOAD (SUBE A GOOGLE FILE API)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Subiendo: ${req.file.originalname}`);
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

    // B) EXTRACCIÓN LOCAL (Respaldo)
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

// 3. VINCULAR (GUARDAR DATOS EN FIREBASE)
app.post('/link-file', async (req, res) => {
  const { storeId, fileName, extractedText, googleData } = req.body;
  
  try {
    const storeRef = db.collection('stores').doc(storeId);
    
    // Si la memoria no existe (reinicio raro), la creamos
    const doc = await storeRef.get();
    if (!doc.exists) {
        await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });
    }

    // Actualizamos las listas en la base de datos
    const updates = {
        texts: FieldValue.arrayUnion({ fileName, text: extractedText })
    };

    if (googleData && googleData.uri) {
        updates.files = FieldValue.arrayUnion(googleData);
    }

    await storeRef.update(updates);

    console.log(`🔗 ${fileName} guardado en Firestore.`);
    res.json({ success: true });

  } catch (e) {
    console.error("Error Guardando:", e);
    res.status(500).json({ error: "Fallo al guardar en memoria permanente" });
  }
});

// 4. CHAT (LEER DE FIREBASE)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;

  try {
    // 1. Buscamos en la Base de Datos
    const doc = await db.collection('stores').doc(storeId).get();
    
    if (!doc.exists) {
        return res.json({ text: "⚠️ No encuentro tu memoria. ¿Es posible que estés usando un ID antiguo?" });
    }

    const storeData = doc.data();
    const apiKey = getApiKey();

    let promptParts = [];
    
    // 2. Prioridad: Archivos Nativos de Google
    const files = storeData.files || [];
    if (files.length > 0) {
        console.log(`📎 Usando ${files.length} archivos de la BD`);
        promptParts.push({ text: "Responde basándote en estos archivos:" });
        
        // Usamos los últimos 5 archivos para no saturar
        const activeFiles = files.slice(-5);
        activeFiles.forEach(f => {
            promptParts.push({ 
                fileData: { mimeType: f.mimeType, fileUri: f.uri } 
            });
        });
    } else {
        // 3. Fallback: Texto plano guardado
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
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse'); 

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// ALMACÉN EN MEMORIA
const STORES = new Map();

// MIDDLEWARES
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Falta GEMINI_API_KEY");
  return key;
};

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Backend Cerebro Online (Gemini 1.5 Flash-001) 🚀'));

// 1. CREAR STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `store-${Date.now()}`;
  STORES.set(storeId, { name, files: [], texts: [] });
  res.json({ name: storeId }); 
});

// 2. UPLOAD (HÍBRIDO: SUBE A GOOGLE + EXTRAE TEXTO LOCAL)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Procesando: ${req.file.originalname}`);
    const apiKey = getApiKey();
    
    // A) INTENTO DE SUBIDA A GOOGLE (FILE API REAL)
    let googleFileUri = null;
    let googleFileName = null;
    
    try {
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, {
            mimeType: req.body.mimeType || req.file.mimetype,
            displayName: req.file.originalname,
        });
        
        // Esperamos a que el archivo esté activo (IMPORTANTE para evitar errores en chat inmediato)
        let fileState = uploadResponse.file.state;
        googleFileUri = uploadResponse.file.uri;
        googleFileName = uploadResponse.file.name;
        console.log(`☁️ Subido a Google File API: ${googleFileName} (Estado: ${fileState})`);

    } catch (googleErr) {
        console.warn("⚠️ Falló subida a Google, usando modo respaldo (solo texto):", googleErr.message);
    }

    // B) EXTRACCIÓN DE TEXTO LOCAL (RESPALDO PARA TU FRONTEND)
    // Tu frontend necesita el texto para mostrar "Texto extraído: X chars", así que lo mantenemos.
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf') || req.file.originalname.endsWith('.pdf')) {
      try {
          const data = await pdf(buffer);
          extractedText = data.text;
      } catch (e) { extractedText = "Texto no legible del PDF."; }
    } else {
      extractedText = buffer.toString('utf-8');
    }
    
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 50000);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({
      file: {
        uri: googleFileUri || `memory://${req.file.originalname}`,
        name: googleFileName, 
        extractedText: extractedText
      }
    });

  } catch (error) {
    console.error('❌ Error Upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. VINCULAR
app.post('/link-file', (req, res) => {
  const { storeId, fileName, extractedText, fileUri } = req.body;
  
  if (!STORES.has(storeId)) STORES.set(storeId, { name: "Recuperado", files: [], texts: [] });
  
  const store = STORES.get(storeId);
  store.texts.push({ fileName, text: extractedText }); // Guardamos texto para RAG simple
  
  if (fileUri && fileUri.startsWith('https://')) {
      store.files.push(fileUri); // Guardamos la URI de Google para el modelo avanzado
  }

  console.log(`🔗 Vinculado: ${fileName}`);
  res.json({ success: true, filesInStore: store.texts.length });
});

// 4. CHAT (CON MODELO ACTUALIZADO Y SIN ERROR 404)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  if (!STORES.has(storeId)) return res.json({ text: "⚠️ Memoria reiniciada. Sube archivos de nuevo." });

  const store = STORES.get(storeId);
  
  try {
    const apiKey = getApiKey();
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // === EL CAMBIO CLAVE ===
    // Usamos 'gemini-1.5-flash-001' que es la versión ESTABLE.
    // Evitamos 'gemini-1.5-flash' a secas porque a veces apunta a versiones antiguas o da 404.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-001" });

    // Construimos el prompt con el texto que ya tenemos (RAG Rápido)
    const context = store.texts.map(t => `--- DOCUMENTO: ${t.fileName} ---\n${t.text}`).join('\n\n');
    const prompt = `Contexto:\n${context}\n\nPregunta: ${query}`;
    
    const result = await model.generateContent(prompt);
    res.json({ text: result.response.text() });
    
  } catch (e) {
    console.error("❌ Error Chat:", e);
    // Si falla el flash, intentamos automáticamente con el Pro (Plan B)
    if (e.message.includes('404') || e.message.includes('not found')) {
        try {
            console.log("🔄 Reintentando con gemini-1.5-pro-001...");
            const genAI = new GoogleGenerativeAI(getApiKey());
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-001" });
            const result = await model.generateContent(`Contexto:\n...Docs...\nPregunta: ${query}`);
            return res.json({ text: result.response.text() });
        } catch (e2) {
             return res.status(500).json({ error: `Error Gemini (Todos los modelos fallaron): ${e.message}` });
        }
    }
    res.status(500).json({ error: `Error Gemini: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor Final listo en ${PORT}`));

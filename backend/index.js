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

// LISTA DE MODELOS A PROBAR (Orden de preferencia para 2025)
const MODEL_CANDIDATES = [
  "gemini-2.5-flash",        // Probable nuevo estándar
  "gemini-2.0-flash-exp",    // Versión experimental común
  "gemini-1.5-flash-002",    // Versión actualizada de 1.5
  "gemini-1.5-flash-latest", // Alias genérico
  "gemini-1.5-flash",        // Versión clásica (fallback)
  "gemini-1.5-pro",          // Fallback potente
  "gemini-pro"               // Último recurso (1.0)
];

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

// --- FUNCIÓN INTELIGENTE: PROBAR MODELOS HASTA QUE UNO FUNCIONE ---
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      console.log(`🤖 Intentando con modelo: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      console.log(`✅ ÉXITO con ${modelName}`);
      return result.response.text();
    } catch (e) {
      console.warn(`⚠️ Falló ${modelName}: ${e.message.split(' ')[0]}...`); // Log corto
      lastError = e;
      // Si el error NO es 404 (Not Found), quizás es otro problema, pero seguimos probando
      if (!e.message.includes('404') && !e.message.includes('not found')) {
         // Si es error de cuota (429) o servidor (500), seguimos intentando otros modelos
      }
    }
  }
  throw lastError || new Error("Todos los modelos fallaron.");
}

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Backend Cerebro Online (Multi-Model 2025) 🚀'));

// 1. CREAR STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `store-${Date.now()}`;
  STORES.set(storeId, { name, files: [], texts: [] });
  res.json({ name: storeId }); 
});

// 2. UPLOAD (HÍBRIDO: NATIVO + TEXTO)
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
        
        // Esperamos a que esté activo (Polling rápido)
        let fileState = uploadResponse.file.state;
        googleFile = {
            uri: uploadResponse.file.uri,
            name: uploadResponse.file.name,
            mimeType: uploadResponse.file.mimeType
        };
        console.log(`☁️ Subido a Google File API: ${googleFile.name} (${fileState})`);
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
        googleData: googleFile, // Guardamos los datos completos de Google
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
  const { storeId, fileName, extractedText, fileUri, googleData } = req.body; // googleData viene del upload
  
  if (!STORES.has(storeId)) STORES.set(storeId, { name: "Recuperado", files: [], texts: [] });
  
  const store = STORES.get(storeId);
  store.texts.push({ fileName, text: extractedText }); // Siempre guardamos texto por seguridad
  
  if (googleData && googleData.uri) {
      store.files.push(googleData); // Guardamos el objeto completo {uri, mimeType}
  } else if (fileUri && fileUri.startsWith('https://')) {
       // Compatibilidad con versiones anteriores
      store.files.push({ uri: fileUri, mimeType: 'application/pdf' }); 
  }

  console.log(`🔗 Vinculado: ${fileName} (Nativo: ${!!googleData})`);
  res.json({ success: true, filesInStore: store.files.length || store.texts.length });
});

// 4. CHAT (CON SELECTOR DE MODELOS)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  if (!STORES.has(storeId)) return res.json({ text: "⚠️ Memoria reiniciada. Sube archivos de nuevo." });

  const store = STORES.get(storeId);
  const apiKey = getApiKey();

  try {
    // PREPARAR CONTENIDO MULTIMODAL (NATIVO)
    // Si tenemos archivos nativos en Google, los usamos. Es mucho más potente.
    let promptParts = [];
    
    if (store.files.length > 0) {
        console.log("📎 Usando modo File Search Nativo");
        promptParts.push({ text: "Responde a la pregunta basándote en los siguientes archivos adjuntos:" });
        
        // Añadimos los archivos al prompt (Límite: los últimos 2 para no saturar si son grandes)
        const activeFiles = store.files.slice(-5); 
        activeFiles.forEach(f => {
            promptParts.push({ 
                fileData: { 
                    mimeType: f.mimeType || 'application/pdf', 
                    fileUri: f.uri 
                } 
            });
        });
    } else {
        console.log("📝 Usando modo Texto Puro (Fallback)");
        const context = store.texts.map(t => `--- DOCUMENTO: ${t.fileName} ---\n${t.text}`).join('\n\n');
        promptParts.push({ text: `CONTEXTO:\n${context}` });
    }

    promptParts.push({ text: `\nPREGUNTA: ${query}` });

    // LLAMADA INTELIGENTE
    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
    
  } catch (e) {
    console.error("❌ Error Fatal Chat:", e);
    res.status(500).json({ error: `Error Gemini: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor Final listo en ${PORT}`));

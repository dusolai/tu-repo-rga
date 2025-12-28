const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
// IMPORTANTE: Usamos la librería oficial, que maneja los modelos mejor que nosotros a mano
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// ALMACÉN EN MEMORIA (Volátil)
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

// Helper API Key
const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) console.error("⚠️ ADVERTENCIA: Falta GEMINI_API_KEY");
  return key;
};

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Backend RAG Online (Model Fixed) 🚀'));

// 1. CREAR STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `store-${Date.now()}`;
  STORES.set(storeId, { name, texts: [] });
  res.json({ name: storeId }); 
});

// 2. UPLOAD (Extracción robusta)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Recibido: ${req.file.originalname}`);
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";

    if (req.file.mimetype === 'application/pdf' || req.file.originalname.endsWith('.pdf')) {
      try {
          const data = await pdf(buffer);
          extractedText = data.text;
      } catch (e) {
          console.error("Error leyendo PDF:", e);
          extractedText = "Error leyendo el contenido del PDF.";
      }
    } else {
      extractedText = buffer.toString('utf-8');
    }

    // Limpieza
    extractedText = extractedText.replace(/\s+/g, ' ').trim().substring(0, 100000); 
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({
      file: {
        uri: `memory://${req.file.originalname}`,
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
  const { storeId, fileName, extractedText } = req.body;
  
  if (!STORES.has(storeId)) {
      // Auto-curación si se reinició
      STORES.set(storeId, { name: "Recuperado", texts: [] });
  }
  
  const store = STORES.get(storeId);
  store.texts.push({ fileName, text: extractedText });
  console.log(`🔗 Guardado: ${fileName}`);
  res.json({ success: true, filesInStore: store.texts.length });
});

// 4. CHAT (AQUÍ ESTÁ EL CAMBIO CLAVE)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  
  if (!STORES.has(storeId)) {
      return res.json({ text: "⚠️ Memoria reiniciada. Por favor sube los documentos de nuevo." });
  }

  const store = STORES.get(storeId);
  const context = store.texts.map(t => `--- DOCUMENTO: ${t.fileName} ---\n${t.text}`).join('\n\n');
  
  const prompt = `
  Eres un asistente experto. Responde a la pregunta basándote SOLO en la siguiente información.
  
  INFORMACIÓN:
  ${context}
  
  PREGUNTA: ${query}
  `;

  try {
    const apiKey = getApiKey();
    // Usamos el SDK oficial
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // CAMBIO CRÍTICO: Usamos 'gemini-1.5-flash-latest' o 'gemini-pro' si falla el flash
    // La versión más segura ahora mismo es simplemente 'gemini-1.5-flash' PERO
    // la librería oficial gestiona las versiones de API mejor que la llamada REST manual.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    res.json({ text });
  } catch (e) {
    console.error("❌ Error Chat:", e);
    // Devolvemos el error detallado para verlo
    res.status(500).json({ error: `Error Gemini: ${e.message}` });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en ${PORT}`));

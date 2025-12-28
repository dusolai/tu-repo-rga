const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');

// --- CARGA DE LIBRERÍAS A PRUEBA DE BOMBAS ---
let pdf = null;
let GoogleGenerativeAI = null;
let STARTUP_ERROR = null;

try {
  console.log("📦 Intentando cargar librerías...");
  pdf = require('pdf-parse');
  const genAIModule = require("@google/generative-ai");
  GoogleGenerativeAI = genAIModule.GoogleGenerativeAI;
  console.log("✅ Librerías cargadas EXITOSAMENTE.");
} catch (error) {
  console.error("🔥 ERROR FATAL CARGANDO LIBRERÍAS:", error.message);
  STARTUP_ERROR = error.message;
  // NO lanzamos el error para que el servidor no se apague y puedas ver qué pasa
}

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });
const STORES = new Map();

// MIDDLEWARES
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

// --- ENDPOINTS ---

// Ruta Principal (Diagnóstico)
app.get('/', (req, res) => {
  if (STARTUP_ERROR) {
    res.status(500).send(`
      <div style="color:red; font-family:sans-serif; padding:20px; border:2px solid red;">
        <h1>⚠️ EL SERVIDOR ARRANCÓ PERO CON ERRORES</h1>
        <p>Error detectado: <strong>${STARTUP_ERROR}</strong></p>
        <p>Esto significa que las librerías no se instalaron bien.</p>
      </div>
    `);
  } else {
    res.send('<h1 style="color:green">✅ BACKEND FUNCIONANDO CORRECTAMENTE</h1><p>Todas las librerías están listas.</p>');
  }
});

// Create Store
app.post('/create-store', (req, res) => {
  const storeId = `store-${Date.now()}`;
  STORES.set(storeId, { name: "Cerebro", texts: [] });
  res.json({ name: storeId });
});

// Upload
app.post('/upload', upload.single('file'), async (req, res) => {
  if (STARTUP_ERROR) return res.status(500).json({ error: "Error de servidor: Faltan librerías." });
  
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    let text = "";
    const buffer = fs.readFileSync(req.file.path);

    if (req.file.mimetype.includes('pdf') || req.file.originalname.endsWith('.pdf')) {
      const data = await pdf(buffer);
      text = data.text;
    } else {
      text = buffer.toString('utf-8');
    }

    text = text.replace(/\s+/g, ' ').substring(0, 100000);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ file: { uri: `mem://${req.file.originalname}`, extractedText: text } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Link File
app.post('/link-file', (req, res) => {
  const { storeId, fileName, extractedText } = req.body;
  if (!STORES.has(storeId)) STORES.set(storeId, { name: "Recuperado", texts: [] });
  STORES.get(storeId).texts.push({ fileName, text: extractedText });
  res.json({ success: true });
});

// Chat
app.post('/chat', async (req, res) => {
  if (STARTUP_ERROR) return res.status(500).json({ error: "Error crítico en servidor." });

  const { storeId, query } = req.body;
  if (!STORES.has(storeId)) return res.json({ text: "⚠️ Servidor reiniciado. Sube los archivos de nuevo." });

  const store = STORES.get(storeId);
  const context = store.texts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');

  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Falta API KEY");
    
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(`Contexto:\n${context}\n\nPregunta: ${query}`);
    res.json({ text: result.response.text() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 SERVIDOR LISTO EN PUERTO ${PORT}`));

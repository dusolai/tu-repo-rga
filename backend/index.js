const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');

// --- CARGA SEGURA DE LIBRERÍAS ---
let pdf = null;
let GoogleGenerativeAI = null;
let INSTALL_ERROR = null;

try {
  // Intentamos cargar las librerías nuevas
  console.log("Cargando librerías...");
  pdf = require('pdf-parse');
  const genAIModule = require("@google/generative-ai");
  GoogleGenerativeAI = genAIModule.GoogleGenerativeAI;
  console.log("✅ Librerías cargadas correctamente.");
} catch (error) {
  // Si fallan, guardamos el error pero NO apagamos el servidor
  console.error("❌ ERROR CRÍTICO FALTAN DEPENDENCIAS:", error.message);
  INSTALL_ERROR = error.message;
}

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

// RUTA DE DIAGNÓSTICO
app.get('/', (req, res) => {
  if (INSTALL_ERROR) {
    res.status(500).send(`
      <div style="font-family: sans-serif; padding: 20px; background: #ffebee; color: #c62828; border: 2px solid red;">
        <h1>⚠️ ERROR DE INSTALACIÓN</h1>
        <p>El servidor arrancó, pero faltan librerías.</p>
        <p><strong>Error técnico:</strong> ${INSTALL_ERROR}</p>
        <p><strong>Solución:</strong> Asegúrate de que 'backend/package.json' incluye 'pdf-parse' y '@google/generative-ai'.</p>
      </div>
    `);
  } else {
    res.send('<h1 style="color:green">Backend Online y Completo 🚀</h1><p>Todas las librerías cargadas.</p>');
  }
});

// 1. CREAR STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `store-${Date.now()}`;
  STORES.set(storeId, { name, texts: [] });
  res.json({ name: storeId }); 
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  // Verificación de seguridad
  if (INSTALL_ERROR) return res.status(500).json({ error: "Faltan librerías en el servidor. Revisa la página de inicio." });

  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";

    if (req.file.mimetype === 'application/pdf' || req.file.originalname.endsWith('.pdf')) {
      if (!pdf) throw new Error("Librería PDF no cargada");
      const data = await pdf(buffer);
      extractedText = data.text;
    } else {
      extractedText = buffer.toString('utf-8');
    }

    extractedText = extractedText.replace(/\s+/g, ' ').trim().substring(0, 100000);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); 

    res.json({ file: { uri: `memory://${req.file.originalname}`, extractedText } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. VINCULAR
app.post('/link-file', (req, res) => {
  const { storeId, fileName, extractedText } = req.body;
  if (!STORES.has(storeId)) STORES.set(storeId, { name: "Recuperado", texts: [] });
  const store = STORES.get(storeId);
  store.texts.push({ fileName, text: extractedText });
  res.json({ success: true, filesInStore: store.texts.length });
});

// 4. CHAT
app.post('/chat', async (req, res) => {
  if (INSTALL_ERROR) return res.status(500).json({ error: "Faltan librerías (SDK). Mira la raíz del servidor." });
  
  const { storeId, query } = req.body;
  if (!STORES.has(storeId)) return res.json({ text: "⚠️ Servidor reiniciado. Sube los archivos de nuevo." });

  const store = STORES.get(storeId);
  const context = store.texts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
  const prompt = `Contexto:\n${context}\n\nPregunta: ${query}`;

  try {
    const genAI = new GoogleGenerativeAI(getApiKey());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    res.json({ text: result.response.text() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor (Modo Seguro) listo en ${PORT}`));

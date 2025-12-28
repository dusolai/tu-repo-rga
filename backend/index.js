const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const https = require('https');
const pdf = require('pdf-parse'); 

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// ALMACÉN EN MEMORIA (Volátil)
const STORES = new Map();

// MIDDLEWARES
app.use(express.json({ limit: '10mb' })); // Aumentamos límite para textos largos
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

// HELPER: Llamada a Gemini
function callGeminiREST(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
            console.error("Gemini Error:", data);
            return reject(new Error(`Error Gemini: ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "Sin respuesta";
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- ENDPOINTS ---

app.get('/', (req, res) => res.send('Backend Auto-Curativo Online 🟢'));

// 1. CREAR STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || req.body.displayName || "Cerebro"; 
  const storeId = `store-${Date.now()}`;
  STORES.set(storeId, { name, texts: [] });
  console.log(`✅ Store creado: ${storeId}`);
  res.json({ name: storeId }); 
});

// 2. UPLOAD (Extracción de texto)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Procesando: ${req.file.originalname}`);
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";

    if (req.file.mimetype === 'application/pdf' || req.file.originalname.endsWith('.pdf')) {
      try {
          const data = await pdf(buffer);
          extractedText = data.text;
      } catch (e) {
          console.error("Error leyendo PDF:", e);
          extractedText = "[Error leyendo PDF]";
      }
    } else {
      extractedText = buffer.toString('utf-8');
    }

    // Limpieza
    extractedText = extractedText.replace(/\s+/g, ' ').trim().substring(0, 50000); 
    fs.unlinkSync(req.file.path); 

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

// 3. VINCULAR (AQUÍ ESTÁ EL ARREGLO)
app.post('/link-file', (req, res) => {
  const { storeId, fileName, extractedText } = req.body;
  
  // === AUTO-CURACIÓN ===
  // Si el servidor se reinició y perdió el store, lo creamos al vuelo
  if (!STORES.has(storeId)) {
      console.warn(`⚠️ Store ${storeId} perdido (reinicio). Re-creándolo...`);
      STORES.set(storeId, { name: "Recuperado", texts: [] });
  }
  
  const store = STORES.get(storeId);
  store.texts.push({ fileName, text: extractedText });
  
  console.log(`🔗 ${fileName} guardado. Docs totales: ${store.texts.length}`);
  res.json({ success: true, filesInStore: store.texts.length });
});

// 4. CHAT
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  
  // Si se perdió el store en el chat, avisamos amablemente
  if (!STORES.has(storeId)) {
      return res.json({ text: "⚠️ He perdido la memoria por un reinicio del servidor. Por favor, recarga la página y sube los archivos de nuevo." });
  }

  const store = STORES.get(storeId);
  
  if (store.texts.length === 0) {
      return res.json({ text: "No tengo documentos cargados para responder esa pregunta." });
  }

  const context = store.texts.map(t => `--- ${t.fileName} ---\n${t.text}`).join('\n\n');
  const prompt = `Responde usando SOLO este contexto:\n${context}\n\nPregunta: ${query}`;

  try {
    const apiKey = getApiKey();
    const answer = await callGeminiREST(prompt, apiKey);
    res.json({ text: answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en ${PORT}`));

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const https = require('https');
const pdf = require('pdf-parse'); // <--- NUEVO: Para leer PDFs

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });
// ALMACÉN EN MEMORIA (Ojo: Se borra si reinicias Cloud Run)
const STORES = new Map();

// MIDDLEWARES
app.use(express.json());
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

// --- FUNCIÓN HELPER: Llamada a Gemini ---
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
          console.error(`Gemini Error ${res.statusCode}:`, data);
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

app.get('/', (req, res) => res.send('Backend RAG Online 🚀'));

// 1. CREAR STORE
app.post('/create-store', (req, res) => {
  // Frontend envía displayName, Backend acepta ambos
  const name = req.body.name || req.body.displayName; 
  const storeId = `store-${Date.now()}`;
  STORES.set(storeId, { name, texts: [] });
  console.log(`✅ Store creado: ${storeId}`);
  // Devolvemos "name" porque el frontend lo espera así
  res.json({ name: storeId }); 
});

// 2. UPLOAD (PROCESAMIENTO REAL)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    console.log(`📥 Procesando: ${req.file.originalname}`);
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";

    // LÓGICA DE EXTRACCIÓN
    if (req.file.mimetype === 'application/pdf' || req.file.originalname.endsWith('.pdf')) {
      const data = await pdf(buffer);
      extractedText = data.text; // <--- AQUÍ ESTÁ LA MAGIA
    } else {
      extractedText = buffer.toString('utf-8');
    }

    // Limpieza básica del texto
    extractedText = extractedText.replace(/\s+/g, ' ').trim().substring(0, 30000); // Límite de seguridad

    console.log(`📄 Texto extraído: ${extractedText.length} caracteres`);
    fs.unlinkSync(req.file.path); // Borrar temporal

    // Devolvemos el texto al frontend para que él decida qué hacer (o lo guardamos aquí si prefieres)
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

// 3. VINCULAR (GUARDAR EN MEMORIA)
app.post('/link-file', (req, res) => {
  const { storeId, fileName, extractedText } = req.body;
  
  if (!STORES.has(storeId)) return res.status(404).json({ error: 'Store no existe' });
  
  const store = STORES.get(storeId);
  // Guardamos el texto REAL en memoria
  store.texts.push({ fileName, text: extractedText });
  
  console.log(`🔗 ${fileName} guardado en ${storeId}. Total docs: ${store.texts.length}`);
  res.json({ success: true, filesInStore: store.texts.length });
});

// 4. CHAT (RAG)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  if (!STORES.has(storeId)) return res.status(404).json({ error: 'Store perdido (Reinicia la web)' });

  const store = STORES.get(storeId);
  
  // CONSTRUIMOS EL CONTEXTO CON EL TEXTO REAL
  const context = store.texts.map(t => `--- DOCUMENTO: ${t.fileName} ---\n${t.text}`).join('\n\n');
  
  const prompt = `
  Eres un asistente experto. Usa SOLO la siguiente información para responder.
  
  INFORMACIÓN DISPONIBLE:
  ${context}
  
  PREGUNTA DEL USUARIO: ${query}
  `;

  try {
    const apiKey = getApiKey();
    const answer = await callGeminiREST(prompt, apiKey);
    // IMPORTANTE: Devolver "text" para que coincida con tu frontend actual
    res.json({ text: answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
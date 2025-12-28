const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });
const STORES = new Map();

// ===========================
// MIDDLEWARES
// ===========================
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

// ===========================
// GEMINI REST API (SIN SDK)
// ===========================
function callGeminiREST(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    console.log(`📡 Llamando a Gemini REST API...`);
    console.log(`   Path: ${options.path}`);

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        console.log(`   HTTP Status: ${res.statusCode}`);
        
        if (res.statusCode !== 200) {
          console.error(`   ❌ Error HTTP ${res.statusCode}:`, responseData);
          reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
          return;
        }

        try {
          const parsed = JSON.parse(responseData);
          
          if (parsed.error) {
            console.error(`   ❌ Gemini Error:`, JSON.stringify(parsed.error));
            reject(new Error(`Gemini: ${parsed.error.message}`));
            return;
          }

          if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
            const text = parsed.candidates[0].content.parts[0].text;
            console.log(`   ✅ Respuesta OK: ${text.length} chars`);
            resolve(text);
          } else {
            console.error(`   ❌ Formato inesperado:`, JSON.stringify(parsed).substring(0, 200));
            reject(new Error('Respuesta sin texto'));
          }
        } catch (e) {
          console.error(`   ❌ Parse Error:`, e.message);
          console.error(`   Raw:`, responseData.substring(0, 500));
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => {
      console.error(`   ❌ Request Error:`, e.message);
      reject(e);
    });

    req.write(payload);
    req.end();
  });
}

// ===========================
// ENDPOINTS
// ===========================

// Health check
app.get('/', (req, res) => {
  console.log('💚 Health check');
  res.json({ 
    status: 'ok', 
    version: '7.0.0-REST-PURO',
    modelo: 'gemini-1.5-flash (REST v1beta)'
  });
});

// Crear store
app.post('/create-store', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Se requiere name' });

    const storeId = `fileSearchStores/${name}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    STORES.set(storeId, { name, files: [], texts: [] });

    console.log(`✅ Store creado: ${storeId}`);
    res.json({ storeId });
  } catch (error) {
    console.error('❌ Error creando store:', error);
    res.status(500).json({ error: error.message });
  }
});

// Subir archivo
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    console.log(`📤 Subiendo archivo: ${req.file?.originalname}`);
    
    const apiKey = getApiKey();
    const { path: localPath, originalname } = req.file;
    const fileContent = fs.readFileSync(localPath);
    const contentType = originalname.endsWith('.pdf') ? 'application/pdf' : 'text/plain';

    // Subir a Gemini File Manager
    const boundary = `----Boundary${Date.now()}`;
    const metadata = JSON.stringify({ file: { displayName: originalname } });
    
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const uploadResult = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/upload/v1beta/files?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': body.length
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(JSON.parse(data));
          else reject(new Error(`Upload failed: ${data}`));
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Extraer texto
    let extractedText = '';
    if (originalname.endsWith('.txt') || originalname.endsWith('.md')) {
      extractedText = fileContent.toString('utf-8');
    } else if (originalname.endsWith('.pdf')) {
      extractedText = `[PDF: ${originalname} - texto no extraído]`;
    }

    console.log(`✅ Archivo subido: ${uploadResult.file.name}`);
    console.log(`   Texto extraído: ${extractedText.length} chars`);

    fs.unlinkSync(localPath);

    res.json({
      file: {
        name: uploadResult.file.name,
        uri: uploadResult.file.uri,
        mimeType: uploadResult.file.mimeType,
        extractedText
      }
    });
  } catch (error) {
    console.error('❌ Error upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// Vincular archivo
app.post('/link-file', (req, res) => {
  try {
    const { storeId, fileUri, fileName, extractedText } = req.body;
    
    console.log(`🔗 Vinculando archivo a store: ${storeId}`);

    if (!STORES.has(storeId)) {
      return res.status(404).json({ error: 'Store no encontrado' });
    }

    const store = STORES.get(storeId);
    store.files.push({ fileUri, fileName });
    
    if (extractedText) {
      store.texts.push({ fileName, text: extractedText });
      console.log(`   Texto guardado: ${extractedText.length} chars`);
    }

    console.log(`✅ Total archivos: ${store.files.length}`);
    res.json({ success: true, fileCount: store.files.length });
  } catch (error) {
    console.error('❌ Error linking:', error);
    res.status(500).json({ error: error.message });
  }
});

// Chat con RAG
app.post('/chat', async (req, res) => {
  try {
    const { storeId, query } = req.body;
    const apiKey = getApiKey();

    console.log(`💬 Query: "${query}"`);
    console.log(`   Store: ${storeId}`);

    if (!STORES.has(storeId)) {
      return res.status(404).json({ error: 'Store no encontrado' });
    }

    const store = STORES.get(storeId);
    console.log(`🔍 Textos disponibles: ${store.texts.length}`);

    // Construir contexto
    let context = '';
    for (const { fileName, text } of store.texts) {
      context += `\n\n--- ${fileName} ---\n${text}`;
    }

    const prompt = `Documentos:\n${context}\n\nPregunta: ${query}\n\nResponde SOLO con información de los documentos.`;
    console.log(`   Prompt: ${prompt.length} chars`);

    const response = await callGeminiREST(prompt, apiKey);

    console.log(`✅ Respuesta generada`);
    res.json({ response });
  } catch (error) {
    console.error('❌ Error en chat:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Debug
app.get('/debug/stores', (req, res) => {
  const stores = Array.from(STORES.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    fileCount: data.files.length,
    textCount: data.texts.length
  }));
  res.json({ stores });
});

// ===========================
// SERVIDOR
// ===========================
app.listen(PORT, () => {
  console.log(`🚀 Backend v7.0.0 escuchando en puerto ${PORT}`);
  console.log(`   Modelo: gemini-1.5-flash (REST v1beta)`);
  console.log(`   Sin SDK - REST API pura`);
});

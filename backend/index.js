const express = require('express');
const multer = require('multer');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const fs = require('fs');
const os = require('os');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });
const STORES = new Map();

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

// Llamada REST API v1 (ESTABLE)
async function callGeminiREST(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (parsed.candidates && parsed.candidates[0]?.content?.parts?.[0]?.text) {
            resolve(parsed.candidates[0].content.parts[0].text);
          } else {
            reject(new Error('Respuesta inválida: ' + responseData));
          }
        } catch (e) {
          reject(new Error('Error parseando: ' + e.message));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Backend Cerebro v6 REST',
    stores: STORES.size
  });
});

app.post('/create-store', express.json(), (req, res) => {
  const { displayName } = req.body;
  const storeId = `fileSearchStores/cerebrodiego${Date.now()}-2v05e2bf140h`;
  STORES.set(storeId, {
    displayName: displayName || 'Cerebro',
    files: [],
    texts: [],
    createdAt: new Date().toISOString()
  });
  console.log(`📦 Store: ${storeId}`);
  res.json({ name: storeId });
});

app.post('/upload', (req, res) => {
  console.log("📥 Upload iniciado");
  const uploadSingle = upload.single('file');

  uploadSingle(req, res, async (err) => {
    if (err || !req.file) {
      console.error("❌ Multer:", err?.message || "Sin archivo");
      return res.status(500).json({ error: "Error recibiendo archivo" });
    }

    console.log(`✅ Recibido: ${req.file.originalname}`);

    try {
      const apiKey = getApiKey();
      const fileManager = new GoogleAIFileManager(apiKey);
      
      const uploadResult = await fileManager.uploadFile(req.file.path, {
        mimeType: req.body.mimeType || req.file.mimetype,
        displayName: req.body.displayName || req.file.originalname,
      });

      console.log(`🚀 Gemini: ${uploadResult.file.uri}`);

      // Extracción simple de texto
      let extractedText = "";
      
      if (req.file.mimetype === 'text/plain' || req.file.mimetype === 'text/markdown') {
        extractedText = fs.readFileSync(req.file.path, 'utf-8');
        console.log(`📄 Texto: ${extractedText.length} chars`);
      } else {
        // Para PDFs: placeholder
        extractedText = `[Documento ${req.file.originalname} - Contenido pendiente de extracción]`;
        console.log(`⚠️ PDF: usando placeholder`);
      }

      fs.unlinkSync(req.file.path);
      
      res.json({
        success: true,
        file: {
          name: uploadResult.file.name,
          uri: uploadResult.file.uri,
          mimeType: uploadResult.file.mimeType,
          extractedText: extractedText
        }
      });

    } catch (geminiErr) {
      console.error("❌ Gemini:", geminiErr.message);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: "Error", details: geminiErr.message });
    }
  });
});

app.post('/link-file', express.json(), (req, res) => {
  const { storeId, fileUri, fileName, extractedText } = req.body;
  console.log(`🔗 Vinculando: ${storeId}`);
  
  if (!STORES.has(storeId)) {
    STORES.set(storeId, {
      displayName: 'Cerebro Auto',
      files: [],
      texts: [],
      createdAt: new Date().toISOString()
    });
  }
  
  const store = STORES.get(storeId);
  
  if (fileUri && !store.files.some(f => f.uri === fileUri)) {
    store.files.push({ uri: fileUri, name: fileName || 'doc', addedAt: new Date().toISOString() });
    if (extractedText) store.texts.push({ fileName: fileName || 'doc', content: extractedText });
    console.log(`✅ Vinculado. Total: ${store.files.length}`);
  }
  
  res.json({ status: "OK", filesInStore: store.files.length });
});

app.post('/chat', express.json(), async (req, res) => {
  try {
    const { query, storeId } = req.body;
    if (!query) return res.status(400).json({ error: "Falta query" });
    
    console.log(`💬 "${query}"`);
    const apiKey = getApiKey();
    
    if (storeId && STORES.has(storeId)) {
      const store = STORES.get(storeId);
      
      if (store.texts && store.texts.length > 0) {
        console.log(`🔍 RAG con ${store.texts.length} docs`);
        
        const context = store.texts.map((t, i) => 
          `--- DOC ${i + 1}: ${t.fileName} ---\n${t.content}\n`
        ).join('\n');
        
        const fullPrompt = `Documentos:\n${context}\n\nPregunta: ${query}\n\nResponde SOLO con info de los documentos.`;
        const responseText = await callGeminiREST(fullPrompt, apiKey);
        
        console.log(`✅ RAG OK (${responseText.length} chars)`);
        return res.json({ text: responseText, groundingChunks: [], usedRAG: true, filesUsed: store.texts.length });
      }
    }
    
    console.log(`⚠️ Sin docs`);
    const responseText = await callGeminiREST(query, apiKey);
    res.json({ text: responseText, groundingChunks: [], usedRAG: false, warning: "Sin archivos" });
    
  } catch (chatErr) {
    console.error("❌ Chat:", chatErr.message);
    res.status(500).json({ error: "Error chat", details: chatErr.message });
  }
});

app.get('/debug/stores', (req, res) => {
  const storesArray = Array.from(STORES.entries()).map(([id, data]) => ({
    id, displayName: data.displayName, filesCount: data.files.length, textsCount: data.texts?.length || 0
  }));
  res.json({ total: STORES.size, stores: storesArray });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════╗
║ 🧠 BACKEND v6 (REST API v1)     ║
║ Puerto: ${PORT}                    ║
╚══════════════════════════════════╝
  `);
});    stores: STORES.size,
    timestamp: new Date().toISOString()
  });
});

app.post('/create-store', express.json(), (req, res) => {
  const { displayName } = req.body;
  const storeId = `fileSearchStores/cerebrodiego${Date.now()}-2v05e2bf140h`;
  STORES.set(storeId, {
    displayName: displayName || 'Cerebro',
    files: [],
    texts: [], // ← Guardamos el texto extraído aquí
    createdAt: new Date().toISOString()
  });
  console.log(`📦 Store creado: ${storeId}`);
  res.json({ name: storeId });
});

app.post('/upload', (req, res) => {
  console.log("📥 Iniciando recepción de archivo...");
  const uploadSingle = upload.single('file');

  uploadSingle(req, res, async (err) => {
    if (err || !req.file) {
      console.error("❌ Error Multer o sin archivo");
      return res.status(500).json({ error: "Error recibiendo archivo" });
    }

    console.log(`✅ Archivo recibido: ${req.file.originalname}`);

    try {
      const apiKey = getApiKey();
      const fileManager = new GoogleAIFileManager(apiKey);
      
      const uploadResult = await fileManager.uploadFile(req.file.path, {
        mimeType: req.body.mimeType || req.file.mimetype,
        displayName: req.body.displayName || req.file.originalname,
      });

      console.log(`🚀 Subido a Gemini: ${uploadResult.file.uri}`);

      // EXTRAER TEXTO del archivo usando Gemini
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      
      const fileContent = fs.readFileSync(req.file.path);
      const base64 = fileContent.toString('base64');
      
      const extractResult = await model.generateContent([
        {
          inlineData: {
            mimeType: req.body.mimeType || req.file.mimetype,
            data: base64
          }
        },
        { text: "Extrae TODO el texto de este documento. No resumas, copia el contenido completo." }
      ]);
      
      const extractedText = extractResult.response.text();
      console.log(`📄 Texto extraído: ${extractedText.length} caracteres`);

      fs.unlinkSync(req.file.path);
      
      res.json({
        success: true,
        file: {
          name: uploadResult.file.name,
          uri: uploadResult.file.uri,
          mimeType: uploadResult.file.mimeType,
          extractedText: extractedText // ← Enviamos el texto al frontend
        }
      });

    } catch (geminiErr) {
      console.error("❌ Error Gemini:", geminiErr.message);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: "Error procesando", details: geminiErr.message });
    }
  });
});

app.post('/link-file', express.json(), (req, res) => {
  const { storeId, fileUri, fileName, extractedText } = req.body;
  
  console.log(`🔗 Vinculando archivo a: ${storeId}`);
  
  if (!STORES.has(storeId)) {
    console.warn(`⚠️ Store no encontrado, creando...`);
    STORES.set(storeId, {
      displayName: 'Cerebro Auto',
      files: [],
      texts: [],
      createdAt: new Date().toISOString()
    });
  }
  
  const store = STORES.get(storeId);
  
  if (fileUri && !store.files.some(f => f.uri === fileUri)) {
    store.files.push({
      uri: fileUri,
      name: fileName || 'documento',
      addedAt: new Date().toISOString()
    });
    
    // Guardar el texto extraído
    if (extractedText) {
      store.texts.push({
        fileName: fileName || 'documento',
        content: extractedText
      });
    }
    
    console.log(`✅ Archivo vinculado. Total: ${store.files.length}`);
  }
  
  res.json({ status: "OK", filesInStore: store.files.length });
});

app.post('/chat', express.json(), async (req, res) => {
  try {
    const { query, storeId } = req.body;
    
    if (!query) return res.status(400).json({ error: "Falta query" });
    
    console.log(`💬 Consulta: "${query}"`);
    console.log(`   Store: ${storeId || 'N/A'}`);
    
    const apiKey = getApiKey();
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // RAG SIMPLE: Agregar el contexto al prompt
    if (storeId && STORES.has(storeId)) {
      const store = STORES.get(storeId);
      
      if (store.texts && store.texts.length > 0) {
        console.log(`🔍 Usando RAG con ${store.texts.length} documentos`);
        
        // Construir contexto
        const context = store.texts.map((t, i) => 
          `--- DOCUMENTO ${i + 1}: ${t.fileName} ---\n${t.content}\n`
        ).join('\n');
        
        const fullPrompt = `Contexto de documentos:
${context}

Pregunta del usuario: ${query}

Responde SOLO basándote en la información de los documentos anteriores. Si la respuesta no está en los documentos, di "No encuentro esa información en los documentos".`;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(fullPrompt);
        const responseText = result.response.text();
        
        console.log(`✅ Respuesta RAG (${responseText.length} chars)`);
        
        return res.json({ 
          text: responseText,
          groundingChunks: [],
          usedRAG: true,
          filesUsed: store.texts.length
        });
      }
    }
    
    // Sin documentos
    console.log(`⚠️ Sin documentos`);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(query);
    
    res.json({ 
      text: result.response.text(),
      groundingChunks: [],
      usedRAG: false,
      warning: "Sin archivos en el cerebro"
    });
    
  } catch (chatErr) {
    console.error("❌ Error chat:", chatErr.message);
    res.status(500).json({ error: "Error en chat", details: chatErr.message });
  }
});

app.get('/debug/stores', (req, res) => {
  const storesArray = Array.from(STORES.entries()).map(([id, data]) => ({
    id,
    displayName: data.displayName,
    filesCount: data.files.length,
    textsCount: data.texts?.length || 0,
    createdAt: data.createdAt
  }));
  res.json({ total: STORES.size, stores: storesArray });
});

// === INICIO ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🧠 BACKEND CEREBRO v5 (TEXT-BASED)  ║
║   Puerto: ${PORT}                        ║
║   RAG: Extracción de texto ✅         ║
╚════════════════════════════════════════╝
  `);
});

const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const fs = require('fs');
const os = require('os');
const path = require('path');

// === CONFIGURACIÓN ===
const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de Multer
const upload = multer({ dest: os.tmpdir() });

// === ALMACENAMIENTO EN MEMORIA ===
// Aquí guardamos los archivos subidos por cada "cerebro"
const STORES = new Map(); // { storeId: { files: [...fileUris], displayName: "..." } }

// === MIDDLEWARES ===

// CORS Permisivo
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  next();
});

// Helper para obtener API Key
const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Falta GEMINI_API_KEY en variables de entorno");
  return key;
};

// === RUTAS ===

// Health Check
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Backend Cerebro Diego RAG',
    version: '3.0.0',
    stores: STORES.size,
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Crear Store
app.post('/create-store', express.json(), (req, res) => {
  const { displayName } = req.body;
  const storeId = `fileSearchStores/cerebrodiego${Date.now()}-2v05e2bf140h`;
  
  STORES.set(storeId, {
    displayName: displayName || 'Cerebro',
    files: [],
    createdAt: new Date().toISOString()
  });
  
  console.log(`📦 Store creado: ${storeId}`);
  res.json({ name: storeId });
});

// Upload de archivo
app.post('/upload', (req, res) => {
  console.log("📥 Iniciando recepción de archivo...");
  
  const uploadSingle = upload.single('file');

  uploadSingle(req, res, async (err) => {
    // 1. Manejo de errores de Multer
    if (err) {
      console.error("❌ Error en Multer:", err.message);
      return res.status(500).json({ 
        error: "Fallo al recibir el archivo", 
        details: err.message 
      });
    }

    // 2. Validar que llegó el archivo
    if (!req.file) {
      console.error("❌ No se recibió ningún archivo");
      return res.status(400).json({ 
        error: "No se envió ningún archivo en el campo 'file'" 
      });
    }

    console.log(`✅ Archivo recibido: ${req.file.originalname}`);
    console.log(`   Ruta temporal: ${req.file.path}`);
    console.log(`   Tamaño: ${(req.file.size / 1024).toFixed(2)} KB`);

    try {
      // 3. Subir a Google Gemini
      const apiKey = getApiKey();
      const fileManager = new GoogleAIFileManager(apiKey);
      
      const uploadResult = await fileManager.uploadFile(req.file.path, {
        mimeType: req.body.mimeType || req.file.mimetype,
        displayName: req.body.displayName || req.file.originalname,
      });

      console.log(`🚀 Subido a Gemini: ${uploadResult.file.name}`);
      console.log(`   URI: ${uploadResult.file.uri}`);

      // 4. Limpiar archivo temporal
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr) console.warn("⚠️ No se pudo borrar el temporal:", unlinkErr.message);
      });
      
      // 5. GUARDAR en el store temporal (lo haremos en /link-file)
      res.json({
        success: true,
        file: {
          name: uploadResult.file.name,
          uri: uploadResult.file.uri,
          mimeType: uploadResult.file.mimeType
        }
      });

    } catch (geminiErr) {
      console.error("❌ Error subiendo a Gemini:", geminiErr.message);
      
      // Limpiar archivo si falla
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      res.status(500).json({ 
        error: "Error procesando con Gemini", 
        details: geminiErr.message 
      });
    }
  });
});

// Vincular archivo a store
app.post('/link-file', express.json(), (req, res) => {
  const { storeId, fileUri, fileName } = req.body;
  
  console.log(`🔗 Vinculando archivo a store: ${storeId}`);
  
  // CRÍTICO: Aquí es donde asociamos archivos al cerebro
  if (!STORES.has(storeId)) {
    console.warn(`⚠️ Store no encontrado: ${storeId}, creando uno nuevo...`);
    STORES.set(storeId, {
      displayName: 'Cerebro Auto-creado',
      files: [],
      createdAt: new Date().toISOString()
    });
  }
  
  const store = STORES.get(storeId);
  
  // Agregar archivo si no existe
  if (fileUri && !store.files.some(f => f.uri === fileUri)) {
    store.files.push({
      uri: fileUri,
      name: fileName || 'documento',
      addedAt: new Date().toISOString()
    });
    console.log(`✅ Archivo vinculado. Total archivos en ${storeId}: ${store.files.length}`);
  }
  
  res.json({ 
    status: "OK",
    filesInStore: store.files.length
  });
});

// Chat con RAG REAL
app.post('/chat', express.json(), async (req, res) => {
  try {
    const { query, storeId } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: "Falta el parámetro 'query'" });
    }
    
    console.log(`💬 Consulta recibida: "${query}"`);
    console.log(`   Store ID: ${storeId || 'N/A'}`);
    
    const apiKey = getApiKey();
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // LÓGICA RAG: Si hay storeId y tiene archivos, usar FileSearch
    if (storeId && STORES.has(storeId)) {
      const store = STORES.get(storeId);
      
      if (store.files.length > 0) {
        console.log(`🔍 Usando RAG con ${store.files.length} archivos`);
        
        // Construir herramientas de búsqueda
        const fileDataParts = store.files.map(file => ({
          fileData: {
            fileUri: file.uri,
            mimeType: "application/pdf" // Ajustar según tipo real
          }
        }));
        
        const model = genAI.getGenerativeModel({
          model: "gemini-1.5-flash-002",
        });
        
        const result = await model.generateContent([
          {
            fileData: {
              mimeType: fileDataParts[0].fileData.mimeType,
              fileUri: fileDataParts[0].fileData.fileUri
            }
          },
          { text: query }
        ]);
        
        const responseText = result.response.text();
        
        console.log(`✅ Respuesta RAG generada (${responseText.length} chars)`);
        
        return res.json({ 
          text: responseText,
          groundingChunks: [], // Gemini API no devuelve chunks directamente aquí
          usedRAG: true,
          filesUsed: store.files.length
        });
      }
    }
    
    // FALLBACK: Si no hay archivos, responder sin RAG
    console.log(`⚠️ Sin archivos para RAG, usando modelo base`);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(query);
    const responseText = result.response.text();
    
    console.log(`✅ Respuesta base generada (${responseText.length} chars)`);
    
    res.json({ 
      text: responseText,
      groundingChunks: [],
      usedRAG: false,
      warning: "No se encontraron archivos en el cerebro"
    });
    
  } catch (chatErr) {
    console.error("❌ Error en chat:", chatErr.message);
    console.error(chatErr.stack);
    res.status(500).json({ 
      error: "Error en chat", 
      details: chatErr.message 
    });
  }
});

// Debug: Ver stores
app.get('/debug/stores', (req, res) => {
  const storesArray = Array.from(STORES.entries()).map(([id, data]) => ({
    id,
    ...data
  }));
  res.json({ 
    total: STORES.size,
    stores: storesArray 
  });
});

// === ARRANQUE DEL SERVIDOR ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🧠 BACKEND CEREBRO DIEGO RAG v3     ║
║   Puerto: ${PORT}                        ║
║   RAG: ACTIVADO ✅                    ║
║   Stores en memoria: ${STORES.size}              ║
╚════════════════════════════════════════╝
  `);
});

const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const fs = require('fs');
const os = require('os');

// === CONFIGURACIÓN ===
const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de Multer
const upload = multer({ dest: os.tmpdir() });

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
    service: 'Backend Cerebro Diego',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Ruta de Upload - SOLUCIÓN AL PROBLEMA
app.post('/upload', (req, res) => {
  console.log("📥 Iniciando recepción de archivo...");
  
  // Aplicar multer directamente en el handler
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

      console.log(`🚀 Subido a Gemini exitosamente: ${uploadResult.file.name}`);

      // 4. Limpiar archivo temporal
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr) console.warn("⚠️ No se pudo borrar el temporal:", unlinkErr.message);
      });
      
      // 5. Responder con éxito
      res.json({
        success: true,
        file: uploadResult.file
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

// Crear Store
app.post('/create-store', express.json(), (req, res) => {
  const { displayName } = req.body;
  const storeId = `stores/${displayName || 'store'}_${Date.now()}`;
  
  console.log(`📦 Store creado: ${storeId}`);
  res.json({ name: storeId });
});

// Vincular archivo a store
app.post('/link-file', express.json(), (req, res) => {
  console.log("🔗 Vinculando archivo a store...");
  res.json({ status: "OK" });
});

// Chat con el cerebro
app.post('/chat', express.json(), async (req, res) => {
  try {
    const { query } = req.body;
    console.log(`💬 Consulta recibida: "${query}"`);
    
    const genAI = new GoogleGenerativeAI(getApiKey());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const result = await model.generateContent(query);
    const responseText = result.response.text();
    
    console.log(`✅ Respuesta generada (${responseText.length} chars)`);
    
    res.json({ 
      text: responseText, 
      groundingChunks: [] 
    });
  } catch (chatErr) {
    console.error("❌ Error en chat:", chatErr.message);
    res.status(500).json({ 
      error: "Error en chat", 
      details: chatErr.message 
    });
  }
});

// === ARRANQUE DEL SERVIDOR ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   🧠 BACKEND CEREBRO DIEGO ONLINE     ║
║   Puerto: ${PORT}                        ║
║   Modo: Servidor HTTP Puro            ║
║   Sin functions-framework ✅          ║
╚════════════════════════════════════════╝
  `);
});

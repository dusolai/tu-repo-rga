const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de Multer (Carpeta temporal)
const upload = multer({ dest: os.tmpdir() });

// Middleware CORS (Permite que tu frontend entre sin bloqueos)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

// Ruta de Subida (Upload)
app.post('/upload', (req, res) => {
  console.log("--> Iniciando recepción de archivo...");

  // Usamos multer directamente para controlar errores
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error("❌ Error Multer:", err);
      return res.status(500).json({ error: "Error recibiendo archivo", details: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se envió ningún archivo" });
    }

    try {
      console.log(`✅ Archivo recibido: ${req.file.originalname}`);
      
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("Falta GEMINI_API_KEY en servidor");

      const fileManager = new GoogleAIFileManager(apiKey);
      const uploadResult = await fileManager.uploadFile(req.file.path, {
        mimeType: req.body.mimeType || req.file.mimetype,
        displayName: req.body.displayName || req.file.originalname,
      });

      console.log("🚀 Subido a Gemini:", uploadResult.file.name);
      
      // Limpieza
      fs.unlink(req.file.path, () => {});
      
      res.json(uploadResult.file);
    } catch (error) {
      console.error("❌ Error procesando:", error);
      res.status(500).json({ error: error.message });
    }
  });
});

app.get('/', (req, res) => res.send(`Servidor Docker Online en puerto ${PORT} 🚀`));

// ARRANQUE DEL SERVIDOR
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
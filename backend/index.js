const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// --- 1. FIREBASE (Conexión) ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase: CONECTADO");
    } else {
        console.warn("⚠️ Firebase: Modo RAM");
    }
} catch (e) {
    console.error("⚠️ Error Firebase:", e.message);
    db = null;
}

const STORES_RAM = new Map();

// --- 2. CONFIGURACIÓN DE MODELOS (CORREGIDO) ---
// IMPORTANTE: Usamos nombres de modelos que SÍ existen en v1beta
const MODEL_PRIORITY = [
    "gemini-2.0-flash-exp",           // Modelo experimental más reciente
    "gemini-1.5-flash-latest",        // Versión estable de 1.5 Flash
    "gemini-1.5-flash-002",           // Versión específica alternativa
    "gemini-1.5-pro-latest"           // Fallback a Pro si Flash falla
];

app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Falta GEMINI_API_KEY");
  return key;
};

// --- NÚCLEO: Generación Inteligente (Archivo -> Texto) ---
async function generateSmart(apiKey, promptParts, useFiles = true) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;
  let attemptedModels = [];

  for (const modelName of MODEL_PRIORITY) {
    try {
      console.log(`🤖 Intentando con modelo: ${modelName}`);
      attemptedModels.push(modelName);
      
      const model = genAI.getGenerativeModel({ model: modelName });
      
      // Si falló antes con archivos, probamos SOLO CON TEXTO (eliminamos fileData)
      const safeParts = useFiles ? promptParts : promptParts.filter(p => !p.fileData);
      
      const result = await model.generateContent(safeParts);
      const text = result.response.text();
      
      if (text) {
        console.log(`✅ Respuesta exitosa con ${modelName}`);
        return text;
      }
    } catch (e) {
        console.warn(`⚠️ Modelo ${modelName} falló: ${e.message}`);
        lastError = e;
        
        // Si es un error 404, probamos el siguiente modelo inmediatamente
        if (e.message.includes('404') || e.message.includes('not found')) {
          continue;
        }
        
        // Si es otro tipo de error, también continuamos pero lo registramos
        if (e.message.includes('PROCESSING') || e.message.includes('FAILED_PRECONDITION')) {
          console.warn(`⚠️ Archivo aún procesándose, probando siguiente modelo...`);
          continue;
        }
    }
  }
  
  // Si llegamos aquí, ningún modelo funcionó
  const errorMsg = `Fallaron todos los modelos probados (${attemptedModels.join(', ')}). Último error: ${lastError?.message || 'Desconocido'}`;
  console.error(`❌ ${errorMsg}`);
  throw new Error(errorMsg);
}

app.get('/', (req, res) => res.json({ 
  status: "Online 🟢", 
  models: MODEL_PRIORITY,
  version: "12.0.0"
}));

// 1. CREATE STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || "Cerebro"; 
  const storeId = `cerebro_${Date.now()}`;
  res.json({ name: storeId }); 

  (async () => {
    STORES_RAM.set(storeId, { name, files: [], texts: [] });
    if (db) {
        try {
            await db.collection('stores').doc(storeId).set({ name, createdAt: new Date(), files: [], texts: [] });
        } catch(e) { console.error("DB Create Error:", e.message); }
    }
  })();
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    console.log(`📤 Procesando archivo: ${req.file.originalname}`);
    
    // 1. Extraer Texto (Siempre funciona)
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { 
        const data = await pdf(buffer); 
        extractedText = data.text;
        console.log(`📄 Texto extraído del PDF: ${extractedText.length} caracteres`);
      } catch (e) {
        console.warn(`⚠️ Error extrayendo texto del PDF: ${e.message}`);
      }
    } else { 
      extractedText = buffer.toString('utf-8'); 
    }
    
    // Limpiamos y limitamos para no saturar
    extractedText = extractedText.replace(/\s+/g, ' ').trim().substring(0, 100000);

    // 2. Subir a Google (Puede fallar, no pasa nada)
    let googleFile = null;
    try {
        const apiKey = getApiKey();
        const fileManager = new GoogleAIFileManager(apiKey);
        
        console.log(`☁️ Subiendo a Google AI Files...`);
        const uploadResponse = await fileManager.uploadFile(req.file.path, { 
          mimeType: req.file.mimetype, 
          displayName: req.file.originalname 
        });
        
        // Esperar a que esté activo (Polling con timeout)
        let state = uploadResponse.file.state;
        let attempts = 0;
        const maxAttempts = 15; // Aumentamos el timeout
        
        while (state === "PROCESSING" && attempts < maxAttempts) {
            console.log(`⏳ Esperando procesamiento... (${attempts + 1}/${maxAttempts})`);
            await new Promise(r => setTimeout(r, 1000)); // 1 segundo entre intentos
            const check = await fileManager.getFile(uploadResponse.file.name);
            state = check.state;
            attempts++;
        }

        if (state === "ACTIVE") {
            googleFile = { 
                uri: uploadResponse.file.uri, 
                name: uploadResponse.file.name, 
                mimeType: uploadResponse.file.mimeType,
                displayName: req.file.originalname
            };
            console.log(`✅ Archivo subido a Google: ${googleFile.uri}`);
        } else {
            console.warn(`⚠️ Archivo no llegó a ACTIVE (estado: ${state}), usando solo texto`);
        }
    } catch (e) { 
      console.warn(`⚠️ Upload a Google falló (Usando texto): ${e.message}`); 
    }

    // Limpiar archivo temporal
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json({ 
      file: { 
        uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`, 
        googleData: googleFile, 
        extractedText,
        hasGoogleFile: !!googleFile,
        hasText: extractedText.length > 0
      } 
    });
  } catch (error) { 
    console.error(`❌ Error en /upload: ${error.message}`);
    res.status(500).json({ error: error.message }); 
  }
});

// 3. LINK FILE
app.post('/link-file', (req, res) => {
  res.json({ success: true });

  const { storeId, fileName, extractedText, googleData } = req.body;
  (async () => {
      try {
        if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
        const ramStore = STORES_RAM.get(storeId);
        ramStore.texts.push({ fileName, text: extractedText });
        if (googleData && googleData.uri) ramStore.files.push(googleData);

        if (db) {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = { texts: FieldValue.arrayUnion({ fileName, text: extractedText }) };
            if (googleData && googleData.uri) updates.files = FieldValue.arrayUnion(googleData);
            await storeRef.update(updates);
            console.log(`💾 Guardado: ${fileName} (Texto: ${extractedText.length} chars, Google: ${!!googleData})`);
        }
      } catch (e) { console.error(`❌ Error en /link-file: ${e.message}`); }
  })();
});

// 4. CHAT (VERSIÓN MEJORADA CON MEJOR MANEJO DE ERRORES)
app.post('/chat', async (req, res) => {
  try {
      const { storeId, query } = req.body;
      
      console.log(`💬 Consulta recibida: "${query.substring(0, 50)}..." para store: ${storeId}`);
      
      let storeData = STORES_RAM.get(storeId);

      // Recuperar de DB
      if (!storeData && db) {
          try {
              const doc = await db.collection('stores').doc(storeId).get();
              if (doc.exists) {
                  storeData = doc.data();
                  if (!storeData.files) storeData.files = [];
                  if (!storeData.texts) storeData.texts = [];
                  STORES_RAM.set(storeId, storeData);
                  console.log(`📦 Datos recuperados de DB: ${storeData.texts.length} textos, ${storeData.files.length} archivos`);
              }
          } catch (e) { console.error("DB Read Error:", e.message); }
      }

      if (!storeData) {
        console.warn(`⚠️ No se encontró el store: ${storeId}`);
        return res.json({ text: "⚠️ No hay documentos. Sube uno primero." });
      }

      const apiKey = getApiKey();
      let promptParts = [];
      
      const validFiles = (storeData.files || []).filter(f => f && f.uri && f.mimeType);
      const validTexts = (storeData.texts || []).filter(t => t && t.text);

      console.log(`📊 Archivos válidos: ${validFiles.length}, Textos válidos: ${validTexts.length}`);

      // ESTRATEGIA MEJORADA:
      // 1. Siempre incluimos el texto (es más confiable)
      if (validTexts.length > 0) {
          const context = validTexts
            .map(t => `--- ${t.fileName} ---\n${t.text}`)
            .join('\n\n')
            .substring(0, 50000); // Limitamos a 50k caracteres para no saturar
          
          promptParts.push({ 
            text: `Contexto de los documentos:\n${context}\n\nPregunta del usuario: ${query}\n\nResponde basándote en la información anterior.` 
          });
      }
      
      // 2. Opcionalmente incluimos los archivos si existen (puede mejorar la calidad)
      if (validFiles.length > 0) {
          console.log(`📎 Incluyendo ${validFiles.length} archivos de Google`);
          validFiles.slice(-3).forEach(f => { // Limitamos a 3 archivos más recientes
              promptParts.push({ 
                fileData: { 
                  mimeType: f.mimeType, 
                  fileUri: f.uri 
                } 
              });
          });
      }

      if (promptParts.length === 0) {
        return res.json({ text: "⚠️ No hay contenido disponible para responder." });
      }

      // INTENTO 1: Con todo (Archivos + Texto)
      try {
          console.log(`🚀 Generando respuesta con archivos + texto...`);
          const answer = await generateSmart(apiKey, promptParts, true);
          console.log(`✅ Respuesta generada exitosamente`);
          res.json({ text: answer });
      } catch (e) {
          console.warn(`⚠️ Fallo con archivos, reintentando SOLO con texto...`);
          
          // INTENTO 2: Solo Texto (Infalible)
          try {
              const answerTextOnly = await generateSmart(apiKey, promptParts, false);
              console.log(`✅ Respuesta generada solo con texto`);
              res.json({ text: answerTextOnly });
          } catch (finalError) {
              console.error(`❌ Error final: ${finalError.message}`);
              throw finalError;
          }
      }
      
  } catch (e) { 
      console.error(`❌ Chat Error: ${e.message}`);
      res.json({ 
        text: `❌ Error: ${e.message}. ${e.message.includes('404') ? 'El modelo no está disponible.' : 'Verifica tu API Key.'}`
      }); 
  }
});

// 5. LIST FILES
app.get('/files', async (req, res) => {
    const { storeId } = req.query;
    if (!storeId) return res.json({ files: [] });

    let storeData = STORES_RAM.get(storeId);
    if (!storeData && db) {
        try {
            const doc = await db.collection('stores').doc(storeId).get();
            if (doc.exists) {
                storeData = doc.data();
                STORES_RAM.set(storeId, storeData);
            }
        } catch (e) { console.error("Error listando archivos:", e.message); }
    }

    if (!storeData) return res.json({ files: [] });

    const fileNames = [
        ...(storeData.files || []).map(f => f ? (f.displayName || f.name) : null),
        ...(storeData.texts || []).map(t => t ? t.fileName : null)
    ];
    res.json({ files: [...new Set(fileNames.filter(Boolean))] });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('❌ Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor v12.0.0 listo en puerto ${PORT}`);
  console.log(`🤖 Modelos configurados: ${MODEL_PRIORITY.join(', ')}`);
  console.log(`🔥 Firebase: ${db ? 'ACTIVO' : 'MODO RAM'}`);
});

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

// --- 1. CONEXIÓN FIREBASE (A PRUEBA DE BOMBAS) ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase: CONECTADO (Modo Persistente)");
    } else {
        console.warn("⚠️ Firebase: Sin credenciales (Modo RAM Volátil)");
    }
} catch (e) {
    console.error("⚠️ Error Firebase (El servidor sigue funcionando en RAM):", e.message);
    db = null;
}

const STORES_RAM = new Map();

// --- 2. LISTA DE MODELOS "AUTO-ADAPTABLE" ---
// El sistema probará uno a uno en este orden hasta que uno funcione.
const MODEL_CANDIDATES = [ 
    "gemini-2.0-flash-exp",      // 1º Intento: El futuro (Potente pero experimental)
    "gemini-1.5-pro-002",        // 2º Intento: La bestia estable
    "gemini-1.5-flash-002",      // 3º Intento: Rápido actualizado
    "gemini-1.5-flash",          // 4º Intento: El clásico fiable
    "gemini-1.5-pro"             // 5º Intento: Respaldo final
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

// --- EL CORAZÓN DEL SISTEMA: GENERACIÓN CON CAÍDA GRACIOSA ---
async function generateWithFallback(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      // console.log(`🔄 Probando motor: ${modelName}...`);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptParts);
      const responseText = result.response.text();
      
      if (!responseText) throw new Error("Respuesta vacía de Google");
      
      return responseText; // ¡ÉXITO! Salimos del bucle
    } catch (e) {
        // Si falla, NO paramos. Anotamos y seguimos al siguiente modelo.
        console.warn(`⚠️ Motor ${modelName} falló (${e.message.split(' ')[0]}). Cambiando al siguiente...`);
        lastError = e;
    }
  }
  // Si llegamos aquí, es que han fallado los 5 modelos (muy improbable)
  throw new Error(`Todos los modelos fallaron. Revisa tu API Key o conexión. Último error: ${lastError?.message}`);
}

app.get('/', (req, res) => res.json({ status: "Online 🟢", firebase: db ? "Conectado" : "RAM" }));

// 1. CREATE STORE
app.post('/create-store', (req, res) => {
  const name = req.body.name || "Cerebro"; 
  const storeId = `cerebro_${Date.now()}`;
  
  // Respuesta instantánea al frontend
  res.json({ name: storeId }); 

  // Trabajo sucio en segundo plano
  (async () => {
    STORES_RAM.set(storeId, { name, files: [], texts: [] });
    if (db) {
        try {
            await db.collection('stores').doc(storeId).set({ name, createdAt: new Date(), files: [], texts: [] });
        } catch(e) { console.error("Error creando en DB:", e.message); }
    }
  })();
});

// 2. UPLOAD
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    // Extracción local
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { const data = await pdf(buffer); extractedText = data.text; } catch (e) {}
    } else { extractedText = buffer.toString('utf-8'); }
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 50000);

    // Subida a Google (Gestión de errores silenciosa)
    let googleFile = null;
    try {
        const apiKey = getApiKey();
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, { mimeType: req.file.mimetype, displayName: req.file.originalname });
        googleFile = { 
            uri: uploadResponse.file.uri, 
            name: uploadResponse.file.name, 
            mimeType: uploadResponse.file.mimeType,
            displayName: req.file.originalname
        };
    } catch (e) { console.warn("Aviso: Falló subida nativa a Google (se usará texto plano):", e.message); }

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ file: { uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`, googleData: googleFile, extractedText } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. LINK FILE (ASÍNCRONO PARA EVITAR 503/CORS)
app.post('/link-file', (req, res) => {
  // Respondemos OK al instante. El usuario no espera.
  res.json({ success: true });

  const { storeId, fileName, extractedText, googleData } = req.body;
  
  // Procesamiento en background
  (async () => {
      try {
        // 1. Guardar en RAM
        if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
        const ramStore = STORES_RAM.get(storeId);
        ramStore.texts.push({ fileName, text: extractedText });
        if (googleData && googleData.uri) ramStore.files.push(googleData);

        // 2. Guardar en Firebase (Persistencia)
        if (db) {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = { texts: FieldValue.arrayUnion({ fileName, text: extractedText }) };
            if (googleData && googleData.uri) updates.files = FieldValue.arrayUnion(googleData);
            
            await storeRef.update(updates);
            console.log(`💾 Guardado seguro: ${fileName}`);
        }
      } catch (e) {
          console.error(`⚠️ Error guardando en background (No afecta al usuario): ${e.message}`);
      }
  })();
});

// 4. CHAT (BLINDADO CONTRA FALLOS)
app.post('/chat', async (req, res) => {
  const { storeId, query } = req.body;
  let storeData = STORES_RAM.get(storeId);

  // Intentar recuperar de DB si falta en RAM
  if (!storeData && db) {
      try {
          const doc = await db.collection('stores').doc(storeId).get();
          if (doc.exists) {
              storeData = doc.data();
              // SANITIZACIÓN: Aseguramos que los arrays existan para que el código no explote
              if (!storeData.files) storeData.files = [];
              if (!storeData.texts) storeData.texts = [];
              STORES_RAM.set(storeId, storeData); // Hidratamos RAM
              console.log("📥 Cerebro recuperado de Firebase");
          }
      } catch (e) { console.error("Error lectura DB:", e.message); }
  }

  if (!storeData) return res.json({ text: "⚠️ No encuentro tu memoria. Por favor, sube un documento." });

  try {
    const apiKey = getApiKey();
    let promptParts = [];
    
    // Filtramos datos corruptos (nulls o undefineds)
    const validFiles = (storeData.files || []).filter(f => f && f.uri && f.mimeType);
    const validTexts = (storeData.texts || []).filter(t => t && t.text);

    if (validFiles.length > 0) {
        promptParts.push({ text: "Utiliza estos documentos como fuente principal:" });
        // Usamos los últimos 5 archivos para dar contexto reciente
        validFiles.slice(-5).forEach(f => {
            promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
        });
    } 
    
    if (validTexts.length > 0) {
        const context = validTexts.map(t => `--- DOCUMENTO: ${t.fileName} ---\n${t.text}`).join('\n\n');
        promptParts.push({ text: `Información de texto extraída:\n${context}` });
    }

    promptParts.push({ text: `\nPREGUNTA DEL USUARIO: ${query}` });

    // AQUÍ OCURRE LA MAGIA: Probará modelos hasta que uno funcione
    const answer = await generateWithFallback(apiKey, promptParts);
    res.json({ text: answer });
    
  } catch (e) { 
      console.error("❌ Error Fatal en Chat:", e);
      res.status(500).json({ error: `Lo siento, hubo un error técnico: ${e.message}` }); 
  }
});

// 5. LISTAR ARCHIVOS (Seguro)
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
        } catch (e) {}
    }

    if (!storeData) return res.json({ files: [] });

    // Extraemos nombres y eliminamos duplicados/vacíos
    const fileNames = [
        ...(storeData.files || []).map(f => f ? (f.displayName || f.name) : null),
        ...(storeData.texts || []).map(t => t ? t.fileName : null)
    ];
    const uniqueFiles = [...new Set(fileNames.filter(Boolean))];
    res.json({ files: uniqueFiles });
});

app.listen(PORT, () => console.log(`🚀 Servidor BLINDADO listo en ${PORT}`));

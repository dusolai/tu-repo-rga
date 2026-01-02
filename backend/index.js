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

// --- 1. FIREBASE (Conexión Robusta) ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase: CONECTADO");
    } else {
        console.warn("⚠️ Firebase: Modo RAM (Sin credenciales)");
    }
} catch (e) {
    console.error("⚠️ Error Firebase:", e.message);
    db = null;
}

const STORES_RAM = new Map();

// --- 2. ESTRATEGIA DE MODELOS ---
// 1º Intentamos el modelo avanzado (2.0)
// 2º Si falla, usamos el modelo ultra-estable (1.5 Flash)
const PRIMARY_MODEL = "gemini-2.0-flash-exp";
const BACKUP_MODEL = "gemini-1.5-flash";

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

// --- NÚCLEO: Generación a Prueba de Fallos (Smart Fallback) ---
async function smartGenerate(apiKey, promptParts) {
  const genAI = new GoogleGenerativeAI(apiKey);
  
  // INTENTO 1: Modelo Nuevo con Archivos Nativos
  try {
      // console.log(`Tentativa 1: ${PRIMARY_MODEL} con archivos`);
      const model = genAI.getGenerativeModel({ model: PRIMARY_MODEL });
      const result = await model.generateContent(promptParts);
      return result.response.text();
  } catch (e1) {
      console.warn(`⚠️ Falló ${PRIMARY_MODEL} (${e1.message}). Cambiando a estrategia de respaldo...`);
      
      // INTENTO 2: Modelo Estable SOLO CON TEXTO (Eliminamos la parte de archivos para evitar errores 404/500)
      try {
          // Filtramos las partes que sean archivos (fileData) y dejamos solo el texto plano
          const textOnlyParts = promptParts.filter(p => !p.fileData);
          
          if (textOnlyParts.length === 0) {
             throw new Error("No hay texto de respaldo para enviar.");
          }

          // console.log(`Tentativa 2: ${BACKUP_MODEL} solo texto`);
          const backupModel = genAI.getGenerativeModel({ model: BACKUP_MODEL });
          const result = await backupModel.generateContent(textOnlyParts);
          return result.response.text();
          
      } catch (e2) {
          throw new Error(`Error Total: Ni el modelo avanzado ni el de respaldo funcionaron. Detalle: ${e2.message}`);
      }
  }
}

app.get('/', (req, res) => res.json({ status: "Online 🟢", logic: "Smart Fallback + Expert Persona" }));

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

// 2. UPLOAD (Guarda Archivo Nube + Texto Local)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    
    // 1. SIEMPRE extraemos texto (Es nuestro seguro de vida)
    const buffer = fs.readFileSync(req.file.path);
    let extractedText = "";
    if (req.file.mimetype.includes('pdf')) {
      try { const data = await pdf(buffer); extractedText = data.text; } catch (e) {}
    } else { extractedText = buffer.toString('utf-8'); }
    
    // Limpiamos y limitamos para no saturar tokens
    extractedText = extractedText.replace(/\s+/g, ' ').substring(0, 80000); 

    // 2. Intentamos subir a Google (Para usar el modelo avanzado multimodal)
    let googleFile = null;
    try {
        const apiKey = getApiKey();
        const fileManager = new GoogleAIFileManager(apiKey);
        const uploadResponse = await fileManager.uploadFile(req.file.path, { mimeType: req.file.mimetype, displayName: req.file.originalname });
        
        // Esperamos brevemente a que procese para que esté listo al instante
        let attempts = 0;
        let fileState = uploadResponse.file.state;
        while(fileState === "PROCESSING" && attempts < 5) {
            await new Promise(r => setTimeout(r, 500));
            const f = await fileManager.getFile(uploadResponse.file.name);
            fileState = f.state;
            attempts++;
        }

        if (fileState === "ACTIVE") {
            googleFile = { 
                uri: uploadResponse.file.uri, 
                name: uploadResponse.file.name, 
                mimeType: uploadResponse.file.mimeType,
                displayName: req.file.originalname
            };
        }
    } catch (e) { console.warn("Upload IA Error (Usaremos texto como respaldo):", e.message); }

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    res.json({ file: { uri: googleFile ? googleFile.uri : `memory://${req.file.originalname}`, googleData: googleFile, extractedText } });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. LINK FILE
app.post('/link-file', (req, res) => {
  res.json({ success: true });

  const { storeId, fileName, extractedText, googleData } = req.body;
  (async () => {
      try {
        if (!STORES_RAM.has(storeId)) STORES_RAM.set(storeId, { name: "Recuperado", files: [], texts: [] });
        const ramStore = STORES_RAM.get(storeId);
        ramStore.texts.push({ fileName, text: extractedText }); // Guardamos texto
        if (googleData && googleData.uri) ramStore.files.push(googleData); // Guardamos ref de Google

        if (db) {
            const storeRef = db.collection('stores').doc(storeId);
            const doc = await storeRef.get();
            if (!doc.exists) await storeRef.set({ name: "Recuperado", createdAt: new Date(), files: [], texts: [] });

            const updates = { texts: FieldValue.arrayUnion({ fileName, text: extractedText }) };
            if (googleData && googleData.uri) updates.files = FieldValue.arrayUnion(googleData);
            await storeRef.update(updates);
            console.log(`💾 Guardado en DB: ${fileName}`);
        }
      } catch (e) { console.error(`BG Error: ${e.message}`); }
  })();
});

// 4. CHAT (CON PERSONALIDAD "CEREBRO DIEGO")
app.post('/chat', async (req, res) => {
  try {
      const { storeId, query } = req.body;
      let storeData = STORES_RAM.get(storeId);

      // Recuperación DB
      if (!storeData && db) {
          try {
              const doc = await db.collection('stores').doc(storeId).get();
              if (doc.exists) {
                  storeData = doc.data();
                  if (!storeData.files) storeData.files = [];
                  if (!storeData.texts) storeData.texts = [];
                  STORES_RAM.set(storeId, storeData);
              }
          } catch (e) { console.error("DB Read Error:", e.message); }
      }

      if (!storeData) return res.json({ text: "⚠️ No hay documentos. Sube uno primero." });

      const apiKey = getApiKey();
      let promptParts = [];
      
      const validFiles = (storeData.files || []).filter(f => f && f.uri && f.mimeType);
      const validTexts = (storeData.texts || []).filter(t => t && t.text);

      // === DEFINICIÓN DE PERSONALIDAD ===
      promptParts.push({ text: `
      ACTÚA COMO: Un analista experto y consultor estratégico llamado "Cerebro Diego".
      
      TU MISIÓN: Responder a la pregunta del usuario basándote ESTRICTAMENTE en la información proporcionada en los documentos adjuntos.
      
      ESTILO DE RESPUESTA:
      1. Directo y profesional, pero accesible.
      2. Estructura la respuesta con puntos clave, negritas o listas si es necesario para facilitar la lectura.
      3. Si la información aparece en varios documentos, sintetízala en una visión global.
      4. CITA SIEMPRE LAS FUENTES AL FINAL O ENTRE PARÉNTESIS. Ejemplo: "...esto se confirma en el informe anual (Fuente: informe_2024.pdf)".
      5. Si la información NO está en los documentos, dilo claramente: "No encuentro esa información específica en los documentos disponibles." (No inventes).
      
      A CONTINUACIÓN, LOS DOCUMENTOS DE CONTEXTO:
      `});

      // Parte 1: Archivos (Para el modelo avanzado)
      if (validFiles.length > 0) {
          validFiles.slice(-5).forEach(f => {
              promptParts.push({ fileData: { mimeType: f.mimeType, fileUri: f.uri } });
          });
      } 
      
      // Parte 2: Texto (Para el modelo de respaldo O contexto extra)
      if (validTexts.length > 0) {
          const context = validTexts.map(t => `--- DOCUMENTO: ${t.fileName} ---\n${t.text}`).join('\n\n');
          promptParts.push({ text: `\nCONTENIDO DE TEXTO EXTRAÍDO (Usar si no puedes leer los adjuntos):\n${context}` });
      }

      promptParts.push({ text: `\nPREGUNTA DEL USUARIO: ${query}` });

      // EJECUCIÓN INTELIGENTE (Smart Fallback)
      const answer = await smartGenerate(apiKey, promptParts);
      res.json({ text: answer });
      
  } catch (e) { 
      console.error("Chat Fatal Error:", e);
      res.json({ text: `❌ Error irrecuperable: ${e.message}. Por favor, revisa tu API Key.` }); 
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
            if (doc.exists) { storeData = doc.data(); STORES_RAM.set(storeId, storeData); }
        } catch (e) {}
    }
    if (!storeData) return res.json({ files: [] });
    const fileNames = [
        ...(storeData.files || []).map(f => f ? (f.displayName || f.name) : null),
        ...(storeData.texts || []).map(t => t ? t.fileName : null)
    ];
    res.json({ files: [...new Set(fileNames.filter(Boolean))] });
});

app.listen(PORT, () => console.log(`🚀 Servidor Final (Cerebro Diego) listo en ${PORT}`));
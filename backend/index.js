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

// --- FIREBASE ---
let db = null;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase: CONECTADO");
    }
} catch (e) {
    console.error("⚠️ Firebase:", e.message);
}

const STORES_RAM = new Map();

// ===================================
// SISTEMA DE MODELOS CON FALLBACK AUTOMÁTICO
// ===================================
const MODEL_CACHE = {
    chat: null,
    lastChecked: null
};

// Lista de modelos en orden de preferencia (del mejor al más básico)
const CHAT_MODELS_PRIORITY = [
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
    "gemini-1.5-pro-latest",
    "gemini-1.5-pro",
    "gemini-pro"
];

const EMBEDDING_MODEL = "text-embedding-004"; // Este es estable

async function getWorkingChatModel(apiKey) {
    // Si tenemos un modelo cacheado que funciona, usarlo
    const cacheAge = Date.now() - (MODEL_CACHE.lastChecked || 0);
    if (MODEL_CACHE.chat && cacheAge < 3600000) { // Cache válido por 1 hora
        return MODEL_CACHE.chat;
    }
    
    console.log("🔍 Buscando modelo de chat disponible...");
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Probar cada modelo en orden de prioridad
    for (const modelName of CHAT_MODELS_PRIORITY) {
        try {
            console.log(`   Probando: ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            
            // Probar con una consulta simple
            const result = await model.generateContent("Test");
            const text = result.response.text();
            
            if (text) {
                console.log(`   ✅ Modelo funcionando: ${modelName}`);
                MODEL_CACHE.chat = modelName;
                MODEL_CACHE.lastChecked = Date.now();
                return modelName;
            }
        } catch (error) {
            console.log(`   ❌ ${modelName} no disponible: ${error.message.substring(0, 100)}`);
            continue;
        }
    }
    
    // Si ninguno funciona, usar el último conocido o tirar error
    throw new Error("No se encontró ningún modelo de chat disponible. Verifica tu API key.");
}

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

// ===================================
// CHUNKING INTELIGENTE
// ===================================
function smartChunk(text, fileName, maxChunkSize = 1000) {
    const chunks = [];
    text = text.replace(/\s+/g, ' ').trim();
    const paragraphs = text.split(/\n{2,}|\. {2,}/);
    
    let currentChunk = "";
    let chunkIndex = 0;
    
    for (const para of paragraphs) {
        if (!para.trim()) continue;
        
        if ((currentChunk + para).length > maxChunkSize && currentChunk.length > 0) {
            chunks.push({
                id: `${fileName}_chunk_${chunkIndex}`,
                text: currentChunk.trim(),
                fileName,
                index: chunkIndex,
                charCount: currentChunk.length
            });
            chunkIndex++;
            currentChunk = "";
        }
        
        currentChunk += para + " ";
        
        if (currentChunk.length > maxChunkSize) {
            chunks.push({
                id: `${fileName}_chunk_${chunkIndex}`,
                text: currentChunk.trim(),
                fileName,
                index: chunkIndex,
                charCount: currentChunk.length
            });
            chunkIndex++;
            currentChunk = "";
        }
    }
    
    if (currentChunk.trim().length > 0) {
        chunks.push({
            id: `${fileName}_chunk_${chunkIndex}`,
            text: currentChunk.trim(),
            fileName,
            index: chunkIndex,
            charCount: currentChunk.length
        });
    }
    
    console.log(`📦 Chunking: ${text.length} chars → ${chunks.length} chunks`);
    return chunks;
}

// ===================================
// EMBEDDINGS CON RETRY
// ===================================
async function generateEmbedding(text, apiKey, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
            const result = await model.embedContent(text);
            return result.embedding.values;
        } catch (e) {
            if (e.message.includes('429') && attempt < retries) {
                const waitTime = attempt * 2000;
                console.log(`⏳ Esperando ${waitTime/1000}s antes de reintentar embedding (intento ${attempt}/${retries})...`);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }
            console.error(`Error generando embedding (intento ${attempt}/${retries}):`, e.message);
            if (attempt === retries) return null;
        }
    }
    return null;
}

// ===================================
// BÚSQUEDA SEMÁNTICA
// ===================================
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function keywordScore(query, text) {
    const queryWords = query.toLowerCase().split(/\s+/);
    const textLower = text.toLowerCase();
    
    let score = 0;
    for (const word of queryWords) {
        if (word.length < 3) continue;
        const occurrences = (textLower.match(new RegExp(word, 'g')) || []).length;
        score += occurrences;
    }
    
    return score;
}

app.get('/', (req, res) => res.json({ 
    status: "Online 🟢",
    version: "17.0.0 - AUTO MODEL DETECTION",
    features: ["Auto Model Detection", "Smart Chunking", "Embeddings", "Semantic Search"],
    models: { 
        chat: MODEL_CACHE.chat || "Auto-detect on first request",
        embedding: EMBEDDING_MODEL,
        chatPriority: CHAT_MODELS_PRIORITY
    }
}));

// 1. CREATE STORE
app.post('/create-store', async (req, res) => {
    try {
        const name = req.body.name || `Cerebro_${Date.now()}`;
        const storeId = `cerebro_${Date.now()}`;
        
        const storeData = { 
            name, 
            files: [],
            chunks: [],
            createdAt: new Date() 
        };
        
        STORES_RAM.set(storeId, storeData);
        
        if (db) {
            await db.collection('stores').doc(storeId).set(storeData);
        }
        
        console.log(`✅ Store creado: ${storeId}`);
        res.json({ name: storeId });
    } catch (error) {
        console.error("Error creando store:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. UPLOAD CON CHUNKING Y EMBEDDINGS
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        
        const apiKey = getApiKey();
        const fileName = req.file.originalname;
        
        console.log(`📤 Procesando: ${fileName}`);
        
        const buffer = fs.readFileSync(req.file.path);
        let extractedText = "";
        
        if (req.file.mimetype.includes('pdf')) {
            const data = await pdf(buffer);
            extractedText = data.text;
        } else {
            extractedText = buffer.toString('utf-8');
        }
        
        const chunks = smartChunk(extractedText, fileName);
        
        console.log(`🧮 Generando embeddings para ${chunks.length} chunks...`);
        const chunksWithEmbeddings = [];
        
        for (const chunk of chunks) {
            const embedding = await generateEmbedding(chunk.text, apiKey);
            chunksWithEmbeddings.push({
                ...chunk,
                embedding
            });
            await new Promise(r => setTimeout(r, 200));
        }
        
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        console.log(`✅ Archivo procesado: ${chunks.length} chunks con embeddings`);
        
        res.json({
            file: {
                fileName,
                extractedText: extractedText.substring(0, 500),
                chunkCount: chunks.length,
                chunks: chunksWithEmbeddings
            }
        });
    } catch (error) {
        console.error("Error en upload:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. LINK FILE
app.post('/link-file', async (req, res) => {
    try {
        const { storeId, fileName, chunks } = req.body;
        
        console.log(`🔗 Vinculando ${fileName} con ${chunks?.length || 0} chunks a ${storeId}`);
        
        if (!storeId || !fileName || !chunks || !Array.isArray(chunks)) {
            return res.status(400).json({ 
                error: 'Datos inválidos',
                received: { storeId: !!storeId, fileName: !!fileName, chunks: chunks?.length }
            });
        }
        
        let store = STORES_RAM.get(storeId);
        
        if (!store) {
            if (db) {
                const doc = await db.collection('stores').doc(storeId).get();
                if (doc.exists) {
                    store = doc.data();
                }
            }
            
            if (!store) {
                store = { name: "Recuperado", files: [], chunks: [], createdAt: new Date() };
            }
            
            STORES_RAM.set(storeId, store);
        }
        
        if (!Array.isArray(store.files)) store.files = [];
        if (!Array.isArray(store.chunks)) store.chunks = [];
        
        const fileEntry = { fileName, chunkCount: chunks.length, linkedAt: new Date() };
        
        store.files.push(fileEntry);
        store.chunks.push(...chunks);
        
        console.log(`💾 RAM: Guardados ${chunks.length} chunks. Total: ${store.chunks.length} chunks`);
        
        if (db) {
            try {
                await db.collection('stores').doc(storeId).update({
                    files: FieldValue.arrayUnion(fileEntry),
                    chunks: FieldValue.arrayUnion(...chunks)
                });
            } catch (dbError) {
                console.error("⚠️ Error guardando en Firebase:", dbError.message);
            }
        }
        
        res.json({ 
            success: true,
            stored: {
                fileName,
                chunkCount: chunks.length,
                totalChunksInStore: store.chunks.length,
                totalFilesInStore: store.files.length
            }
        });
        
        console.log(`✅ Link completado: ${fileName}`);
        
    } catch (error) {
        console.error("❌ Error en link-file:", error);
        res.status(500).json({ error: error.message });
    }
});

// 4. CHAT CON AUTO-DETECCIÓN DE MODELO
app.post('/chat', async (req, res) => {
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`💬 Pregunta: "${query}"`);
        
        let store = STORES_RAM.get(storeId);
        
        if (!store && db) {
            try {
                const doc = await db.collection('stores').doc(storeId).get();
                if (doc.exists) {
                    store = doc.data();
                    STORES_RAM.set(storeId, store);
                }
            } catch (e) {
                console.error("Error leyendo DB:", e.message);
            }
        }
        
        if (!store || !store.chunks || store.chunks.length === 0) {
            return res.json({ 
                text: "⚠️ No hay documentos indexados.",
                sources: []
            });
        }
        
        console.log(`📊 Buscando en ${store.chunks.length} chunks`);
        
        const queryEmbedding = await generateEmbedding(query, apiKey, 3);
        
        const scoredChunks = store.chunks.map(chunk => {
            const semanticScore = queryEmbedding && chunk.embedding 
                ? cosineSimilarity(queryEmbedding, chunk.embedding)
                : 0;
            
            const keywordScoreVal = keywordScore(query, chunk.text);
            const finalScore = (semanticScore * 0.7) + (keywordScoreVal * 0.3);
            
            return { ...chunk, finalScore };
        });
        
        const topChunks = scoredChunks
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, 5);
        
        console.log(`🎯 Top 5 chunks encontrados`);
        
        const context = topChunks
            .map(c => `[Fuente: ${c.fileName}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        // OBTENER MODELO DISPONIBLE AUTOMÁTICAMENTE
        const chatModel = await getWorkingChatModel(apiKey);
        console.log(`🤖 Usando modelo: ${chatModel}`);
        
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: chatModel });
        
        const prompt = `Contexto:

${context}

Pregunta: ${query}

Responde basándote SOLO en el contexto. Si no está la información, dilo claramente.`;

        let answer = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const result = await model.generateContent(prompt);
                answer = result.response.text();
                break;
            } catch (error) {
                if (error.message.includes('429') && attempt < 3) {
                    const waitTime = attempt * 3000;
                    console.log(`⏳ Esperando ${waitTime/1000}s... (intento ${attempt}/3)`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                
                // Si falla por modelo, invalidar cache y reintentar
                if (error.message.includes('404') || error.message.includes('not found')) {
                    console.log(`⚠️ Modelo ${chatModel} ya no disponible, buscando alternativa...`);
                    MODEL_CACHE.chat = null;
                    MODEL_CACHE.lastChecked = null;
                    
                    if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 1000));
                        continue;
                    }
                }
                
                throw error;
            }
        }
        
        if (!answer) {
            return res.json({
                text: "⚠️ No se pudo generar respuesta. Intenta de nuevo en unos segundos.",
                sources: []
            });
        }
        
        console.log(`✅ Respuesta generada`);
        
        res.json({
            text: answer,
            sources: topChunks.map(c => ({
                fileName: c.fileName,
                score: c.finalScore.toFixed(3)
            })),
            debug: {
                model: chatModel,
                totalChunks: store.chunks.length
            }
        });
        
    } catch (error) {
        console.error("Error en chat:", error);
        
        if (error.message.includes('429')) {
            return res.json({ 
                text: `⚠️ Límite de uso alcanzado. Espera 1 minuto.`,
                sources: []
            });
        }
        
        res.json({ 
            text: `❌ Error: ${error.message}`,
            sources: []
        });
    }
});

// 5. LIST FILES
app.get('/files', async (req, res) => {
    try {
        const { storeId } = req.query;
        if (!storeId) return res.json({ files: [], totalChunks: 0 });
        
        let store = STORES_RAM.get(storeId);
        
        if (!store && db) {
            const doc = await db.collection('stores').doc(storeId).get();
            if (doc.exists) {
                store = doc.data();
                STORES_RAM.set(storeId, store);
            }
        }
        
        if (!store) return res.json({ files: [], totalChunks: 0 });
        
        const fileNames = (store.files || []).map(f => f.fileName).filter(Boolean);
        
        res.json({ 
            files: fileNames,
            totalChunks: store.chunks?.length || 0
        });
    } catch (error) {
        res.json({ files: [], totalChunks: 0 });
    }
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({ error: 'Error interno' });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend v17.0.0 - AUTO MODEL DETECTION`);
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`🤖 Modelos disponibles (en orden):`);
  CHAT_MODELS_PRIORITY.forEach((m, i) => console.log(`   ${i+1}. ${m}`));
  console.log(`🧮 Modelo Embeddings: ${EMBEDDING_MODEL}`);
  console.log(`🔥 Firebase: ${db ? 'ACTIVO' : 'RAM ONLY'}`);
  console.log(`✨ Sistema de auto-detección activado`);
});

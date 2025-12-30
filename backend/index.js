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

// MODELOS
const CHAT_MODEL = "gemini-2.0-flash-exp";
const EMBEDDING_MODEL = "text-embedding-004";

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
// EMBEDDINGS
// ===================================
async function generateEmbedding(text, apiKey) {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (e) {
        console.error("Error generando embedding:", e.message);
        return null;
    }
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
    version: "15.0.0 - SYNC FIX",
    features: ["Smart Chunking", "Embeddings", "Semantic Search", "Synchronous Storage"]
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
            await new Promise(r => setTimeout(r, 100));
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

// 3. LINK FILE - AHORA COMPLETAMENTE SÍNCRONO
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
        
        // Recuperar o crear store
        let store = STORES_RAM.get(storeId);
        
        if (!store) {
            console.log(`⚠️ Store ${storeId} no existe en RAM, recuperando/creando...`);
            
            if (db) {
                const doc = await db.collection('stores').doc(storeId).get();
                if (doc.exists) {
                    store = doc.data();
                    console.log(`📥 Store recuperado de Firebase`);
                }
            }
            
            if (!store) {
                store = { 
                    name: "Recuperado", 
                    files: [], 
                    chunks: [],
                    createdAt: new Date()
                };
                console.log(`🆕 Store creado en RAM`);
            }
            
            STORES_RAM.set(storeId, store);
        }
        
        // Guardar en RAM (SÍNCRONO)
        const fileEntry = { 
            fileName, 
            chunkCount: chunks.length, 
            linkedAt: new Date() 
        };
        
        store.files.push(fileEntry);
        store.chunks.push(...chunks);
        
        console.log(`💾 RAM: Guardados ${chunks.length} chunks. Total: ${store.chunks.length} chunks`);
        
        // Guardar en Firebase (SÍNCRONO)
        if (db) {
            try {
                await db.collection('stores').doc(storeId).update({
                    files: FieldValue.arrayUnion(fileEntry),
                    chunks: FieldValue.arrayUnion(...chunks)
                });
                console.log(`🔥 Firebase: Chunks guardados`);
            } catch (dbError) {
                console.error("⚠️ Error guardando en Firebase (continuando):", dbError.message);
            }
        }
        
        // AHORA SÍ respondemos
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

// 4. CHAT CON DEBUG MEJORADO
app.post('/chat', async (req, res) => {
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`💬 Pregunta: "${query}" en store: ${storeId}`);
        
        // Recuperar store
        let store = STORES_RAM.get(storeId);
        
        if (!store && db) {
            console.log(`📥 Recuperando store de Firebase...`);
            try {
                const doc = await db.collection('stores').doc(storeId).get();
                if (doc.exists) {
                    store = doc.data();
                    STORES_RAM.set(storeId, store);
                    console.log(`✅ Store recuperado: ${store.chunks?.length || 0} chunks`);
                }
            } catch (e) {
                console.error("Error leyendo DB:", e.message);
            }
        }
        
        // DEBUG: Estado del store
        console.log(`📊 Estado del store:`, {
            exists: !!store,
            files: store?.files?.length || 0,
            chunks: store?.chunks?.length || 0
        });
        
        if (!store) {
            console.log(`❌ Store ${storeId} no encontrado`);
            return res.json({ 
                text: "⚠️ No hay documentos. Sube alguno primero.",
                sources: [],
                debug: { error: "Store no encontrado" }
            });
        }
        
        if (!store.chunks || store.chunks.length === 0) {
            console.log(`❌ Store ${storeId} existe pero no tiene chunks`);
            return res.json({ 
                text: "⚠️ No hay documentos indexados. Intenta subir los archivos de nuevo.",
                sources: [],
                debug: { 
                    storeExists: true,
                    filesCount: store.files?.length || 0,
                    chunksCount: 0 
                }
            });
        }
        
        console.log(`📊 Buscando en ${store.chunks.length} chunks`);
        
        // Generar embedding de la pregunta
        const queryEmbedding = await generateEmbedding(query, apiKey);
        
        // Búsqueda híbrida
        const scoredChunks = store.chunks.map(chunk => {
            const semanticScore = queryEmbedding && chunk.embedding 
                ? cosineSimilarity(queryEmbedding, chunk.embedding)
                : 0;
            
            const keywordScoreVal = keywordScore(query, chunk.text);
            const finalScore = (semanticScore * 0.7) + (keywordScoreVal * 0.3);
            
            return {
                ...chunk,
                semanticScore,
                keywordScore: keywordScoreVal,
                finalScore
            };
        });
        
        const topChunks = scoredChunks
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, 5);
        
        console.log(`🎯 Top 5 chunks:`);
        topChunks.forEach((c, i) => {
            console.log(`  ${i + 1}. ${c.fileName} (Score: ${c.finalScore.toFixed(3)})`);
        });
        
        const context = topChunks
            .map(c => `[Fuente: ${c.fileName}, Chunk ${c.index}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: CHAT_MODEL });
        
        const prompt = `Contexto extraído de los documentos:

${context}

Pregunta del usuario: ${query}

Instrucciones:
1. Responde SOLO basándote en el contexto proporcionado
2. Si la información está en el contexto, responde con confianza
3. Cita específicamente de qué fuente/chunk viene cada información
4. Si NO está en el contexto, di claramente "No encuentro esa información en los documentos"
5. Sé preciso y detallado

Respuesta:`;

        const result = await model.generateContent(prompt);
        const answer = result.response.text();
        
        console.log(`✅ Respuesta generada (${answer.length} chars)`);
        
        res.json({
            text: answer,
            sources: topChunks.map(c => ({
                fileName: c.fileName,
                chunkIndex: c.index,
                preview: c.text.substring(0, 200) + "...",
                score: c.finalScore.toFixed(3)
            })),
            debug: {
                storeId,
                totalChunks: store.chunks.length,
                totalFiles: store.files.length,
                topScores: topChunks.map(c => c.finalScore.toFixed(3))
            }
        });
        
    } catch (error) {
        console.error("Error en chat:", error);
        res.json({ 
            text: `❌ Error: ${error.message}`,
            sources: [],
            debug: { error: error.message }
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
        
        const fileNames = (store.files || [])
            .map(f => f.fileName)
            .filter(Boolean);
        
        res.json({ 
            files: fileNames,
            totalChunks: store.chunks?.length || 0
        });
    } catch (error) {
        console.error("Error en /files:", error);
        res.json({ files: [], totalChunks: 0 });
    }
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({ error: 'Error interno' });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend v15.0.0 - SYNC FIX`);
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`🤖 Modelo Chat: ${CHAT_MODEL}`);
  console.log(`🧮 Modelo Embeddings: ${EMBEDDING_MODEL}`);
  console.log(`🔥 Firebase: ${db ? 'ACTIVO' : 'RAM ONLY'}`);
  console.log(`✨ Features: Synchronous Storage + Debug Logs`);
});

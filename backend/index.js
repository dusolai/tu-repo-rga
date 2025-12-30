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
const EMBEDDING_MODEL = "text-embedding-004"; // Para vectores

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
// CHUNKING INTELIGENTE (Como NotebookLM)
// ===================================
function smartChunk(text, fileName, maxChunkSize = 1000) {
    const chunks = [];
    
    // Limpiar texto
    text = text.replace(/\s+/g, ' ').trim();
    
    // Dividir por párrafos primero
    const paragraphs = text.split(/\n{2,}|\. {2,}/);
    
    let currentChunk = "";
    let chunkIndex = 0;
    
    for (const para of paragraphs) {
        if (!para.trim()) continue;
        
        // Si el párrafo + chunk actual es muy grande, guardamos el chunk
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
        
        // Si el chunk actual supera el tamaño, lo guardamos
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
    
    // Guardar el último chunk
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
// EMBEDDINGS (Vectores para búsqueda semántica)
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
// BÚSQUEDA SEMÁNTICA (Similitud Coseno)
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

// ===================================
// BÚSQUEDA HÍBRIDA (Keyword + Semántica)
// ===================================
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
    version: "14.0.0 - NotebookLM Style",
    features: ["Smart Chunking", "Embeddings", "Semantic Search", "Hybrid Ranking"]
}));

// 1. CREATE STORE
app.post('/create-store', async (req, res) => {
    const name = req.body.name || `Cerebro_${Date.now()}`;
    const storeId = `cerebro_${Date.now()}`;
    
    STORES_RAM.set(storeId, { 
        name, 
        files: [],
        chunks: [],
        embeddings: [],
        createdAt: new Date() 
    });
    
    if (db) {
        try {
            await db.collection('stores').doc(storeId).set({
                name,
                files: [],
                chunks: [],
                embeddings: [],
                createdAt: new Date()
            });
        } catch (e) {
            console.error("Error DB:", e.message);
        }
    }
    
    console.log(`✅ Store creado: ${storeId}`);
    res.json({ name: storeId });
});

// 2. UPLOAD CON CHUNKING Y EMBEDDINGS
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        
        const apiKey = getApiKey();
        const fileName = req.file.originalname;
        
        console.log(`📤 Procesando: ${fileName}`);
        
        // 1. Extraer texto
        const buffer = fs.readFileSync(req.file.path);
        let extractedText = "";
        
        if (req.file.mimetype.includes('pdf')) {
            const data = await pdf(buffer);
            extractedText = data.text;
        } else {
            extractedText = buffer.toString('utf-8');
        }
        
        // 2. Chunking inteligente
        const chunks = smartChunk(extractedText, fileName);
        
        // 3. Generar embeddings para cada chunk
        console.log(`🧮 Generando embeddings para ${chunks.length} chunks...`);
        const chunksWithEmbeddings = [];
        
        for (const chunk of chunks) {
            const embedding = await generateEmbedding(chunk.text, apiKey);
            chunksWithEmbeddings.push({
                ...chunk,
                embedding
            });
            
            // Pequeña pausa para no saturar la API
            await new Promise(r => setTimeout(r, 100));
        }
        
        // Limpiar archivo temporal
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        console.log(`✅ Archivo procesado: ${chunks.length} chunks con embeddings`);
        
        res.json({
            file: {
                fileName,
                extractedText: extractedText.substring(0, 500), // Solo preview
                chunkCount: chunks.length,
                chunks: chunksWithEmbeddings
            }
        });
    } catch (error) {
        console.error("Error en upload:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. LINK FILE (Guardar chunks con embeddings)
app.post('/link-file', async (req, res) => {
    res.json({ success: true });
    
    const { storeId, fileName, chunks } = req.body;
    
    (async () => {
        try {
            if (!STORES_RAM.has(storeId)) {
                STORES_RAM.set(storeId, { name: "Recuperado", files: [], chunks: [], embeddings: [] });
            }
            
            const store = STORES_RAM.get(storeId);
            
            // Guardar chunks
            store.files.push({ fileName, chunkCount: chunks.length, linkedAt: new Date() });
            store.chunks.push(...chunks);
            
            console.log(`💾 Guardados ${chunks.length} chunks para ${fileName}`);
            
            if (db) {
                try {
                    await db.collection('stores').doc(storeId).update({
                        files: FieldValue.arrayUnion({ fileName, chunkCount: chunks.length }),
                        chunks: FieldValue.arrayUnion(...chunks)
                    });
                } catch (e) {
                    console.error("Error guardando en DB:", e.message);
                }
            }
        } catch (e) {
            console.error("Error en link:", e.message);
        }
    })();
});

// 4. CHAT CON BÚSQUEDA SEMÁNTICA HÍBRIDA
app.post('/chat', async (req, res) => {
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`💬 Pregunta: "${query}"`);
        
        // Recuperar store
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
                text: "⚠️ No hay documentos. Sube alguno primero.",
                sources: []
            });
        }
        
        console.log(`📊 Buscando en ${store.chunks.length} chunks`);
        
        // 1. Generar embedding de la pregunta
        const queryEmbedding = await generateEmbedding(query, apiKey);
        
        // 2. Búsqueda híbrida (semántica + keyword)
        const scoredChunks = store.chunks.map(chunk => {
            const semanticScore = queryEmbedding && chunk.embedding 
                ? cosineSimilarity(queryEmbedding, chunk.embedding)
                : 0;
            
            const keywordScoreVal = keywordScore(query, chunk.text);
            
            // Combinar scores (70% semántico, 30% keyword)
            const finalScore = (semanticScore * 0.7) + (keywordScoreVal * 0.3);
            
            return {
                ...chunk,
                semanticScore,
                keywordScore: keywordScoreVal,
                finalScore
            };
        });
        
        // 3. Ordenar por score y tomar top 5
        const topChunks = scoredChunks
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, 5);
        
        console.log(`🎯 Top 5 chunks encontrados:`);
        topChunks.forEach((c, i) => {
            console.log(`  ${i + 1}. ${c.fileName} (Score: ${c.finalScore.toFixed(3)}) - "${c.text.substring(0, 50)}..."`);
        });
        
        // 4. Construir contexto
        const context = topChunks
            .map(c => `[Fuente: ${c.fileName}, Chunk ${c.index}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        // 5. Generar respuesta con el modelo
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
                totalChunks: store.chunks.length,
                topScores: topChunks.map(c => c.finalScore.toFixed(3))
            }
        });
        
    } catch (error) {
        console.error("Error en chat:", error);
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
        if (!storeId) return res.json({ files: [] });
        
        let store = STORES_RAM.get(storeId);
        if (!store && db) {
            try {
                const doc = await db.collection('stores').doc(storeId).get();
                if (doc.exists) {
                    store = doc.data();
                    STORES_RAM.set(storeId, store);
                }
            } catch (e) {
                console.error("Error leyendo archivos:", e.message);
            }
        }
        
        if (!store) return res.json({ files: [] });
        
        const fileNames = (store.files || [])
            .map(f => f.fileName)
            .filter(Boolean);
        
        res.json({ 
            files: fileNames,
            totalChunks: store.chunks?.length || 0
        });
    } catch (error) {
        res.json({ files: [] });
    }
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({ error: 'Error interno' });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend v14.0.0 - NotebookLM Style`);
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`🤖 Modelo Chat: ${CHAT_MODEL}`);
  console.log(`🧮 Modelo Embeddings: ${EMBEDDING_MODEL}`);
  console.log(`🔥 Firebase: ${db ? 'ACTIVO' : 'RAM'}`);
  console.log(`✨ Features: Smart Chunking + Semantic Search + Hybrid Ranking`);
});

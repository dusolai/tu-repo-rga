const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

const STORES_RAM = new Map();

// MODELOS ESTABLES (API v1 - SIN BETA)
const CHAT_MODEL = "gemini-1.5-flash"; // Modelo principal
const FALLBACK_MODEL = "gemini-pro"; // Respaldo si falla el principal
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
// CHUNKING
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
async function generateEmbedding(text, apiKey, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
            const result = await model.embedContent(text);
            return result.embedding.values;
        } catch (e) {
            if (e.message.includes('429') && attempt < retries) {
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
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
    
    let dotProduct = 0, normA = 0, normB = 0;
    
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
    version: "18.0.0 - STABLE MODELS ONLY",
    models: { 
        chat: CHAT_MODEL,
        fallback: FALLBACK_MODEL,
        embedding: EMBEDDING_MODEL
    }
}));

// 1. CREATE STORE
app.post('/create-store', async (req, res) => {
    try {
        const storeId = `cerebro_${Date.now()}`;
        const storeData = { 
            name: req.body.name || storeId,
            files: [],
            chunks: [],
            createdAt: new Date() 
        };
        
        STORES_RAM.set(storeId, storeData);
        console.log(`✅ Store creado: ${storeId}`);
        res.json({ name: storeId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. UPLOAD
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
        
        console.log(`🧮 Generando embeddings...`);
        const chunksWithEmbeddings = [];
        
        for (const chunk of chunks) {
            const embedding = await generateEmbedding(chunk.text, apiKey);
            chunksWithEmbeddings.push({ ...chunk, embedding });
            await new Promise(r => setTimeout(r, 200));
        }
        
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        console.log(`✅ Procesado: ${chunks.length} chunks`);
        
        res.json({
            file: {
                fileName,
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
        
        if (!storeId || !fileName || !chunks) {
            return res.status(400).json({ error: 'Datos inválidos' });
        }
        
        let store = STORES_RAM.get(storeId);
        if (!store) {
            store = { name: "Recuperado", files: [], chunks: [] };
            STORES_RAM.set(storeId, store);
        }
        
        if (!Array.isArray(store.files)) store.files = [];
        if (!Array.isArray(store.chunks)) store.chunks = [];
        
        store.files.push({ fileName, chunkCount: chunks.length });
        store.chunks.push(...chunks);
        
        console.log(`💾 Guardados ${chunks.length} chunks`);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. CHAT - SIMPLE Y ROBUSTO
app.post('/chat', async (req, res) => {
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`💬 Pregunta: "${query}"`);
        
        const store = STORES_RAM.get(storeId);
        
        if (!store || !store.chunks || store.chunks.length === 0) {
            return res.json({ 
                text: "⚠️ No hay documentos indexados.",
                sources: []
            });
        }
        
        console.log(`📊 Buscando en ${store.chunks.length} chunks`);
        
        const queryEmbedding = await generateEmbedding(query, apiKey);
        
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
        
        console.log(`🎯 Top chunks: ${topChunks.map(c => c.finalScore.toFixed(3)).join(', ')}`);
        
        const context = topChunks
            .map(c => `[${c.fileName}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        const genAI = new GoogleGenerativeAI(apiKey);
        
        // Intentar con modelo principal, luego fallback
        let answer = null;
        const modelsToTry = [CHAT_MODEL, FALLBACK_MODEL];
        
        for (const modelName of modelsToTry) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    console.log(`🤖 Intentando con modelo: ${modelName} (intento ${attempt})`);
                    
                    const model = genAI.getGenerativeModel({ model: modelName });
                    
                    const result = await model.generateContent({
                        contents: [{
                            role: "user",
                            parts: [{
                                text: `Contexto:\n${context}\n\nPregunta: ${query}\n\nResponde basándote SOLO en el contexto.`
                            }]
                        }]
                    });
                    
                    answer = result.response.text();
                    
                    if (answer) {
                        console.log(`✅ Respuesta generada con ${modelName}`);
                        break;
                    }
                } catch (error) {
                    console.log(`⚠️ ${modelName} falló: ${error.message.substring(0, 100)}`);
                    
                    if (error.message.includes('429')) {
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                    
                    break; // Probar siguiente modelo
                }
            }
            
            if (answer) break;
        }
        
        if (!answer) {
            return res.json({
                text: "⚠️ Error temporal. Intenta de nuevo en unos segundos.",
                sources: []
            });
        }
        
        res.json({
            text: answer,
            sources: topChunks.map(c => ({
                fileName: c.fileName,
                score: c.finalScore.toFixed(3)
            }))
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
app.get('/files', (req, res) => {
    const { storeId } = req.query;
    const store = STORES_RAM.get(storeId);
    
    if (!store) return res.json({ files: [], totalChunks: 0 });
    
    res.json({ 
        files: (store.files || []).map(f => f.fileName),
        totalChunks: store.chunks?.length || 0
    });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend v18.0.0 - STABLE MODELS ONLY`);
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`🤖 Modelo Chat Principal: ${CHAT_MODEL}`);
  console.log(`🔄 Modelo Fallback: ${FALLBACK_MODEL}`);
  console.log(`🧮 Modelo Embeddings: ${EMBEDDING_MODEL}`);
  console.log(`✨ Sin dependencias externas, 100% RAM`);
});

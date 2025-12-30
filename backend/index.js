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

// MODELOS
const CHAT_MODEL = "gemini-1.5-flash";
const FALLBACK_MODEL = "gemini-pro";
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

// CHUNKING
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

// EMBEDDINGS
async function generateEmbedding(text, apiKey, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
            const result = await model.embedContent(text);
            return result.embedding.values;
        } catch (e) {
            console.error(`❌ Error embedding (intento ${attempt}/${retries}):`, e.message);
            if (e.message.includes('429') && attempt < retries) {
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            if (attempt === retries) return null;
        }
    }
    return null;
}

// BÚSQUEDA
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
    version: "19.0.0 - DIAGNOSTIC MODE",
    models: { chat: CHAT_MODEL, fallback: FALLBACK_MODEL, embedding: EMBEDDING_MODEL }
}));

// CREATE STORE
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
        console.error("❌ Error creando store:", error);
        res.status(500).json({ error: error.message });
    }
});

// UPLOAD
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
        console.error("❌ Error en upload:", error);
        res.status(500).json({ error: error.message });
    }
});

// LINK FILE
app.post('/link-file', async (req, res) => {
    try {
        const { storeId, fileName, chunks } = req.body;
        
        console.log(`🔗 Link request: storeId=${storeId}, fileName=${fileName}, chunks=${chunks?.length}`);
        
        if (!storeId || !fileName || !chunks) {
            return res.status(400).json({ error: 'Datos inválidos' });
        }
        
        let store = STORES_RAM.get(storeId);
        if (!store) {
            console.log(`⚠️ Store ${storeId} no encontrado, creando uno nuevo`);
            store = { name: "Recuperado", files: [], chunks: [] };
            STORES_RAM.set(storeId, store);
        }
        
        if (!Array.isArray(store.files)) store.files = [];
        if (!Array.isArray(store.chunks)) store.chunks = [];
        
        store.files.push({ fileName, chunkCount: chunks.length });
        store.chunks.push(...chunks);
        
        console.log(`💾 Guardados ${chunks.length} chunks. Total en store: ${store.chunks.length}`);
        
        res.json({ success: true });
    } catch (error) {
        console.error("❌ Error en link-file:", error);
        res.status(500).json({ error: error.message });
    }
});

// CHAT - CON LOGGING EXHAUSTIVO
app.post('/chat', async (req, res) => {
    const logPrefix = `[${new Date().toISOString()}]`;
    
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`${logPrefix} 💬 Pregunta: "${query}" en store: ${storeId}`);
        
        const store = STORES_RAM.get(storeId);
        
        if (!store) {
            console.error(`${logPrefix} ❌ Store ${storeId} NO EXISTE en RAM`);
            return res.json({ 
                text: "⚠️ Store no encontrado en memoria.",
                sources: [],
                debug: { error: "Store not found in RAM", storeId }
            });
        }
        
        console.log(`${logPrefix} 📊 Store encontrado:`, {
            name: store.name,
            fileCount: store.files?.length || 0,
            chunkCount: store.chunks?.length || 0
        });
        
        if (!store.chunks || store.chunks.length === 0) {
            console.error(`${logPrefix} ❌ Store vacío (${store.chunks?.length || 0} chunks)`);
            return res.json({ 
                text: "⚠️ No hay documentos indexados.",
                sources: [],
                debug: { 
                    error: "No chunks in store", 
                    storeExists: true,
                    chunkCount: 0 
                }
            });
        }
        
        console.log(`${logPrefix} 🧮 Generando embedding para query...`);
        const queryEmbedding = await generateEmbedding(query, apiKey);
        
        if (!queryEmbedding) {
            console.error(`${logPrefix} ❌ No se pudo generar embedding para la query`);
            return res.json({
                text: "⚠️ Error generando embedding. Intenta de nuevo.",
                sources: [],
                debug: { error: "Failed to generate query embedding" }
            });
        }
        
        console.log(`${logPrefix} ✅ Embedding generado (${queryEmbedding.length} dimensiones)`);
        
        console.log(`${logPrefix} 🔍 Calculando similitud con ${store.chunks.length} chunks...`);
        
        const scoredChunks = store.chunks.map(chunk => {
            const semanticScore = queryEmbedding && chunk.embedding 
                ? cosineSimilarity(queryEmbedding, chunk.embedding)
                : 0;
            
            const keywordScoreVal = keywordScore(query, chunk.text);
            const finalScore = (semanticScore * 0.7) + (keywordScoreVal * 0.3);
            
            return { ...chunk, finalScore, semanticScore, keywordScoreVal };
        });
        
        const topChunks = scoredChunks
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, 5);
        
        console.log(`${logPrefix} 🎯 Top 5 chunks:`);
        topChunks.forEach((c, i) => {
            console.log(`   ${i+1}. Score=${c.finalScore.toFixed(3)} (Sem=${c.semanticScore.toFixed(3)}, Kw=${c.keywordScoreVal}) - ${c.fileName}`);
        });
        
        const context = topChunks
            .map(c => `[${c.fileName}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        console.log(`${logPrefix} 📝 Contexto generado: ${context.length} chars`);
        
        const genAI = new GoogleGenerativeAI(apiKey);
        let answer = null;
        const modelsToTry = [CHAT_MODEL, FALLBACK_MODEL];
        let lastError = null;
        
        for (const modelName of modelsToTry) {
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    console.log(`${logPrefix} 🤖 Llamando a ${modelName} (intento ${attempt})...`);
                    
                    const model = genAI.getGenerativeModel({ model: modelName });
                    
                    const prompt = `Contexto:\n${context}\n\nPregunta: ${query}\n\nResponde basándote SOLO en el contexto.`;
                    
                    const result = await model.generateContent({
                        contents: [{
                            role: "user",
                            parts: [{ text: prompt }]
                        }]
                    });
                    
                    answer = result.response.text();
                    
                    if (answer) {
                        console.log(`${logPrefix} ✅ Respuesta generada con ${modelName} (${answer.length} chars)`);
                        break;
                    }
                } catch (error) {
                    lastError = error;
                    console.error(`${logPrefix} ❌ ${modelName} falló (intento ${attempt}):`, {
                        message: error.message,
                        code: error.code,
                        status: error.status,
                        stack: error.stack?.substring(0, 200)
                    });
                    
                    if (error.message.includes('429')) {
                        console.log(`${logPrefix} ⏳ Rate limit, esperando 3s...`);
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                    
                    break; // No reintentar si no es 429
                }
            }
            
            if (answer) break;
        }
        
        if (!answer) {
            console.error(`${logPrefix} ❌ TODOS LOS MODELOS FALLARON`);
            console.error(`${logPrefix} Último error:`, lastError);
            
            return res.json({
                text: `⚠️ Error generando respuesta: ${lastError?.message || 'Desconocido'}`,
                sources: [],
                debug: {
                    error: lastError?.message,
                    errorCode: lastError?.code,
                    errorStatus: lastError?.status,
                    modelsAttempted: modelsToTry,
                    contextLength: context.length,
                    topScores: topChunks.map(c => c.finalScore.toFixed(3))
                }
            });
        }
        
        console.log(`${logPrefix} ✅ Respuesta completa enviada`);
        
        res.json({
            text: answer,
            sources: topChunks.map(c => ({
                fileName: c.fileName,
                score: c.finalScore.toFixed(3)
            })),
            debug: {
                chunkCount: store.chunks.length,
                topScores: topChunks.map(c => c.finalScore.toFixed(3))
            }
        });
        
    } catch (error) {
        console.error(`${logPrefix} ❌ ERROR CRÍTICO EN CHAT:`, {
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        
        res.json({ 
            text: `❌ Error crítico: ${error.message}`,
            sources: [],
            debug: {
                criticalError: error.message,
                errorType: error.name
            }
        });
    }
});

// LIST FILES
app.get('/files', (req, res) => {
    const { storeId } = req.query;
    const store = STORES_RAM.get(storeId);
    
    if (!store) {
        console.log(`⚠️ /files: Store ${storeId} no encontrado`);
        return res.json({ files: [], totalChunks: 0 });
    }
    
    res.json({ 
        files: (store.files || []).map(f => f.fileName),
        totalChunks: store.chunks?.length || 0
    });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend v19.0.0 - DIAGNOSTIC MODE`);
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`🤖 Modelo Chat: ${CHAT_MODEL} / Fallback: ${FALLBACK_MODEL}`);
  console.log(`🔍 Logging exhaustivo activado`);
});

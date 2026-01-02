const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');
const admin = require('firebase-admin');

// ===== INICIALIZAR FIREBASE CON PROYECTO CORRECTO =====
try {
    admin.initializeApp({
        projectId: 'entradas24december'
    });
    console.log('✅ Firebase Admin inicializado: entradas24december');
} catch (error) {
    if (error.code !== 'app/duplicate-app') {
        console.error('❌ Error inicializando Firebase:', error.message);
    }
}

const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// ✅ USAR MODELO MÁS ECONÓMICO PERO EFECTIVO
const CHAT_MODEL = "gemini-1.5-flash-8b"; // Modelo más económico
const EMBEDDING_MODEL = "text-embedding-004";

// Cache simple en memoria para reducir llamadas
const queryCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

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
                index: chunkIndex
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
                index: chunkIndex
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
            index: chunkIndex
        });
    }
    
    console.log(`📦 Chunking: ${text.length} chars → ${chunks.length} chunks`);
    return chunks;
}

async function generateEmbedding(text, apiKey, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
            const result = await model.embedContent(text);
            return result.embedding.values;
        } catch (e) {
            if (e.message.includes('429') && attempt < retries) {
                console.log(`⏳ Cuota alcanzada, esperando ${2 * attempt}s...`);
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            if (attempt === retries) {
                console.error('❌ No se pudo generar embedding después de reintentos');
                return null;
            }
        }
    }
    return null;
}

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
    version: "24.0.0 - OPTIMIZED (entradas24december)",
    models: { 
        chat: CHAT_MODEL, 
        embedding: EMBEDDING_MODEL 
    },
    database: "Firestore ✅",
    project: "entradas24december",
    features: [
        "Cache de queries (5min TTL)",
        "Modelo económico (gemini-1.5-flash-8b)",
        "Reintentos automáticos con backoff",
        "Respuestas acortadas si superan límite"
    ]
}));

app.post('/create-store', async (req, res) => {
    try {
        const storeId = `cerebro_${Date.now()}`;
        
        await db.collection('stores').doc(storeId).set({
            name: req.body.name || storeId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            files: []
        });
        
        console.log(`✅ Store creado en Firestore (entradas24december): ${storeId}`);
        res.json({ name: storeId });
    } catch (error) {
        console.error('❌ Error creando store:', error);
        res.status(500).json({ error: error.message });
    }
});

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
        const chunksWithEmbeddings = [];
        
        for (const chunk of chunks) {
            const embedding = await generateEmbedding(chunk.text, apiKey);
            chunksWithEmbeddings.push({ ...chunk, embedding });
            // Pausa más larga para evitar cuotas
            await new Promise(r => setTimeout(r, 500));
        }
        
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        res.json({
            file: {
                fileName,
                chunkCount: chunks.length,
                chunks: chunksWithEmbeddings
            }
        });
    } catch (error) {
        console.error('❌ Error en upload:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/link-file', async (req, res) => {
    try {
        const { storeId, fileName, chunks } = req.body;
        
        if (!storeId || !fileName || !chunks) {
            return res.status(400).json({ error: 'Datos inválidos' });
        }
        
        console.log(`💾 Guardando ${chunks.length} chunks en Firestore (entradas24december) para ${storeId}`);
        
        const storeRef = db.collection('stores').doc(storeId);
        const storeDoc = await storeRef.get();
        
        let filesArray = [];
        if (storeDoc.exists) {
            filesArray = storeDoc.data().files || [];
        } else {
            await storeRef.set({
                name: storeId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                files: []
            });
        }
        
        filesArray.push({
            displayName: fileName,
            chunkCount: chunks.length,
            uploadedAt: new Date().toISOString()
        });
        
        await storeRef.update({ files: filesArray });
        
        // Guardar chunks en batch
        const batch = db.batch();
        
        chunks.forEach((chunk, index) => {
            const chunkRef = storeRef.collection('chunks').doc(`${fileName}_${index}`);
            batch.set(chunkRef, {
                text: chunk.text,
                fileName: chunk.fileName,
                index: chunk.index || index,
                embedding: chunk.embedding,
                createdAt: new Date().toISOString()
            });
        });
        
        await batch.commit();
        
        console.log(`✅ ${chunks.length} chunks guardados en Firestore (entradas24december)`);
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error en link-file:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`💬 Pregunta: "${query}" en store: ${storeId}`);
        
        // Verificar cache
        const cacheKey = `${storeId}:${query.toLowerCase().trim()}`;
        if (queryCache.has(cacheKey)) {
            const cached = queryCache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                console.log('📦 Respuesta desde cache');
                return res.json(cached.data);
            } else {
                queryCache.delete(cacheKey);
            }
        }
        
        // Leer chunks desde Firestore
        const chunksSnapshot = await db.collection('stores')
            .doc(storeId)
            .collection('chunks')
            .get();
        
        if (chunksSnapshot.empty) {
            console.log(`⚠️ No hay chunks en ${storeId}`);
            return res.json({ 
                text: "⚠️ No hay documentos indexados en este cerebro.",
                sources: []
            });
        }
        
        const chunks = [];
        chunksSnapshot.forEach(doc => {
            chunks.push(doc.data());
        });
        
        console.log(`📚 Recuperados ${chunks.length} chunks de Firestore (entradas24december)`);
        
        const queryEmbedding = await generateEmbedding(query, apiKey);
        
        if (!queryEmbedding) {
            // Si no se puede generar embedding, usar solo keywords
            console.log('⚠️ Usando solo búsqueda por keywords');
            const scoredChunks = chunks.map(chunk => ({
                ...chunk,
                finalScore: keywordScore(query, chunk.text)
            }));
            
            const topChunks = scoredChunks
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, 3);
            
            const responseData = {
                text: "⚠️ Búsqueda limitada por cuota de API. Documentos relevantes:\n\n" +
                      topChunks.map((c, i) => 
                          `${i+1}. **${c.fileName}** (Relevancia: ${(c.finalScore * 10).toFixed(0)}%)\n${c.text.substring(0, 200)}...`
                      ).join('\n\n'),
                sources: topChunks.map(c => ({
                    fileName: c.fileName,
                    score: c.finalScore.toFixed(3)
                }))
            };
            
            return res.json(responseData);
        }
        
        const scoredChunks = chunks.map(chunk => {
            const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
            const keywordScoreVal = keywordScore(query, chunk.text);
            const finalScore = (semanticScore * 0.7) + (keywordScoreVal * 0.3);
            
            return { ...chunk, finalScore };
        });
        
        const topChunks = scoredChunks
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, 5);
        
        console.log(`🎯 Top 5 chunks: ${topChunks.map(c => c.finalScore.toFixed(3)).join(', ')}`);
        
        const context = topChunks
            .map(c => `[${c.fileName}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: CHAT_MODEL });
        
        // Prompt más corto para ahorrar tokens
        const prompt = `Contexto:\n${context}\n\nPregunta: ${query}\n\nResponde de forma concisa basándote solo en el contexto:`;

        try {
            console.log(`🤖 Llamando a ${CHAT_MODEL}...`);
            
            const result = await model.generateContent(prompt);
            const answer = result.response.text();
            
            // Limitar respuesta si es muy larga
            const maxLength = 1500;
            const finalAnswer = answer.length > maxLength 
                ? answer.substring(0, maxLength) + '\n\n... (respuesta acortada por límites)' 
                : answer;
            
            console.log(`✅ Respuesta generada: ${finalAnswer.substring(0, 100)}...`);
            
            const responseData = {
                text: finalAnswer,
                sources: topChunks.map(c => ({
                    fileName: c.fileName,
                    score: c.finalScore.toFixed(3)
                }))
            };
            
            // Guardar en cache
            queryCache.set(cacheKey, {
                data: responseData,
                timestamp: Date.now()
            });
            
            res.json(responseData);
            
        } catch (error) {
            console.error(`❌ Error con ${CHAT_MODEL}:`, error.message);
            
            // Respuesta de fallback sin llamar al modelo
            const fallbackResponse = {
                text: `Documentos relevantes encontrados:\n\n` +
                      topChunks.map((c, i) => 
                          `${i+1}. **${c.fileName}** (Relevancia: ${(c.finalScore * 100).toFixed(0)}%)`
                      ).join('\n'),
                sources: topChunks.map(c => ({
                    fileName: c.fileName,
                    score: c.finalScore.toFixed(3)
                }))
            };
            
            res.json(fallbackResponse);
        }
        
    } catch (error) {
        console.error("❌ Error en chat:", error);
        res.json({ 
            text: `❌ Error: ${error.message}`,
            sources: []
        });
    }
});

app.get('/files', async (req, res) => {
    try {
        const { storeId } = req.query;
        
        const storeDoc = await db.collection('stores').doc(storeId).get();
        
        if (!storeDoc.exists) {
            return res.json({ files: [], totalChunks: 0 });
        }
        
        const storeData = storeDoc.data();
        const files = storeData.files || [];
        
        const chunksSnapshot = await db.collection('stores')
            .doc(storeId)
            .collection('chunks')
            .get();
        
        res.json({ 
            files: files.map(f => f.displayName),
            totalChunks: chunksSnapshot.size
        });
    } catch (error) {
        console.error('❌ Error listando archivos:', error);
        res.json({ files: [], totalChunks: 0 });
    }
});

// Limpiar cache cada 10 minutos
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of queryCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            queryCache.delete(key);
        }
    }
    console.log(`🧹 Cache limpiado: ${queryCache.size} entradas activas`);
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Backend v24.0.0 - OPTIMIZED`);
  console.log(`🤖 Modelo: ${CHAT_MODEL} (económico)`);
  console.log(`💾 Base de datos: Firestore (entradas24december)`);
  console.log(`📦 Cache: Activo (5min TTL)`);
  console.log(`✅ Puerto: ${PORT}`);
});
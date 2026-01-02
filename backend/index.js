const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const pdf = require('pdf-parse');
const admin = require('firebase-admin');

// ===== FIREBASE =====
try {
    admin.initializeApp({
        projectId: 'entradas24december'
    });
    console.log('✅ Firebase: entradas24december');
} catch (error) {
    if (error.code !== 'app/duplicate-app') {
        console.error('❌ Firebase:', error.message);
    }
}

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

// 🏆 MODELO PREMIUM
const CHAT_MODEL = "gemini-2.5-flash";
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

// ===== CHUNKING =====
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
    
    return chunks;
}

// ===== EMBEDDINGS =====
async function generateEmbedding(text, apiKey, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
            const result = await model.embedContent(text);
            return result.embedding.values;
        } catch (e) {
            console.error(`❌ Embedding intento ${attempt}:`, e.message);
            if (e.message.includes('429') && attempt < retries) {
                const waitTime = 2000 * attempt;
                console.log(`⏳ Esperando ${waitTime}ms...`);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }
            if (attempt === retries) {
                throw new Error(`Fallo generando embedding después de ${retries} intentos`);
            }
        }
    }
}

// ===== SIMILITUD =====
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

app.get('/', (req, res) => res.json({ 
    status: "Online 🟢",
    version: "27.0.0 - CEREBRO OPTIMIZADO",
    models: { chat: CHAT_MODEL, embedding: EMBEDDING_MODEL },
    project: "entradas24december"
}));

app.post('/create-store', async (req, res) => {
    try {
        const storeId = `cerebro_${Date.now()}`;
        await db.collection('stores').doc(storeId).set({
            name: req.body.name || storeId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            files: []
        });
        console.log(`✅ Store: ${storeId}`);
        res.json({ name: storeId });
    } catch (error) {
        console.error('❌ Create:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        
        const apiKey = getApiKey();
        const fileName = req.file.originalname;
        
        console.log(`📤 ${fileName}`);
        
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
            await new Promise(r => setTimeout(r, 300)); // Evitar rate limit
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
        console.error('❌ Upload:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/link-file', async (req, res) => {
    try {
        const { storeId, fileName, chunks } = req.body;
        
        if (!storeId || !fileName || !chunks) {
            return res.status(400).json({ error: 'Datos inválidos' });
        }
        
        console.log(`💾 ${chunks.length} chunks → ${storeId}`);
        
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
        console.log(`✅ Guardado`);
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Link:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===== CHAT - SIN FALLBACKS INNECESARIOS =====
app.post('/chat', async (req, res) => {
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`\n💬 Consulta: "${query}"`);
        
        // 1. OBTENER CHUNKS
        const chunksSnapshot = await db.collection('stores')
            .doc(storeId)
            .collection('chunks')
            .get();
        
        if (chunksSnapshot.empty) {
            return res.json({ 
                text: "⚠️ No hay documentos indexados en este cerebro. Sube archivos primero.",
                sources: []
            });
        }
        
        const chunks = [];
        chunksSnapshot.forEach(doc => chunks.push(doc.data()));
        console.log(`📚 ${chunks.length} chunks disponibles`);
        
        // 2. GENERAR EMBEDDING DE LA CONSULTA
        console.log(`🔢 Generando embedding de consulta...`);
        const queryEmbedding = await generateEmbedding(query, apiKey);
        
        // 3. CALCULAR SIMILITUD
        console.log(`🎯 Calculando similitudes...`);
        const scoredChunks = chunks.map(chunk => {
            const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
            return { ...chunk, similarity };
        });
        
        // 4. TOP 5 CHUNKS
        const topChunks = scoredChunks
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 5);
        
        console.log(`📊 Top 5 chunks:`);
        topChunks.forEach((c, i) => {
            console.log(`  ${i+1}. ${c.fileName} - ${(c.similarity * 100).toFixed(1)}%`);
        });
        
        // 5. CONSTRUIR CONTEXTO
        const context = topChunks
            .map(c => `[Documento: ${c.fileName}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        // 6. PROMPT OPTIMIZADO
        const prompt = `Eres Cerebro Diego, un asistente experto que responde preguntas basándose ÚNICAMENTE en documentos.

**REGLAS ESTRICTAS:**
1. Responde SOLO con información que aparece en el contexto
2. Si la info no está, di: "No encuentro esa información en los documentos"
3. Sé directo y útil, sin rodeos
4. NO inventes ni supongas nada
5. Cita las fuentes relevantes

**CONTEXTO DE LOS DOCUMENTOS:**
${context}

**PREGUNTA:** ${query}

**TU RESPUESTA (directa y basada en los documentos):**`;

        // 7. GENERAR RESPUESTA
        console.log(`🤖 Generando respuesta con ${CHAT_MODEL}...`);
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: CHAT_MODEL });
        
        const result = await model.generateContent(prompt);
        const answer = result.response.text();
        
        console.log(`✅ Respuesta generada (${answer.length} chars)\n`);
        
        res.json({
            text: answer,
            sources: topChunks.map(c => ({
                fileName: c.fileName,
                similarity: `${(c.similarity * 100).toFixed(1)}%`
            }))
        });
        
    } catch (error) {
        console.error("❌ Error en chat:", error.message);
        
        // SOLO EN CASO DE ERROR CRÍTICO
        res.status(500).json({ 
            text: `❌ Error procesando tu consulta: ${error.message}\n\nIntenta de nuevo en unos segundos.`,
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
        console.error('❌ Files:', error);
        res.json({ files: [], totalChunks: 0 });
    }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Cerebro Diego Backend v27.0.0`);
  console.log(`🤖 Modelo: ${CHAT_MODEL}`);
  console.log(`💾 Firebase: entradas24december`);
  console.log(`✅ Puerto: ${PORT}\n`);
});

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
        console.error('❌ Firebase error:', error.message);
    }
}

const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });

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
    
    console.log(`📦 Chunks: ${chunks.length}`);
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
                await new Promise(r => setTimeout(r, 2000 * attempt));
                continue;
            }
            if (attempt === retries) return null;
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
    version: "26.0.0 - FIXED",
    models: { chat: CHAT_MODEL, embedding: EMBEDDING_MODEL },
    database: "Firestore ✅",
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
        console.error('❌ Error:', error);
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
            await new Promise(r => setTimeout(r, 200));
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

app.post('/chat', async (req, res) => {
    try {
        const { storeId, query } = req.body;
        const apiKey = getApiKey();
        
        console.log(`💬 "${query}"`);
        
        const chunksSnapshot = await db.collection('stores')
            .doc(storeId)
            .collection('chunks')
            .get();
        
        if (chunksSnapshot.empty) {
            console.log(`⚠️ Sin chunks`);
            return res.json({ 
                text: "⚠️ No hay documentos indexados.",
                sources: []
            });
        }
        
        const chunks = [];
        chunksSnapshot.forEach(doc => {
            chunks.push(doc.data());
        });
        
        console.log(`📚 ${chunks.length} chunks`);
        
        const queryEmbedding = await generateEmbedding(query, apiKey);
        
        if (!queryEmbedding) {
            const scoredChunks = chunks.map(chunk => ({
                ...chunk,
                finalScore: keywordScore(query, chunk.text)
            }));
            
            const topChunks = scoredChunks
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, 5);
            
            return res.json({
                text: "Documentos relevantes:\n\n" +
                      topChunks.map((c, i) => 
                          `${i+1}. ${c.fileName}`
                      ).join('\n'),
                sources: topChunks.map(c => ({
                    fileName: c.fileName,
                    score: c.finalScore.toFixed(3)
                }))
            });
        }
        
        const scoredChunks = chunks.map(chunk => {
            const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
            const keywordScoreVal = keywordScore(query, chunk.text);
            const finalScore = (semanticScore * 0.7) + (keywordScoreVal * 0.3);
            
            return { ...chunk, finalScore, semanticScore };
        });
        
        const topChunks = scoredChunks
            .sort((a, b) => b.finalScore - a.finalScore)
            .slice(0, 5);
        
        console.log(`🎯 Top: ${topChunks.map(c => `${(c.semanticScore * 100).toFixed(0)}%`).join(', ')}`);
        
        const context = topChunks
            .map(c => `[${c.fileName}]\n${c.text}`)
            .join('\n\n---\n\n');
        
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: CHAT_MODEL });
        
        const prompt = `Eres Cerebro Diego, un asistente experto.

CONTEXTO:
${context}

PREGUNTA: ${query}

INSTRUCCIONES:
- Responde SOLO con información del contexto
- Si no está, di "No encuentro esa información"
- Sé claro y preciso
- Cita fuentes entre paréntesis

RESPUESTA:`;

        try {
            const result = await model.generateContent(prompt);
            const answer = result.response.text();
            
            res.json({
                text: answer,
                sources: topChunks.map(c => ({
                    fileName: c.fileName,
                    score: c.finalScore.toFixed(3),
                    semanticMatch: `${(c.semanticScore * 100).toFixed(0)}%`
                }))
            });
            
        } catch (error) {
            console.error(`❌ Modelo:`, error.message);
            
            res.json({
                text: `Documentos relevantes:\n\n` +
                      topChunks.map((c, i) => 
                          `${i+1}. **${c.fileName}** (${(c.finalScore * 100).toFixed(0)}%)\n${c.text.substring(0, 200)}...`
                      ).join('\n\n'),
                sources: topChunks.map(c => ({
                    fileName: c.fileName,
                    score: c.finalScore.toFixed(3)
                }))
            });
        }
        
    } catch (error) {
        console.error("❌ Chat:", error);
        res.status(500).json({ 
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
        console.error('❌ Files:', error);
        res.json({ files: [], totalChunks: 0 });
    }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend v26.0.0 FIXED`);
  console.log(`🤖 ${CHAT_MODEL}`);
  console.log(`💾 Firestore (entradas24december)`);
  console.log(`✅ Puerto: ${PORT}`);
});
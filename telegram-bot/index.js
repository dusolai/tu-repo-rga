const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// ===== FIREBASE =====
try {
    admin.initializeApp({
        projectId: 'entradas24december'
    });
    console.log('✅ Firebase Admin inicializado');
} catch (error) {
    if (error.code !== 'app/duplicate-app') {
        console.error('❌ Firebase error:', error.message);
    }
}

const db = admin.firestore();

// ===== CONFIGURACIÓN =====
const app = express();
const HTTP_PORT = process.env.PORT || 8080;

const BACKEND_URL = process.env.BACKEND_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SHARED_CEREBRO_ID = 'cerebro_1767296914664';

// ===== MEMORIA CONVERSACIONAL =====
const chatHistories = new Map();
const MAX_HISTORY = 10;

function getChatHistory(chatId) {
    if (!chatHistories.has(chatId)) {
        chatHistories.set(chatId, []);
    }
    return chatHistories.get(chatId);
}

function addToHistory(chatId, role, content) {
    const history = getChatHistory(chatId);
    history.push({ role, content, timestamp: Date.now() });
    
    if (history.length > MAX_HISTORY) {
        history.shift();
    }
    
    saveHistoryToFirestore(chatId, history).catch(e => 
        console.error('Error guardando historial:', e)
    );
}

async function saveHistoryToFirestore(chatId, history) {
    try {
        await db.collection('chatHistories').doc(String(chatId)).set({
            history,
            lastUpdate: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error('Error guardando en Firestore:', error);
    }
}

async function loadHistoryFromFirestore(chatId) {
    try {
        const doc = await db.collection('chatHistories').doc(String(chatId)).get();
        if (doc.exists) {
            const data = doc.data();
            chatHistories.set(chatId, data.history || []);
            console.log(`📖 Historial cargado para chat ${chatId}: ${data.history.length} mensajes`);
        }
    } catch (error) {
        console.error('Error cargando historial:', error);
    }
}

function clearHistory(chatId) {
    chatHistories.delete(chatId);
    db.collection('chatHistories').doc(String(chatId)).delete().catch(e => 
        console.error('Error borrando historial:', e)
    );
}

function formatHistoryForContext(chatId) {
    const history = getChatHistory(chatId);
    if (history.length === 0) return '';
    
    return '\n\n**CONTEXTO DE CONVERSACIÓN PREVIA:**\n' + 
        history.map(msg => `${msg.role === 'user' ? '👤 Usuario' : '🤖 Asistente'}: ${msg.content}`).join('\n') +
        '\n\n**FIN DEL CONTEXTO**\n';
}

// ===== SERVIDOR HTTP =====
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot activo 🟢',
        version: '6.0.0 - VOZ + MEMORIA',
        cerebro: SHARED_CEREBRO_ID,
        project: 'entradas24december',
        features: ['entrada_voz', 'salida_voz', 'memoria_conversacional', 'persistencia']
    });
});

app.listen(HTTP_PORT, () => console.log(`🌐 HTTP: ${HTTP_PORT}`));

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !BACKEND_URL) {
    console.error('❌ Faltan variables de entorno');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

console.log('═══════════════════════════════════════');
console.log('🤖 Cerebro Diego Bot v6.0.0');
console.log('═══════════════════════════════════════');
console.log(`📡 Backend: ${BACKEND_URL}`);
console.log(`🧠 Cerebro: ${SHARED_CEREBRO_ID}`);
console.log(`💾 Firestore: entradas24december`);
console.log(`🎤 Entrada: Audio → Texto (Gemini 1.5 Flash)`);
console.log(`🔊 Salida: Texto → Audio (Gemini 2.0 Flash Exp)`);
console.log(`🧠 Memoria: Últimos ${MAX_HISTORY} mensajes por chat`);
console.log('═══════════════════════════════════════');

// ===== UTILIDADES =====

function splitMessage(text, maxLength = 4000) {
    if (text.length <= maxLength) return [text];
    
    const chunks = [];
    let currentChunk = '';
    const paragraphs = text.split('\n\n');
    
    for (const para of paragraphs) {
        if ((currentChunk + para + '\n\n').length > maxLength) {
            if (currentChunk.trim()) chunks.push(currentChunk.trim());
            currentChunk = para + '\n\n';
        } else {
            currentChunk += para + '\n\n';
        }
    }
    
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    
    return chunks;
}

async function sendTypingMessage(chatId, text) {
    const chunks = splitMessage(text);
    
    for (let i = 0; i < chunks.length; i++) {
        await bot.sendChatAction(chatId, 'typing');
        await new Promise(r => setTimeout(r, 500));
        await bot.sendMessage(chatId, chunks[i]);
        
        if (i < chunks.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// ===== FUNCIONES DE VOZ =====

/**
 * Transcribe audio a texto usando Gemini 1.5 Flash
 * Soporta: OGG, MP3, WAV
 */
async function transcribeAudio(audioPath) {
    try {
        console.log('🎤 Iniciando transcripción...');
        const audioBuffer = fs.readFileSync(audioPath);
        const base64Audio = audioBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const result = await model.generateContent([
            { 
                inlineData: { 
                    mimeType: 'audio/ogg', 
                    data: base64Audio 
                } 
            },
            "Transcribe este audio palabra por palabra. Solo devuelve el texto transcrito, sin comentarios adicionales."
        ]);
        
        const transcription = result.response.text().trim();
        console.log(`✅ Transcripción completa: "${transcription}"`);
        
        return transcription;
    } catch (error) {
        console.error('❌ Error en transcripción:', error.message);
        throw new Error('No pude transcribir el audio. Por favor, habla más claro o intenta de nuevo.');
    }
}

/**
 * Convierte texto a audio usando Gemini 2.0 Flash Exp
 * Retorna: ruta del archivo WAV temporal
 */
async function textToSpeech(text) {
    try {
        console.log('🔊 Generando audio de respuesta...');
        
        // Limitar longitud para TTS (máximo 500 caracteres)
        const maxLength = 500;
        const truncatedText = text.length > maxLength 
            ? text.substring(0, maxLength) + '...' 
            : text;
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        
        const result = await model.generateContent({
            contents: [{ 
                role: "user", 
                parts: [{ 
                    text: `Di esto de forma natural y clara: "${truncatedText}"` 
                }] 
            }],
            generationConfig: { 
                responseMimeType: "audio/wav", 
                responseModalities: ["AUDIO"] 
            }
        });
        
        const tempPath = path.join(__dirname, `tts_${Date.now()}.wav`);
        const audioData = Buffer.from(result.response.text(), 'base64');
        fs.writeFileSync(tempPath, audioData);
        
        console.log(`✅ Audio generado: ${tempPath}`);
        return tempPath;
        
    } catch (error) {
        console.error('⚠️ Error en TTS:', error.message);
        return null; // No romper el flujo si TTS falla
    }
}

/**
 * Consulta al backend RAG con contexto conversacional
 */
async function queryRAG(chatId, query) {
    try {
        // Añadir contexto conversacional
        const contextualQuery = formatHistoryForContext(chatId) + query;
        
        console.log(`💬 Chat ${chatId}: "${query}"`);
        console.log(`📜 Historial: ${getChatHistory(chatId).length} mensajes`);
        
        const res = await axios.post(`${BACKEND_URL}/chat`, { 
            storeId: SHARED_CEREBRO_ID, 
            query: contextualQuery
        }, {
            timeout: 60000
        });
        
        const answer = res.data?.text || "Sin respuesta.";
        
        // Guardar en historial
        addToHistory(chatId, 'user', query);
        addToHistory(chatId, 'assistant', answer);
        
        console.log(`✅ Respuesta recibida (${answer.length} caracteres)`);
        
        return answer;
        
    } catch (error) {
        console.error(`❌ Error en queryRAG para chat ${chatId}:`, error.message);
        
        if (error.response?.status === 500) {
            console.error('📊 Error 500 del backend:', error.response?.data);
            throw new Error('⚠️ Error en el servidor. Reintentando...');
        } else if (error.response?.status === 429) {
            throw new Error('⏳ Límite de API alcanzado. Espera 1 minuto.');
        } else if (error.code === 'ECONNABORTED') {
            throw new Error('⏱️ Consulta muy larga. Sé más específico.');
        } else {
            throw new Error(`Error: ${error.message}`);
        }
    }
}

// ===== COMANDOS =====

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    await loadHistoryFromFirestore(chatId);
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`, {
            timeout: 10000
        });
        
        const files = res.data?.files || [];
        const chunks = res.data?.totalChunks || 0;
        const historyCount = getChatHistory(chatId).length;
        
        await bot.sendMessage(chatId, 
            `¡Hola! 👋 Soy el *Cerebro Diego*\n\n` +
            `🧠 Sistema conectado\n` +
            `📚 ${files.length} documentos\n` +
            `📦 ${chunks} fragmentos indexados\n` +
            `🧠 Memoria: ${historyCount} mensajes previos\n\n` +
            `💡 *Cómo usarme:*\n` +
            `• Escribe tu pregunta\n` +
            `• 🎤 Envía audio de voz (mantén presionado el micrófono)\n` +
            `• 🔊 Recibirás respuesta en texto + audio\n` +
            `• Recuerdo tus últimos ${MAX_HISTORY} mensajes\n\n` +
            `*Comandos:*\n` +
            `/info - Ver documentos\n` +
            `/memoria - Ver historial\n` +
            `/limpiar - Borrar memoria\n` +
            `/ayuda - Más información`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('Error /start:', err);
        await bot.sendMessage(chatId, 
            `¡Hola! 👋\n\nSoy el Cerebro Diego con capacidad de voz. Pregúntame lo que quieras!`
        );
    }
});

bot.onText(/\/info/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`, {
            timeout: 10000
        });
        
        const files = res.data?.files || [];
        const totalChunks = res.data?.totalChunks || 0;
        const historyCount = getChatHistory(chatId).length;
        
        if (files.length === 0) {
            await bot.sendMessage(chatId, '⚠️ No hay documentos en el cerebro.');
        } else {
            const displayFiles = files.slice(0, 20);
            const fileList = displayFiles.map((f, i) => `${i + 1}. ${f}`).join('\n');
            const moreFiles = files.length > 20 ? `\n\n_... y ${files.length - 20} más_` : '';
            
            await bot.sendMessage(chatId, 
                `📚 *Documentos* (${files.length} total):\n\n${fileList}${moreFiles}\n\n` +
                `📦 Fragmentos: ${totalChunks}\n` +
                `🧠 Mensajes en memoria: ${historyCount}/${MAX_HISTORY}\n` +
                `🆔 Cerebro: \`${SHARED_CEREBRO_ID.substring(0, 15)}...\``,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (err) {
        console.error('Error /info:', err);
        await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
});

bot.onText(/\/limpiar/, async (msg) => {
    const chatId = msg.chat.id;
    
    clearHistory(chatId);
    
    await bot.sendMessage(chatId, 
        `🧹 *Memoria limpiada*\n\n` +
        `He olvidado todos los mensajes anteriores de esta conversación.`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/memoria/, async (msg) => {
    const chatId = msg.chat.id;
    const history = getChatHistory(chatId);
    
    if (history.length === 0) {
        await bot.sendMessage(chatId, '📭 No hay mensajes en memoria.');
        return;
    }
    
    const historyText = history.map((msg, i) => 
        `${i + 1}. ${msg.role === 'user' ? '👤' : '🤖'} ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`
    ).join('\n\n');
    
    await bot.sendMessage(chatId, 
        `🧠 *Memoria actual* (${history.length}/${MAX_HISTORY}):\n\n${historyText}`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/ayuda/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `📖 *GUÍA DE USO - BOT CON VOZ*\n\n` +
        `*Comandos:*\n` +
        `/start - Ver estado del sistema\n` +
        `/info - Ver documentos y estadísticas\n` +
        `/memoria - Ver historial de conversación\n` +
        `/limpiar - Borrar toda la memoria\n` +
        `/ayuda - Esta guía\n\n` +
        `*Entrada de voz:*\n` +
        `🎤 Mantén presionado el botón de micrófono\n` +
        `📝 Habla tu pregunta claramente\n` +
        `🔊 Suelta para enviar\n\n` +
        `*Salida de voz:*\n` +
        `💬 Recibirás respuesta en texto\n` +
        `🔊 Y también en audio de voz\n\n` +
        `*Características:*\n` +
        `✅ Memoria conversacional (últimos ${MAX_HISTORY} mensajes)\n` +
        `✅ Entrada por texto o voz\n` +
        `✅ Salida en texto + audio\n` +
        `✅ Transcripción en tiempo real\n\n` +
        `*Consejos:*\n` +
        `✅ Habla claro y despacio\n` +
        `✅ Audios de máximo 1-2 minutos\n` +
        `✅ Si error, espera 30 segundos\n` +
        `✅ Puedes hacer seguimiento de temas anteriores`,
        { parse_mode: 'Markdown' }
    );
});

// ===== MANEJO DE VOZ =====

bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    let audioPath = null;
    let ttsPath = null;
    
    try {
        // PASO 1: Descargar audio
        await bot.sendChatAction(chatId, 'typing');
        const statusMsg = await bot.sendMessage(chatId, '🎤 Descargando audio...');
        
        const file = await bot.getFile(msg.voice.file_id);
        audioPath = path.join(__dirname, `voice_${Date.now()}.oga`);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(audioPath, response.data);
        
        // PASO 2: Transcribir
        await bot.editMessageText('🎤 Transcribiendo audio...', {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        const transcription = await transcribeAudio(audioPath);
        
        await bot.editMessageText(`📝 Escuché: "${transcription}"`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        // PASO 3: Consultar RAG
        await bot.sendChatAction(chatId, 'typing');
        const searchMsg = await bot.sendMessage(chatId, '🧠 Buscando en documentos...');
        
        const answer = await queryRAG(chatId, transcription);
        
        await bot.deleteMessage(chatId, searchMsg.message_id).catch(() => {});
        
        // PASO 4: Enviar respuesta en texto
        await sendTypingMessage(chatId, answer);
        
        // PASO 5: Generar y enviar audio
        try {
            await bot.sendChatAction(chatId, 'record_audio');
            ttsPath = await textToSpeech(answer);
            
            if (ttsPath && fs.existsSync(ttsPath)) {
                await bot.sendVoice(chatId, ttsPath, {
                    caption: '🔊 Respuesta en audio'
                });
                console.log('✅ Audio de respuesta enviado');
            }
        } catch (ttsError) {
            console.log('⚠️ TTS no disponible, solo texto enviado');
        }
        
    } catch (err) {
        console.error('❌ Error procesando voz:', err);
        await bot.sendMessage(chatId, `❌ ${err.message}`);
    } finally {
        // Limpiar archivos temporales
        if (audioPath && fs.existsSync(audioPath)) {
            try { fs.unlinkSync(audioPath); } catch (e) {}
        }
        if (ttsPath && fs.existsSync(ttsPath)) {
            try { fs.unlinkSync(ttsPath); } catch (e) {}
        }
    }
});

// ===== MANEJO DE TEXTO =====

bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/') || msg.voice || !msg.text) return;
    
    const chatId = msg.chat.id;
    let searchMsg = null;
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        searchMsg = await bot.sendMessage(chatId, '🔍 Buscando...');
        
        const answer = await queryRAG(chatId, msg.text);
        
        try {
            await bot.deleteMessage(chatId, searchMsg.message_id);
        } catch (e) {}
        
        await sendTypingMessage(chatId, answer);
        
    } catch (err) {
        console.error('❌ Error texto:', err);
        
        if (searchMsg) {
            try { await bot.deleteMessage(chatId, searchMsg.message_id); } catch (e) {}
        }
        
        await bot.sendMessage(chatId, `❌ ${err.message}`);
    }
});

// ===== MANEJO DE ERRORES =====

bot.on('polling_error', (error) => {
    console.error('⚠️ Polling error:', error.code);
});

process.on('unhandledRejection', (error) => {
    console.error('⚠️ Unhandled rejection:', error);
});

process.on('SIGINT', () => {
    console.log('\n👋 Cerrando bot...');
    bot.stopPolling();
    process.exit(0);
});

console.log('✅ Bot listo para recibir mensajes de voz y texto\n');

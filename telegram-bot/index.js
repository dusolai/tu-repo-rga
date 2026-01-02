const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ===== CONFIGURACIÓN =====
const app = express();
const HTTP_PORT = process.env.PORT || 8080;

const BACKEND_URL = process.env.BACKEND_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ✅ CEREBRO PERSISTENTE EN FIRESTORE
const SHARED_CEREBRO_ID = 'cerebro_1767296914664';

// ===== SERVIDOR HTTP =====
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot activo 🟢',
        version: '5.0.0 - FIXED',
        cerebro: SHARED_CEREBRO_ID,
        project: 'entradas24december'
    });
});

app.listen(HTTP_PORT, () => console.log(`🌐 HTTP: ${HTTP_PORT}`));

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !BACKEND_URL) {
    console.error('❌ Faltan variables');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

console.log('═══════════════════════════════════════');
console.log('🤖 Cerebro Diego Bot v5.0.0 FIXED');
console.log('═══════════════════════════════════════');
console.log(`📡 Backend: ${BACKEND_URL}`);
console.log(`🧠 Cerebro: ${SHARED_CEREBRO_ID}`);
console.log(`💾 Firestore: entradas24december`);
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

// ===== FUNCIONES DE IA =====

async function transcribeAudio(audioPath) {
    try {
        const audioBuffer = fs.readFileSync(audioPath);
        const base64Audio = audioBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const result = await model.generateContent([
            { inlineData: { mimeType: 'audio/ogg', data: base64Audio } },
            "Transcribe este audio palabra por palabra."
        ]);
        
        return result.response.text().trim();
    } catch (error) {
        console.error('❌ Transcripción:', error.message);
        throw new Error('No pude transcribir. Intenta de nuevo.');
    }
}

async function textToSpeech(text) {
    try {
        const maxLength = 500;
        const truncatedText = text.length > maxLength 
            ? text.substring(0, maxLength) + '...' 
            : text;
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: `Di esto de forma natural: "${truncatedText}"` }] }],
            generationConfig: { 
                responseMimeType: "audio/wav", 
                responseModalities: ["AUDIO"] 
            }
        });
        
        const tempPath = path.join(__dirname, `tts_${Date.now()}.wav`);
        fs.writeFileSync(tempPath, Buffer.from(result.response.text(), 'base64'));
        return tempPath;
    } catch (error) {
        console.error('⚠️ TTS:', error.message);
        return null;
    }
}

async function queryRAG(query) {
    try {
        const res = await axios.post(`${BACKEND_URL}/chat`, { 
            storeId: SHARED_CEREBRO_ID, 
            query 
        }, {
            timeout: 60000
        });
        
        return res.data?.text || "Sin respuesta.";
    } catch (error) {
        if (error.response?.status === 429) {
            throw new Error('⏳ Límite alcanzado. Espera 1 minuto.');
        } else if (error.code === 'ECONNABORTED') {
            throw new Error('⏱️ Consulta muy larga. Sé más específico.');
        } else {
            throw new Error(`Error: ${error.message}`);
        }
    }
}

// ===== COMANDOS =====

bot.onText(/\/start/, async (msg) => {
    try {
        await bot.sendChatAction(msg.chat.id, 'typing');
        
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`, {
            timeout: 10000
        });
        
        const files = res.data?.files || [];
        const chunks = res.data?.totalChunks || 0;
        
        await bot.sendMessage(msg.chat.id, 
            `¡Hola! 👋 Soy el *Cerebro Diego*\n\n` +
            `🧠 Sistema conectado\n` +
            `📚 ${files.length} documentos\n` +
            `📦 ${chunks} fragmentos indexados\n\n` +
            `💡 *Cómo usarme:*\n` +
            `• Escribe tu pregunta\n` +
            `• Envía audio 🎤\n` +
            `• /info para ver documentos\n` +
            `• /ayuda para más info`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('Error /start:', err);
        await bot.sendMessage(msg.chat.id, 
            `¡Hola! 👋\n\nSoy el Cerebro Diego. Pregúntame lo que quieras!`
        );
    }
});

bot.onText(/\/info/, async (msg) => {
    try {
        await bot.sendChatAction(msg.chat.id, 'typing');
        
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`, {
            timeout: 10000
        });
        
        const files = res.data?.files || [];
        const totalChunks = res.data?.totalChunks || 0;
        
        if (files.length === 0) {
            await bot.sendMessage(msg.chat.id, '⚠️ No hay documentos.');
        } else {
            const displayFiles = files.slice(0, 20);
            const fileList = displayFiles.map((f, i) => `${i + 1}. ${f}`).join('\n');
            const moreFiles = files.length > 20 ? `\n\n_... y ${files.length - 20} más_` : '';
            
            await bot.sendMessage(msg.chat.id, 
                `📚 *Documentos* (${files.length} total):\n\n${fileList}${moreFiles}\n\n` +
                `📦 Fragmentos: ${totalChunks}\n` +
                `🆔 Cerebro: \`${SHARED_CEREBRO_ID.substring(0, 15)}...\``,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (err) {
        console.error('Error /info:', err);
        await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
});

bot.onText(/\/ayuda/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `📖 *GUÍA DE USO*\n\n` +
        `*Comandos:*\n` +
        `/start - Ver estado\n` +
        `/info - Ver documentos\n` +
        `/ayuda - Esta guía\n\n` +
        `*Uso:*\n` +
        `• Escribe preguntas\n` +
        `• Envía audios 🎤\n` +
        `• Respondo con texto y audio\n\n` +
        `*Consejos:*\n` +
        `✅ Preguntas específicas\n` +
        `✅ Si error 429, espera 30s\n` +
        `✅ Audios claros <1min`,
        { parse_mode: 'Markdown' }
    );
});

// ===== VOZ =====

bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    let audioPath = null;
    let ttsPath = null;
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        const statusMsg = await bot.sendMessage(chatId, '🎤 Transcribiendo...');
        
        const file = await bot.getFile(msg.voice.file_id);
        audioPath = path.join(__dirname, `voice_${Date.now()}.oga`);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(audioPath, response.data);
        
        const transcription = await transcribeAudio(audioPath);
        await bot.editMessageText(`📝 Escuché: "${transcription}"`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        await bot.sendChatAction(chatId, 'typing');
        await bot.sendMessage(chatId, '🧠 Buscando...');
        
        const answer = await queryRAG(transcription);
        
        await sendTypingMessage(chatId, answer);
        
        try {
            await bot.sendChatAction(chatId, 'record_audio');
            ttsPath = await textToSpeech(answer);
            
            if (ttsPath && fs.existsSync(ttsPath)) {
                await bot.sendVoice(chatId, ttsPath);
            }
        } catch (ttsError) {
            console.log('⚠️ TTS no disponible');
        }
        
    } catch (err) {
        console.error('❌ Error voz:', err);
        await bot.sendMessage(chatId, `❌ ${err.message}`);
    } finally {
        if (audioPath && fs.existsSync(audioPath)) {
            try { fs.unlinkSync(audioPath); } catch (e) {}
        }
        if (ttsPath && fs.existsSync(ttsPath)) {
            try { fs.unlinkSync(ttsPath); } catch (e) {}
        }
    }
});

// ===== TEXTO =====

bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/') || msg.voice || !msg.text) return;
    
    const chatId = msg.chat.id;
    let searchMsg = null;
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        searchMsg = await bot.sendMessage(chatId, '🔍 Buscando...');
        
        const answer = await queryRAG(msg.text);
        
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

// ===== ERRORES =====

bot.on('polling_error', (error) => {
    console.error('⚠️ Polling:', error.code);
});

process.on('unhandledRejection', (error) => {
    console.error('⚠️ Unhandled:', error);
});

process.on('SIGINT', () => {
    console.log('\n👋 Cerrando...');
    bot.stopPolling();
    process.exit(0);
});

console.log('✅ Bot listo\n');
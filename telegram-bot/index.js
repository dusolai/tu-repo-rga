const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ===== SERVIDOR HTTP =====
const app = express();
const HTTP_PORT = process.env.PORT || 8080;

const BACKEND_URL = process.env.BACKEND_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ✅ CEREBRO CORRECTO CON CHUNKS (en entradas24december)
const SHARED_CEREBRO_ID = 'cerebro_1767296914664';

app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot activo 🟢',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        cerebro: SHARED_CEREBRO_ID,
        project: 'entradas24december'
    });
});

app.listen(HTTP_PORT, () => console.log(`🌐 HTTP: ${HTTP_PORT}`));

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
    console.error('❌ Faltan variables');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

console.log('🤖 Bot iniciado');
console.log(`📡 Backend: ${BACKEND_URL}`);
console.log(`🧠 Cerebro: ${SHARED_CEREBRO_ID}`);
console.log(`💾 Proyecto: entradas24december`);

// ===== FUNCIONES =====
async function transcribeAudio(audioPath) {
    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString('base64');
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent([
        { inlineData: { mimeType: 'audio/ogg', data: base64Audio } },
        "Transcribe este audio palabra por palabra."
    ]);
    return result.response.text().trim();
}

async function textToSpeech(text) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: `Di: "${text}"` }] }],
            generationConfig: { responseMimeType: "audio/wav", responseModalities: ["AUDIO"] }
        });
        const tempPath = path.join(__dirname, `tts_${Date.now()}.wav`);
        fs.writeFileSync(tempPath, Buffer.from(result.response.text(), 'base64'));
        return tempPath;
    } catch {
        return null;
    }
}

async function queryRAG(query) {
    const res = await axios.post(`${BACKEND_URL}/chat`, { 
        storeId: SHARED_CEREBRO_ID, 
        query 
    });
    return res.data?.text || "Sin respuesta";
}

// ===== COMANDOS =====
bot.onText(/\/start/, async (msg) => {
    try {
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`);
        const files = res.data?.files || [];
        const chunks = res.data?.totalChunks || 0;
        
        bot.sendMessage(msg.chat.id, 
            `¡Hola! 👋 Soy el Cerebro Diego\n\n` +
            `🧠 Conectado a: ${SHARED_CEREBRO_ID.substring(0, 20)}...\n` +
            `📚 ${files.length} documentos cargados\n` +
            `📦 ${chunks} chunks de información\n\n` +
            `Puedes preguntarme lo que quieras con texto o voz!`
        );
    } catch (err) {
        bot.sendMessage(msg.chat.id, 
            `¡Hola! 👋\n\n` +
            `Soy el Cerebro Diego. Pregúntame lo que quieras!`
        );
    }
});

bot.onText(/\/info/, async (msg) => {
    try {
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`);
        const files = res.data?.files || [];
        const totalChunks = res.data?.totalChunks || 0;
        
        if (files.length === 0) {
            bot.sendMessage(msg.chat.id, '⚠️ No hay documentos cargados');
        } else {
            const fileList = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
            bot.sendMessage(msg.chat.id, 
                `📚 Documentos:\n\n${fileList}\n\n` +
                `📦 Total chunks: ${totalChunks}\n` +
                `🆔 Cerebro: ${SHARED_CEREBRO_ID}`
            );
        }
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
});

// ===== VOZ =====
bot.on('voice', async (msg) => {
    let audioPath = null;
    try {
        const file = await bot.getFile(msg.voice.file_id);
        audioPath = path.join(__dirname, `voice_${Date.now()}.oga`);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(audioPath, response.data);
        
        const transcription = await transcribeAudio(audioPath);
        bot.sendMessage(msg.chat.id, `📝 "${transcription}"`);
        
        const answer = await queryRAG(transcription);
        const ttsPath = await textToSpeech(answer);
        
        if (ttsPath && fs.existsSync(ttsPath)) {
            await bot.sendVoice(msg.chat.id, ttsPath);
            fs.unlinkSync(ttsPath);
        }
        
        bot.sendMessage(msg.chat.id, answer);
        if (audioPath) fs.unlinkSync(audioPath);
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
});

// ===== TEXTO =====
bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/') || msg.voice || !msg.text) return;
    
    try {
        const answer = await queryRAG(msg.text);
        bot.sendMessage(msg.chat.id, answer);
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
});

console.log('✅ Bot listo');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ===== SERVIDOR HTTP (CRÍTICO PARA CLOUD RUN) =====
const app = express();
const HTTP_PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot activo 🟢',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(HTTP_PORT, () => {
    console.log(`🌐 Servidor HTTP escuchando en puerto ${HTTP_PORT}`);
});

// ===== CONFIGURACIÓN BOT =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
    console.error('❌ Faltan variables de entorno');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const userStores = new Map();

console.log('🤖 Bot de Telegram iniciado');
console.log(`📡 Backend: ${BACKEND_URL}`);

// ===== TRANSCRIPCIÓN DE AUDIO =====
async function transcribeAudio(audioPath) {
    try {
        const audioBuffer = fs.readFileSync(audioPath);
        const base64Audio = audioBuffer.toString('base64');
        const mimeType = 'audio/ogg';
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent([
            { inlineData: { mimeType, data: base64Audio } },
            "Transcribe este audio palabra por palabra."
        ]);
        
        return result.response.text().trim();
    } catch (error) {
        console.error('❌ Error transcribiendo:', error.message);
        throw new Error('No pude transcribir el audio.');
    }
}

// ===== TEXTO A VOZ =====
async function textToSpeech(text) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: `Di: "${text}"` }] }],
            generationConfig: { 
                responseMimeType: "audio/wav", 
                responseModalities: ["AUDIO"] 
            }
        });
        
        const tempPath = path.join(__dirname, `tts_${Date.now()}.wav`);
        fs.writeFileSync(tempPath, Buffer.from(result.response.text(), 'base64'));
        return tempPath;
    } catch {
        return null;
    }
}

// ===== CONSULTAR RAG =====
async function queryRAG(storeId, query) {
    const res = await axios.post(`${BACKEND_URL}/chat`, { storeId, query });
    return res.data?.text || "Sin respuesta";
}

// ===== COMANDOS =====
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `¡Hola! 👋\n\n` +
        `🎤 Envíame un audio y te responderé con voz\n` +
        `💬 O escribe tu pregunta\n\n` +
        `Usa /crear para empezar`
    );
});

bot.onText(/\/crear(.*)/, async (msg, match) => {
    const name = match[1].trim() || 'MiCerebro';
    try {
        const res = await axios.post(`${BACKEND_URL}/create-store`, { name });
        userStores.set(msg.chat.id, res.data.name);
        bot.sendMessage(msg.chat.id, `✅ Cerebro creado: ${name}`);
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
});

// ===== VOZ =====
bot.on('voice', async (msg) => {
    const storeId = userStores.get(msg.chat.id);
    if (!storeId) return bot.sendMessage(msg.chat.id, 'Usa /crear primero');
    
    let audioPath = null;
    try {
        const file = await bot.getFile(msg.voice.file_id);
        audioPath = path.join(__dirname, `voice_${Date.now()}.oga`);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(audioPath, response.data);
        
        const transcription = await transcribeAudio(audioPath);
        bot.sendMessage(msg.chat.id, `📝 "${transcription}"`);
        
        const answer = await queryRAG(storeId, transcription);
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
    const storeId = userStores.get(msg.chat.id);
    if (!storeId) return bot.sendMessage(msg.chat.id, 'Usa /crear');
    
    try {
        const answer = await queryRAG(storeId, msg.text);
        bot.sendMessage(msg.chat.id, answer);
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
});

console.log('✅ Bot listo');

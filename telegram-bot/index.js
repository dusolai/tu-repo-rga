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

let CURRENT_CEREBRO_ID = null;

app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot activo 🟢',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        cerebro: CURRENT_CEREBRO_ID
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
    if (!CURRENT_CEREBRO_ID) throw new Error('No hay cerebro activo. Usa /select');
    const res = await axios.post(`${BACKEND_URL}/chat`, { 
        storeId: CURRENT_CEREBRO_ID, 
        query 
    });
    return res.data?.text || "Sin respuesta";
}

// ===== COMANDO: Seleccionar cerebro =====
bot.onText(/\/select/, async (msg) => {
    try {
        bot.sendMessage(msg.chat.id, '🔍 Buscando cerebros disponibles...');
        
        // Lista de cerebros - ACTUALIZA ESTO con tus IDs reales de Firebase
        const cerebros = [
            'cerebro_1767052522221',
            'cerebro_1767096461740',
            'cerebro_1767096540779',
            'cerebro_1767096572734',
            'cerebro_1767096608389',
            'cerebro_1767096712642',
            'cerebro_1767096838386',
            'cerebro_1767096975396'
        ];
        
        let message = '🧠 Cerebros disponibles:\n\n';
        
        for (let i = 0; i < cerebros.length; i++) {
            const cerebroId = cerebros[i];
            try {
                const res = await axios.get(`${BACKEND_URL}/files?storeId=${cerebroId}`);
                const fileCount = res.data?.files?.length || 0;
                const chunkCount = res.data?.totalChunks || 0;
                
                if (chunkCount > 0) {
                    message += `/${i + 1} → ${cerebroId.substring(0, 20)}...\n`;
                    message += `   📚 ${fileCount} archivos, ${chunkCount} chunks\n\n`;
                }
            } catch (e) {
                // Cerebro no válido, skip
            }
        }
        
        bot.sendMessage(msg.chat.id, message + '\nEscribe /1, /2, /3... para elegir');
        
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
    }
});

// Comandos numéricos para seleccionar
for (let i = 1; i <= 8; i++) {
    bot.onText(new RegExp(`^\\/${i}$`), async (msg) => {
        const cerebros = [
            'cerebro_1767052522221',
            'cerebro_1767096461740',
            'cerebro_1767096540779',
            'cerebro_1767096572734',
            'cerebro_1767096608389',
            'cerebro_1767096712642',
            'cerebro_1767096838386',
            'cerebro_1767096975396'
        ];
        
        CURRENT_CEREBRO_ID = cerebros[i - 1];
        
        try {
            const res = await axios.get(`${BACKEND_URL}/files?storeId=${CURRENT_CEREBRO_ID}`);
            const files = res.data?.files || [];
            const chunks = res.data?.totalChunks || 0;
            
            bot.sendMessage(msg.chat.id, 
                `✅ Cerebro activado:\n\n` +
                `🆔 ${CURRENT_CEREBRO_ID}\n` +
                `📚 ${files.length} archivos\n` +
                `📦 ${chunks} chunks\n\n` +
                `Ya puedes hacer preguntas!`
            );
        } catch (err) {
            bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });
}

// ===== COMANDOS =====
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `¡Hola! 👋\n\n` +
        `Primero usa /select para elegir un cerebro\n` +
        `Luego podrás hacer preguntas con texto o voz`
    );
});

bot.onText(/\/info/, async (msg) => {
    if (!CURRENT_CEREBRO_ID) {
        return bot.sendMessage(msg.chat.id, '⚠️ Usa /select primero');
    }
    
    try {
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${CURRENT_CEREBRO_ID}`);
        const files = res.data?.files || [];
        const totalChunks = res.data?.totalChunks || 0;
        
        if (files.length === 0) {
            bot.sendMessage(msg.chat.id, '⚠️ No hay documentos');
        } else {
            const fileList = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
            bot.sendMessage(msg.chat.id, 
                `📚 Documentos:\n\n${fileList}\n\n` +
                `📦 Total chunks: ${totalChunks}`
            );
        }
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
});

// ===== VOZ =====
bot.on('voice', async (msg) => {
    if (!CURRENT_CEREBRO_ID) {
        return bot.sendMessage(msg.chat.id, '⚠️ Usa /select primero');
    }
    
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
    
    if (!CURRENT_CEREBRO_ID) {
        return bot.sendMessage(msg.chat.id, '⚠️ Usa /select primero');
    }
    
    try {
        const answer = await queryRAG(msg.text);
        bot.sendMessage(msg.chat.id, answer);
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
});

console.log('✅ Bot listo');

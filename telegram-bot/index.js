const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const googleTTS = require('google-tts-api'); // <--- NUEVO: Cuerdas vocales

const app = express();
const HTTP_PORT = process.env.PORT || 8080;

// Variables
const BACKEND_URL = process.env.BACKEND_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SHARED_CEREBRO_ID = 'cerebro_1767296914664'; 

app.get('/', (req, res) => res.json({ status: 'Bot con Voz Activo 🟢' }));
app.listen(HTTP_PORT, () => console.log(`🌐 Bot listo en puerto ${HTTP_PORT}`));

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// --- UTILIDADES ---

// Dividir mensajes largos
function splitMessage(text, maxLength = 4000) {
    if (text.length <= maxLength) return [text];
    return text.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [text];
}

// Enviar texto progresivo
async function sendTypingMessage(chatId, text) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
        await bot.sendChatAction(chatId, 'typing');
        await new Promise(r => setTimeout(r, 500));
        await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    }
}

// GENERAR AUDIO (La magia nueva)
async function sendAudioExplanation(chatId, fullText) {
    try {
        await bot.sendChatAction(chatId, 'record_voice');
        
        // 1. Crear resumen para locución (para que no lea 5 minutos de texto)
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const summaryPrompt = `
        Actúa como un locutor de radio amable. 
        Resume el siguiente texto técnico en un párrafo breve, conversacional y explicativo (máximo 180 caracteres) para enviarlo como nota de voz.
        No uses asteriscos ni markdown, solo texto plano listo para leer.
        
        TEXTO ORIGINAL:
        ${fullText.substring(0, 5000)}
        `;
        
        const result = await model.generateContent(summaryPrompt);
        const script = result.response.text().replace(/[*_#]/g, ''); // Limpiar markdown
        
        console.log(`🎙️ Generando audio para: "${script}"`);

        // 2. Convertir a Audio (Google TTS - Español)
        // Usamos la API gratuita de Google Translate (limitada a 200 chars, por eso el resumen)
        const url = googleTTS.getAudioUrl(script, {
            lang: 'es',
            slow: false,
            host: 'https://translate.google.com',
        });

        // 3. Enviar Nota de Voz
        await bot.sendVoice(chatId, url, { caption: '🎧 Resumen explicativo' });

    } catch (e) {
        console.error("Fallo generando audio:", e.message);
        // Si falla el audio, no pasa nada, el usuario ya tiene el texto.
    }
}

// --- LOGICA PRINCIPAL ---

async function handleQuestion(chatId, query) {
    try {
        // 1. Avisar al usuario
        await bot.sendChatAction(chatId, 'typing');
        
        // 2. Consultar Cerebro (Backend)
        const res = await axios.post(`${BACKEND_URL}/chat`, { 
            storeId: SHARED_CEREBRO_ID, 
            query 
        }, { timeout: 120000 });
        
        const answer = res.data?.text || "Sin respuesta.";

        // 3. ENVIAR TEXTO (Detallado)
        await sendTypingMessage(chatId, answer);

        // 4. ENVIAR AUDIO (Explicativo)
        await sendAudioExplanation(chatId, answer);

    } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, "❌ Tuve un problema pensando. Intenta de nuevo.");
    }
}

// Escuchar Voz (Entrada)
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    try {
        await bot.sendChatAction(chatId, 'typing');
        const fileLink = await bot.getFileLink(msg.voice.file_id);
        const audioPath = path.join(os.tmpdir(), `voice_${Date.now()}.oga`);
        
        // Descargar
        const response = await axios({ method: 'get', url: fileLink, responseType: 'stream' });
        const writer = fs.createWriteStream(audioPath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Transcribir (Gemini)
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const audioData = fs.readFileSync(audioPath).toString('base64');
        const result = await model.generateContent([
            { inlineData: { mimeType: 'audio/ogg', data: audioData } },
            "Transcribe este audio exactamente."
        ]);
        const text = result.response.text();
        
        await bot.sendMessage(chatId, `🗣️ *Tú:* ${text}`, { parse_mode: 'Markdown' });
        
        // Procesar pregunta
        await handleQuestion(chatId, text);

        fs.unlinkSync(audioPath); // Limpieza

    } catch (e) {
        await bot.sendMessage(chatId, "❌ Error escuchando audio.");
    }
});

// Escuchar Texto (Entrada)
bot.on('message', async (msg) => {
    if (msg.voice || msg.text?.startsWith('/')) return;
    if (msg.text) await handleQuestion(msg.chat.id, msg.text);
});

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "👋 ¡Hola! Soy Cerebro Diego.\nEnvíame audio o texto y te responderé con ambos."));
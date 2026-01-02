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
        project: 'entradas24december',
        version: '2.0.0'
    });
});

app.listen(HTTP_PORT, () => console.log(`🌐 HTTP: ${HTTP_PORT}`));

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY) {
    console.error('❌ Faltan variables');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

console.log('🤖 Bot iniciado v2.0.0');
console.log(`📡 Backend: ${BACKEND_URL}`);
console.log(`🧠 Cerebro: ${SHARED_CEREBRO_ID}`);
console.log(`💾 Proyecto: entradas24december`);

// ===== UTILIDADES =====

// Dividir mensajes largos en chunks
function splitMessage(text, maxLength = 4000) {
    if (text.length <= maxLength) return [text];
    
    const chunks = [];
    let currentChunk = '';
    
    // Dividir por párrafos
    const paragraphs = text.split('\n\n');
    
    for (const para of paragraphs) {
        if ((currentChunk + para + '\n\n').length > maxLength) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = para + '\n\n';
        } else {
            currentChunk += para + '\n\n';
        }
    }
    
    if (currentChunk) chunks.push(currentChunk.trim());
    
    return chunks;
}

// Enviar mensaje con indicador "escribiendo"
async function sendTypingMessage(chatId, text) {
    const chunks = splitMessage(text);
    
    for (let i = 0; i < chunks.length; i++) {
        // Mostrar "escribiendo..."
        await bot.sendChatAction(chatId, 'typing');
        
        // Esperar un poco para que se vea el indicador
        await new Promise(r => setTimeout(r, 500));
        
        // Enviar chunk
        await bot.sendMessage(chatId, chunks[i]);
        
        // Pausa entre mensajes si hay más de uno
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
        
        // Usar modelo más económico para transcripción
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const result = await model.generateContent([
            { inlineData: { mimeType: 'audio/ogg', data: base64Audio } },
            "Transcribe este audio palabra por palabra."
        ]);
        
        return result.response.text().trim();
    } catch (error) {
        console.error('Error en transcripción:', error.message);
        throw new Error('No pude transcribir el audio. Intenta de nuevo.');
    }
}

async function textToSpeech(text) {
    try {
        // Limitar longitud para TTS
        const maxLength = 500;
        const truncatedText = text.length > maxLength 
            ? text.substring(0, maxLength) + '...' 
            : text;
        
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: `Di: "${truncatedText}"` }] }],
            generationConfig: { 
                responseMimeType: "audio/wav", 
                responseModalities: ["AUDIO"] 
            }
        });
        
        const tempPath = path.join(__dirname, `tts_${Date.now()}.wav`);
        fs.writeFileSync(tempPath, Buffer.from(result.response.text(), 'base64'));
        return tempPath;
    } catch (error) {
        console.error('Error en TTS:', error.message);
        return null; // Si falla, solo enviar texto
    }
}

async function queryRAG(query) {
    try {
        const res = await axios.post(`${BACKEND_URL}/chat`, { 
            storeId: SHARED_CEREBRO_ID, 
            query 
        }, {
            timeout: 30000 // 30 segundos timeout
        });
        
        return res.data?.text || "No recibí respuesta del servidor.";
    } catch (error) {
        if (error.response?.status === 429) {
            throw new Error('⏳ Límite de API alcanzado. Espera 30 segundos e intenta de nuevo.');
        } else if (error.code === 'ECONNABORTED') {
            throw new Error('⏱️ La consulta tardó demasiado. Intenta con una pregunta más específica.');
        } else {
            throw new Error(`Error al consultar: ${error.message}`);
        }
    }
}

// ===== COMANDOS =====

bot.onText(/\/start/, async (msg) => {
    try {
        await bot.sendChatAction(msg.chat.id, 'typing');
        
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`);
        const files = res.data?.files || [];
        const chunks = res.data?.totalChunks || 0;
        
        await bot.sendMessage(msg.chat.id, 
            `¡Hola! 👋 Soy el Cerebro Diego\n\n` +
            `🧠 Conectado a: ${SHARED_CEREBRO_ID.substring(0, 20)}...\n` +
            `📚 ${files.length} documentos cargados\n` +
            `📦 ${chunks} chunks de información\n\n` +
            `💡 Puedes:\n` +
            `• Escribir preguntas\n` +
            `• Enviar audios de voz\n` +
            `• Usar /info para ver documentos\n` +
            `• Usar /ayuda para más comandos`
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
        await bot.sendChatAction(msg.chat.id, 'typing');
        
        const res = await axios.get(`${BACKEND_URL}/files?storeId=${SHARED_CEREBRO_ID}`);
        const files = res.data?.files || [];
        const totalChunks = res.data?.totalChunks || 0;
        
        if (files.length === 0) {
            await bot.sendMessage(msg.chat.id, '⚠️ No hay documentos cargados');
        } else {
            const fileList = files.slice(0, 20).map((f, i) => `${i + 1}. ${f}`).join('\n');
            const moreFiles = files.length > 20 ? `\n\n... y ${files.length - 20} más` : '';
            
            await bot.sendMessage(msg.chat.id, 
                `📚 Documentos (${files.length} total):\n\n${fileList}${moreFiles}\n\n` +
                `📦 Total chunks: ${totalChunks}\n` +
                `🆔 Cerebro: ${SHARED_CEREBRO_ID.substring(0, 20)}...`
            );
        }
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ ${err.message}`);
    }
});

bot.onText(/\/ayuda/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `📖 **GUÍA DE USO**\n\n` +
        `**Comandos disponibles:**\n` +
        `/start - Información del sistema\n` +
        `/info - Ver documentos cargados\n` +
        `/ayuda - Esta guía\n\n` +
        `**Cómo usar:**\n` +
        `• Escribe cualquier pregunta\n` +
        `• Envía un audio de voz (mantén presionado 🎤)\n` +
        `• Espera mientras busco en ${files.length} documentos\n\n` +
        `**Consejos:**\n` +
        `✅ Preguntas específicas funcionan mejor\n` +
        `✅ Si sale error de cuota, espera 30 segundos\n` +
        `✅ Los audios deben ser claros y cortos (<1 min)`,
        { parse_mode: 'Markdown' }
    );
});

// ===== VOZ =====

bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    let audioPath = null;
    
    try {
        // Indicar que está procesando
        await bot.sendChatAction(chatId, 'typing');
        await bot.sendMessage(chatId, '🎤 Transcribiendo audio...');
        
        // Descargar audio
        const file = await bot.getFile(msg.voice.file_id);
        audioPath = path.join(__dirname, `voice_${Date.now()}.oga`);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(audioPath, response.data);
        
        // Transcribir
        const transcription = await transcribeAudio(audioPath);
        await bot.sendMessage(chatId, `📝 Escuché: "${transcription}"`);
        
        // Buscar respuesta
        await bot.sendChatAction(chatId, 'typing');
        await bot.sendMessage(chatId, '🧠 Buscando en documentos...');
        
        const answer = await queryRAG(transcription);
        
        // Enviar respuesta en texto (siempre)
        await sendTypingMessage(chatId, answer);
        
        // Intentar TTS (opcional)
        try {
            await bot.sendChatAction(chatId, 'record_audio');
            const ttsPath = await textToSpeech(answer);
            
            if (ttsPath && fs.existsSync(ttsPath)) {
                await bot.sendVoice(chatId, ttsPath);
                fs.unlinkSync(ttsPath);
            }
        } catch (ttsError) {
            // Si TTS falla, no pasa nada, ya enviamos el texto
            console.log('TTS no disponible, solo texto');
        }
        
        // Limpiar audio
        if (audioPath && fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
        }
        
    } catch (err) {
        console.error('Error en voz:', err);
        await bot.sendMessage(chatId, `❌ ${err.message}`);
        
        if (audioPath && fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
        }
    }
});

// ===== TEXTO =====

bot.on('message', async (msg) => {
    // Ignorar comandos y audios
    if (msg.text?.startsWith('/') || msg.voice || !msg.text) return;
    
    const chatId = msg.chat.id;
    
    try {
        // Indicar que está buscando
        await bot.sendChatAction(chatId, 'typing');
        
        // Mensaje de "buscando"
        const searchMsg = await bot.sendMessage(chatId, '🔍 Buscando en documentos...');
        
        // Consultar
        const answer = await queryRAG(msg.text);
        
        // Borrar mensaje de "buscando"
        await bot.deleteMessage(chatId, searchMsg.message_id);
        
        // Enviar respuesta con indicador de escritura
        await sendTypingMessage(chatId, answer);
        
    } catch (err) {
        console.error('Error en texto:', err);
        await bot.sendMessage(chatId, `❌ ${err.message}`);
    }
});

// ===== MANEJO DE ERRORES GLOBAL =====

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

console.log('✅ Bot listo v2.0.0');
console.log('📊 Características:');
console.log('   • Mensajes largos divididos automáticamente');
console.log('   • Indicador "escribiendo..." activo');
console.log('   • Manejo de errores de cuota');
console.log('   • Timeout de 30s por consulta');
console.log('   • TTS opcional (no bloquea si falla)');
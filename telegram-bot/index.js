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

// ✅ CEREBRO CORRECTO CON CHUNKS
const SHARED_CEREBRO_ID = 'cerebro_1767296914664';

// ===== SERVIDOR HTTP =====
app.get('/', (req, res) => {
    res.json({ 
        status: 'Bot activo 🟢',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        cerebro: SHARED_CEREBRO_ID,
        project: 'entradas24december',
        version: '3.0.0 - PREMIUM'
    });
});

app.listen(HTTP_PORT, () => console.log(`🌐 HTTP Server: ${HTTP_PORT}`));

// ===== VALIDACIÓN =====
if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !BACKEND_URL) {
    console.error('❌ Faltan variables de entorno requeridas');
    process.exit(1);
}

// ===== INICIALIZACIÓN =====
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

console.log('═══════════════════════════════════════');
console.log('🤖 Cerebro Diego Bot v3.0.0 PREMIUM');
console.log('═══════════════════════════════════════');
console.log(`📡 Backend: ${BACKEND_URL}`);
console.log(`🧠 Cerebro: ${SHARED_CEREBRO_ID}`);
console.log(`💾 Proyecto: entradas24december`);
console.log(`✨ Características:`);
console.log(`   ✅ Indicador "escribiendo..."`);
console.log(`   ✅ División automática de mensajes largos`);
console.log(`   ✅ Transcripción de voz`);
console.log(`   ✅ Respuestas en audio (TTS)`);
console.log(`   ✅ Manejo robusto de errores`);
console.log('═══════════════════════════════════════');

// ===== UTILIDADES =====

/**
 * Divide mensajes largos en chunks para Telegram (max 4000 chars)
 */
function splitMessage(text, maxLength = 4000) {
    if (text.length <= maxLength) return [text];
    
    const chunks = [];
    let currentChunk = '';
    
    // Dividir por párrafos primero
    const paragraphs = text.split('\n\n');
    
    for (const para of paragraphs) {
        // Si añadir este párrafo supera el límite
        if ((currentChunk + para + '\n\n').length > maxLength) {
            // Guardar chunk actual si tiene contenido
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
            }
            
            // Si el párrafo solo es muy largo, hay que dividirlo por frases
            if (para.length > maxLength) {
                const sentences = para.split('. ');
                let sentenceChunk = '';
                
                for (const sentence of sentences) {
                    if ((sentenceChunk + sentence + '. ').length > maxLength) {
                        if (sentenceChunk) chunks.push(sentenceChunk.trim());
                        sentenceChunk = sentence + '. ';
                    } else {
                        sentenceChunk += sentence + '. ';
                    }
                }
                
                if (sentenceChunk) {
                    currentChunk = sentenceChunk;
                } else {
                    currentChunk = '';
                }
            } else {
                currentChunk = para + '\n\n';
            }
        } else {
            currentChunk += para + '\n\n';
        }
    }
    
    // Añadir último chunk
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks;
}

/**
 * Envía un mensaje con indicador "escribiendo..." y maneja mensajes largos
 */
async function sendTypingMessage(chatId, text) {
    const chunks = splitMessage(text);
    
    for (let i = 0; i < chunks.length; i++) {
        // Mostrar indicador "escribiendo..."
        await bot.sendChatAction(chatId, 'typing');
        
        // Pausa breve para que se vea el indicador
        await new Promise(r => setTimeout(r, 500));
        
        // Enviar chunk
        await bot.sendMessage(chatId, chunks[i]);
        
        // Si hay más chunks, pausar entre mensajes
        if (i < chunks.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// ===== FUNCIONES DE IA =====

/**
 * Transcribe audio usando Gemini
 */
async function transcribeAudio(audioPath) {
    try {
        const audioBuffer = fs.readFileSync(audioPath);
        const base64Audio = audioBuffer.toString('base64');
        
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const result = await model.generateContent([
            { inlineData: { mimeType: 'audio/ogg', data: base64Audio } },
            "Transcribe este audio palabra por palabra en el idioma original."
        ]);
        
        return result.response.text().trim();
    } catch (error) {
        console.error('❌ Error transcribiendo:', error.message);
        throw new Error('No pude transcribir el audio. Intenta hablar más claro o envía un mensaje de texto.');
    }
}

/**
 * Genera audio TTS usando Gemini
 */
async function textToSpeech(text) {
    try {
        // Limitar longitud para TTS (max 500 chars para audio fluido)
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
        console.error('⚠️ TTS no disponible:', error.message);
        return null; // No es crítico, solo enviaremos texto
    }
}

/**
 * Consulta el RAG backend
 */
async function queryRAG(query) {
    try {
        const res = await axios.post(`${BACKEND_URL}/chat`, { 
            storeId: SHARED_CEREBRO_ID, 
            query 
        }, {
            timeout: 60000 // 60 segundos timeout
        });
        
        return res.data?.text || "No recibí respuesta del servidor.";
    } catch (error) {
        if (error.response?.status === 429) {
            throw new Error('⏳ He alcanzado el límite de consultas. Por favor espera 1 minuto e intenta de nuevo.');
        } else if (error.code === 'ECONNABORTED') {
            throw new Error('⏱️ La consulta tardó demasiado. Intenta con una pregunta más específica.');
        } else if (error.response?.status >= 500) {
            throw new Error('🔧 El servidor está teniendo problemas. Intenta de nuevo en unos segundos.');
        } else {
            throw new Error(`Error al consultar: ${error.message}`);
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
            `🧠 Sistema de conocimiento conectado\n` +
            `📚 ${files.length} documentos disponibles\n` +
            `📦 ${chunks} fragmentos indexados\n\n` +
            `💡 *Cómo usarme:*\n` +
            `• Escribe cualquier pregunta\n` +
            `• Envía un audio con tu pregunta 🎤\n` +
            `• Usa /info para ver los documentos\n` +
            `• Usa /ayuda para más información`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        console.error('Error en /start:', err);
        await bot.sendMessage(msg.chat.id, 
            `¡Hola! 👋\n\n` +
            `Soy el Cerebro Diego, tu asistente de conocimiento.\n` +
            `Pregúntame lo que quieras!`
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
            await bot.sendMessage(msg.chat.id, '⚠️ No hay documentos cargados en el cerebro.');
        } else {
            // Mostrar máximo 20 archivos
            const displayFiles = files.slice(0, 20);
            const fileList = displayFiles.map((f, i) => `${i + 1}. ${f}`).join('\n');
            const moreFiles = files.length > 20 ? `\n\n_... y ${files.length - 20} documentos más_` : '';
            
            await bot.sendMessage(msg.chat.id, 
                `📚 *Documentos disponibles* (${files.length} total):\n\n${fileList}${moreFiles}\n\n` +
                `📦 Total de fragmentos: ${totalChunks}\n` +
                `🆔 ID del cerebro: \`${SHARED_CEREBRO_ID}\``,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (err) {
        console.error('Error en /info:', err);
        await bot.sendMessage(msg.chat.id, `❌ Error obteniendo información: ${err.message}`);
    }
});

bot.onText(/\/ayuda/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `📖 *GUÍA DE USO DEL CEREBRO DIEGO*\n\n` +
        `*Comandos disponibles:*\n` +
        `/start - Iniciar y ver estado del sistema\n` +
        `/info - Ver documentos disponibles\n` +
        `/ayuda - Mostrar esta guía\n\n` +
        `*Cómo hacer preguntas:*\n` +
        `• *Por texto:* Simplemente escribe tu pregunta\n` +
        `• *Por voz:* Mantén presionado 🎤 y habla\n\n` +
        `*Características:*\n` +
        `✅ Búsqueda semántica inteligente\n` +
        `✅ Respuestas basadas en documentos reales\n` +
        `✅ Soporte de audio bidireccional\n` +
        `✅ Referencias a fuentes específicas\n\n` +
        `*Consejos para mejores resultados:*\n` +
        `💡 Sé específico en tus preguntas\n` +
        `💡 Si la respuesta es larga, la dividiré en partes\n` +
        `💡 Los audios deben ser claros (máx 2 min)\n` +
        `💡 Si hay error, espera 30 segundos e intenta de nuevo`,
        { parse_mode: 'Markdown' }
    );
});

// ===== MANEJO DE VOZ =====

bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    let audioPath = null;
    let ttsPath = null;
    
    try {
        // 1. Indicar que está procesando
        await bot.sendChatAction(chatId, 'typing');
        const statusMsg = await bot.sendMessage(chatId, '🎤 Transcribiendo tu audio...');
        
        // 2. Descargar audio
        const file = await bot.getFile(msg.voice.file_id);
        audioPath = path.join(__dirname, `voice_${Date.now()}.oga`);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(audioPath, response.data);
        
        // 3. Transcribir
        const transcription = await transcribeAudio(audioPath);
        await bot.editMessageText(`📝 Escuché: "${transcription}"`, {
            chat_id: chatId,
            message_id: statusMsg.message_id
        });
        
        // 4. Buscar respuesta
        await bot.sendChatAction(chatId, 'typing');
        await bot.sendMessage(chatId, '🧠 Buscando en los documentos...');
        
        const answer = await queryRAG(transcription);
        
        // 5. Enviar respuesta en texto (SIEMPRE)
        await sendTypingMessage(chatId, answer);
        
        // 6. Intentar generar y enviar audio (OPCIONAL)
        try {
            await bot.sendChatAction(chatId, 'record_audio');
            ttsPath = await textToSpeech(answer);
            
            if (ttsPath && fs.existsSync(ttsPath)) {
                await bot.sendVoice(chatId, ttsPath);
            }
        } catch (ttsError) {
            // TTS es opcional, no pasa nada si falla
            console.log('⚠️ TTS no disponible, respuesta enviada solo como texto');
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
    // Ignorar comandos, audios y mensajes sin texto
    if (msg.text?.startsWith('/') || msg.voice || !msg.text) return;
    
    const chatId = msg.chat.id;
    let searchMsg = null;
    
    try {
        // 1. Mostrar indicador "escribiendo..."
        await bot.sendChatAction(chatId, 'typing');
        
        // 2. Mensaje de estado "Buscando..."
        searchMsg = await bot.sendMessage(chatId, '🔍 Buscando en los documentos...');
        
        // 3. Consultar RAG
        const answer = await queryRAG(msg.text);
        
        // 4. Borrar mensaje de "Buscando..."
        try {
            await bot.deleteMessage(chatId, searchMsg.message_id);
        } catch (e) {
            // No es crítico si no se puede borrar
        }
        
        // 5. Enviar respuesta con indicador de escritura
        await sendTypingMessage(chatId, answer);
        
    } catch (err) {
        console.error('❌ Error procesando mensaje:', err);
        
        // Intentar borrar mensaje de búsqueda
        if (searchMsg) {
            try {
                await bot.deleteMessage(chatId, searchMsg.message_id);
            } catch (e) {}
        }
        
        await bot.sendMessage(chatId, `❌ ${err.message}`);
    }
});

// ===== MANEJO DE ERRORES GLOBAL =====

bot.on('polling_error', (error) => {
    console.error('⚠️ Polling error:', error.code, error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('⚠️ Unhandled rejection:', error);
});

process.on('SIGINT', () => {
    console.log('\n👋 Apagando bot...');
    bot.stopPolling();
    process.exit(0);
});

console.log('✅ Bot listo y esperando mensajes...\n');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ===== CONFIGURACIÓN =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL || 'https://backend-cerebro-987192214624.europe-southwest1.run.app';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!TELEGRAM_TOKEN) {
    console.error('❌ Falta TELEGRAM_TOKEN en variables de entorno');
    process.exit(1);
}

if (!GEMINI_API_KEY) {
    console.error('❌ Falta GEMINI_API_KEY en variables de entorno');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Almacén temporal de cerebros por usuario
const userStores = new Map();
const userLanguages = new Map(); // Para almacenar idioma preferido

console.log('🤖 Bot de Telegram iniciado correctamente');
console.log(`📡 Conectado al backend: ${BACKEND_URL}`);

// ===== FUNCIÓN: Transcribir Audio =====
async function transcribeAudio(audioPath) {
    try {
        console.log('🎤 Transcribiendo audio con Gemini...');
        
        // Leer el archivo de audio
        const audioBuffer = fs.readFileSync(audioPath);
        const base64Audio = audioBuffer.toString('base64');
        
        // Determinar el tipo MIME
        const mimeType = audioPath.endsWith('.oga') || audioPath.endsWith('.ogg') 
            ? 'audio/ogg' 
            : 'audio/mpeg';
        
        // Usar Gemini para transcripción
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: mimeType,
                    data: base64Audio
                }
            },
            "Transcribe este audio palabra por palabra. Devuelve SOLO el texto transcrito, sin comentarios adicionales."
        ]);
        
        const transcription = result.response.text().trim();
        console.log(`✅ Transcripción: "${transcription}"`);
        
        return transcription;
        
    } catch (error) {
        console.error('❌ Error transcribiendo audio:', error.message);
        throw new Error('No pude transcribir el audio. Intenta de nuevo o escribe tu mensaje.');
    }
}

// ===== FUNCIÓN: Texto a Voz =====
async function textToSpeech(text, language = 'es') {
    try {
        console.log('🔊 Generando audio con TTS...');
        
        // Usar Gemini para generar audio
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash-exp",
        });
        
        const prompt = `Di esto en voz alta de forma natural y clara: "${text}"`;
        
        const result = await model.generateContent({
            contents: [{
                role: "user",
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                responseMimeType: "audio/wav",
                responseModalities: ["AUDIO"]
            }
        });
        
        // Obtener el audio generado
        const audioData = result.response.text(); // Base64 encoded audio
        
        // Guardar en archivo temporal
        const tempPath = path.join(__dirname, `tts_${Date.now()}.wav`);
        fs.writeFileSync(tempPath, Buffer.from(audioData, 'base64'));
        
        console.log(`✅ Audio generado: ${tempPath}`);
        return tempPath;
        
    } catch (error) {
        console.error('⚠️ TTS con Gemini no disponible, usando fallback...');
        
        // FALLBACK: Si Gemini Audio no está disponible, devolver null
        // El bot enviará solo texto
        return null;
    }
}

// ===== FUNCIÓN: Consultar RAG =====
async function queryRAG(storeId, query) {
    try {
        console.log(`🧠 Consultando RAG: "${query}"`);
        
        const response = await axios.post(`${BACKEND_URL}/chat`, {
            storeId: storeId,
            query: query
        }, {
            timeout: 30000
        });
        
        if (response.data && response.data.text) {
            console.log(`✅ Respuesta del RAG (${response.data.text.length} chars)`);
            return response.data.text;
        }
        
        return "No pude obtener una respuesta del cerebro.";
        
    } catch (error) {
        console.error('❌ Error consultando RAG:', error.message);
        throw new Error('Error consultando el cerebro. Intenta de nuevo.');
    }
}

// ===== COMANDO: /start =====
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Usuario';
    
    bot.sendMessage(chatId, 
        `¡Hola ${userName}! 👋\n\n` +
        `Soy tu asistente de voz con memoria.\n\n` +
        `🎤 **Envíame un audio** y te responderé con voz\n` +
        `💬 O escribe tu pregunta\n\n` +
        `**Comandos disponibles:**\n` +
        `/crear <nombre> - Crear un nuevo cerebro\n` +
        `/info - Ver tu cerebro actual\n` +
        `/ayuda - Mostrar esta ayuda\n\n` +
        `¿En qué puedo ayudarte?`
    );
});

// ===== COMANDO: /ayuda =====
bot.onText(/\/ayuda/, (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId,
        `📚 **Guía de uso**\n\n` +
        `**1. Crear tu cerebro:**\n` +
        `/crear MiCerebro\n\n` +
        `**2. Subir documentos:**\n` +
        `Envía archivos PDF, TXT o MD\n\n` +
        `**3. Preguntar:**\n` +
        `🎤 Envía un **audio de voz**\n` +
        `💬 O escribe tu pregunta\n\n` +
        `**4. Recibir respuesta:**\n` +
        `🔊 Recibirás un **audio de voz** (si está disponible)\n` +
        `📝 O texto si el audio no está disponible\n\n` +
        `**Otros comandos:**\n` +
        `/info - Ver documentos en tu cerebro\n` +
        `/reset - Eliminar cerebro actual`
    );
});

// ===== COMANDO: /crear =====
bot.onText(/\/crear(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const cerebroName = match[1].trim() || `Cerebro_${msg.from.first_name}`;
    
    try {
        bot.sendMessage(chatId, '🧠 Creando tu cerebro...');
        
        const response = await axios.post(`${BACKEND_URL}/create-store`, {
            name: cerebroName
        });
        
        const storeId = response.data.name;
        userStores.set(chatId, storeId);
        
        bot.sendMessage(chatId,
            `✅ **Cerebro creado:** ${cerebroName}\n\n` +
            `📤 Ahora puedes subir documentos (PDF, TXT, MD)\n` +
            `🎤 O enviar audios para consultar`
        );
        
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error creando cerebro: ${error.message}`);
    }
});

// ===== COMANDO: /info =====
bot.onText(/\/info/, async (msg) => {
    const chatId = msg.chat.id;
    const storeId = userStores.get(chatId);
    
    if (!storeId) {
        return bot.sendMessage(chatId, '⚠️ No tienes un cerebro activo. Usa /crear para crear uno.');
    }
    
    try {
        const response = await axios.get(`${BACKEND_URL}/files`, {
            params: { storeId }
        });
        
        const { files, totalChunks } = response.data;
        
        if (files.length === 0) {
            return bot.sendMessage(chatId, '📂 Tu cerebro está vacío. Sube algunos documentos.');
        }
        
        const fileList = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
        
        bot.sendMessage(chatId,
            `🧠 **Tu Cerebro**\n\n` +
            `📚 **Documentos (${files.length}):**\n${fileList}\n\n` +
            `📦 **Chunks totales:** ${totalChunks}`
        );
        
    } catch (error) {
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// ===== COMANDO: /reset =====
bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    userStores.delete(chatId);
    bot.sendMessage(chatId, '🗑️ Cerebro eliminado. Usa /crear para crear uno nuevo.');
});

// ===== MANEJO: Documentos =====
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const storeId = userStores.get(chatId);
    
    if (!storeId) {
        return bot.sendMessage(chatId, '⚠️ Primero crea un cerebro con /crear');
    }
    
    const fileName = msg.document.file_name;
    const fileExt = path.extname(fileName).toLowerCase();
    
    if (!['.pdf', '.txt', '.md'].includes(fileExt)) {
        return bot.sendMessage(chatId, '⚠️ Solo acepto PDF, TXT o MD');
    }
    
    try {
        bot.sendMessage(chatId, `📥 Descargando ${fileName}...`);
        
        const file = await bot.getFile(msg.document.file_id);
        const filePath = path.join(__dirname, fileName);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(filePath, response.data);
        
        bot.sendMessage(chatId, `⚙️ Procesando con embeddings...`);
        
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        
        const uploadResponse = await axios.post(`${BACKEND_URL}/upload`, formData, {
            headers: formData.getHeaders(),
            maxBodyLength: Infinity,
            timeout: 120000
        });
        
        const { chunks } = uploadResponse.data.file;
        
        await axios.post(`${BACKEND_URL}/link-file`, {
            storeId,
            fileName,
            chunks
        });
        
        fs.unlinkSync(filePath);
        
        bot.sendMessage(chatId, `✅ **${fileName}** añadido al cerebro\n📦 ${chunks.length} chunks procesados`);
        
    } catch (error) {
        console.error('Error procesando documento:', error);
        bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
});

// ===== MANEJO: Audio de Voz =====
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const storeId = userStores.get(chatId);
    
    if (!storeId) {
        return bot.sendMessage(chatId, '⚠️ Primero crea un cerebro con /crear');
    }
    
    let audioPath = null;
    
    try {
        // 1. Descargar audio
        bot.sendMessage(chatId, '🎤 Escuchando tu audio...');
        
        const file = await bot.getFile(msg.voice.file_id);
        audioPath = path.join(__dirname, `voice_${Date.now()}.oga`);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(audioPath, response.data);
        
        // 2. Transcribir
        bot.sendMessage(chatId, '🔄 Transcribiendo...');
        const transcription = await transcribeAudio(audioPath);
        
        // Mostrar transcripción
        bot.sendMessage(chatId, `📝 Escuché: "${transcription}"`);
        
        // 3. Consultar RAG
        bot.sendMessage(chatId, '🧠 Consultando cerebro...');
        const answer = await queryRAG(storeId, transcription);
        
        // 4. Generar audio de respuesta
        bot.sendMessage(chatId, '🔊 Generando audio de respuesta...');
        const ttsPath = await textToSpeech(answer, userLanguages.get(chatId) || 'es');
        
        // 5. Enviar respuesta
        if (ttsPath && fs.existsSync(ttsPath)) {
            // Enviar audio
            await bot.sendVoice(chatId, ttsPath);
            fs.unlinkSync(ttsPath);
        }
        
        // Siempre enviar texto también
        bot.sendMessage(chatId, `💬 ${answer}`);
        
        // Limpiar
        if (fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
        }
        
    } catch (error) {
        console.error('❌ Error procesando audio:', error);
        bot.sendMessage(chatId, `❌ ${error.message}`);
        
        if (audioPath && fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
        }
    }
});

// ===== MANEJO: Mensajes de Texto =====
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    // Ignorar comandos y otros tipos
    if (msg.text && msg.text.startsWith('/')) return;
    if (msg.voice || msg.document) return;
    if (!msg.text) return;
    
    const storeId = userStores.get(chatId);
    
    if (!storeId) {
        return bot.sendMessage(chatId, '⚠️ Primero crea un cerebro con /crear');
    }
    
    try {
        bot.sendMessage(chatId, '🧠 Consultando...');
        
        const answer = await queryRAG(storeId, msg.text);
        
        // Intentar generar audio de respuesta
        const ttsPath = await textToSpeech(answer);
        
        if (ttsPath && fs.existsSync(ttsPath)) {
            await bot.sendVoice(chatId, ttsPath);
            fs.unlinkSync(ttsPath);
        }
        
        // Enviar texto
        bot.sendMessage(chatId, answer);
        
    } catch (error) {
        console.error('Error:', error);
        bot.sendMessage(chatId, `❌ ${error.message}`);
    }
});

// ===== ERROR HANDLING =====
bot.on('polling_error', (error) => {
    console.error('❌ Polling error:', error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
});

console.log('✅ Bot listo para recibir mensajes');
console.log('🎤 Modo de voz: ACTIVADO');
console.log('📱 Esperando mensajes de Telegram...');

# 🎤 Bot de Telegram con Voz para Cerebro RAG

Bot de Telegram con **entrada y salida de audio** para consultar tu sistema RAG.

## 🌟 Características

✅ **Entrada de voz**: Envía audios y el bot los transcribe
✅ **Salida de voz**: Recibe respuestas en audio
✅ **Entrada de texto**: También acepta mensajes escritos
✅ **Subida de documentos**: PDF, TXT, MD
✅ **Multi-usuario**: Cada usuario tiene su propio cerebro
✅ **Persistencia**: Usa tu backend RAG en la nube

## 📋 Requisitos Previos

1. **Backend RAG desplegado** (ya lo tienes ✅)
2. **Bot de Telegram** (lo crearemos)
3. **API Key de Google Gemini** (la misma del backend)

## 🚀 Paso 1: Crear Bot de Telegram

1. Abre Telegram y busca **@BotFather**
2. Envía `/newbot`
3. Elige un nombre: `Cerebro Diego Bot`
4. Elige un username: `cerebro_diego_bot` (debe terminar en `_bot`)
5. **Guarda el token** que te da (algo como `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## 🛠️ Paso 2: Instalación

```bash
# Crear directorio
mkdir telegram-voice-bot
cd telegram-voice-bot

# Copiar archivos
cp telegram-voice-bot.js index.js
cp telegram-voice-bot-package.json package.json

# Crear archivo .env
cp telegram-voice-bot.env .env

# Editar .env con tus credenciales
nano .env
```

**Contenido del .env:**
```env
TELEGRAM_TOKEN=tu_token_de_botfather
BACKEND_URL=https://backend-cerebro-987192214624.europe-southwest1.run.app
GEMINI_API_KEY=tu_api_key_de_google
```

## 📦 Paso 3: Instalar Dependencias

```bash
npm install
```

## ▶️ Paso 4: Ejecutar

```bash
npm start
```

Verás:
```
🤖 Bot de Telegram iniciado correctamente
📡 Conectado al backend: https://...
✅ Bot listo para recibir mensajes
🎤 Modo de voz: ACTIVADO
📱 Esperando mensajes de Telegram...
```

## 📱 Paso 5: Usar el Bot

### 1️⃣ **Iniciar el bot**
Busca tu bot en Telegram y envía `/start`

### 2️⃣ **Crear tu cerebro**
```
/crear MiCerebro
```

### 3️⃣ **Subir documentos**
Envía archivos PDF, TXT o MD al bot

### 4️⃣ **Consultar con voz**
🎤 **Mantén presionado** el botón de micrófono y habla tu pregunta

### 5️⃣ **Recibir respuesta**
🔊 El bot te responderá con **audio de voz** + texto

## 🎯 Comandos Disponibles

| Comando | Descripción |
|---------|-------------|
| `/start` | Iniciar el bot |
| `/crear [nombre]` | Crear un nuevo cerebro |
| `/info` | Ver documentos en tu cerebro |
| `/ayuda` | Mostrar guía de uso |
| `/reset` | Eliminar cerebro actual |

## 🎤 Modo de Voz

### **Entrada de Voz:**
1. Mantén presionado el **botón de micrófono** 🎤
2. Habla tu pregunta claramente
3. Suelta el botón
4. El bot transcribirá tu audio

### **Salida de Voz:**
1. El bot genera un audio con la respuesta
2. Lo recibes como **nota de voz** 🔊
3. También recibes el **texto** por si acaso

## 💡 Ejemplos de Uso

### Ejemplo 1: Crear cerebro y subir PDF
```
Usuario: /crear MiTesis
Bot: ✅ Cerebro creado: MiTesis

Usuario: [Envía tesis.pdf]
Bot: 📥 Descargando tesis.pdf...
Bot: ⚙️ Procesando con embeddings...
Bot: ✅ tesis.pdf añadido al cerebro
     📦 247 chunks procesados
```

### Ejemplo 2: Consulta por voz
```
Usuario: 🎤 [Audio: "¿Cuál es la conclusión principal de mi tesis?"]
Bot: 📝 Escuché: "¿Cuál es la conclusión principal de mi tesis?"
Bot: 🧠 Consultando cerebro...
Bot: 🔊 [Audio de respuesta]
Bot: 💬 La conclusión principal de tu tesis es...
```

### Ejemplo 3: Consulta por texto
```
Usuario: ¿Qué dice sobre la metodología?
Bot: 🧠 Consultando...
Bot: 🔊 [Audio de respuesta]
Bot: 💬 La metodología utilizada incluye...
```

## 🔧 Troubleshooting

### El bot no responde
```bash
# Verificar que está corriendo
ps aux | grep node

# Ver logs
npm start
```

### Error de transcripción
- Verifica que `GEMINI_API_KEY` esté correcta
- Asegúrate de hablar claro y despacio
- Comprueba que el audio no sea muy largo (max 2 min)

### Error de TTS (texto a voz)
- Si TTS falla, el bot enviará solo texto
- Verifica límites de API de Gemini
- El TTS usa modelos experimentales que pueden cambiar

### No encuentra el cerebro
```
/info  # Ver si tienes un cerebro activo
/crear MiCerebro  # Crear uno nuevo
```

## 🌐 Desplegar en Servidor (Opcional)

### En Google Cloud Run:

```bash
# Crear Dockerfile
cat > Dockerfile << 'EOF'
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]
EOF

# Desplegar
gcloud run deploy telegram-voice-bot \
  --source . \
  --region europe-southwest1 \
  --set-env-vars TELEGRAM_TOKEN=tu_token \
  --set-env-vars BACKEND_URL=tu_backend_url \
  --set-env-vars GEMINI_API_KEY=tu_api_key \
  --allow-unauthenticated
```

### En tu PC/Servidor:

```bash
# Instalar PM2
npm install -g pm2

# Ejecutar en background
pm2 start index.js --name telegram-bot

# Ver logs
pm2 logs telegram-bot

# Reiniciar
pm2 restart telegram-bot
```

## 📊 Arquitectura

```
Usuario (Telegram)
    ↓ Audio de voz
[Bot Node.js]
    ↓ Transcripción (Gemini)
    ↓ Texto extraído
[Backend RAG]
    ↓ Búsqueda semántica
    ↓ Respuesta generada
[Bot Node.js]
    ↓ TTS (Gemini)
    ↓ Audio generado
Usuario (Telegram)
    ✅ Recibe audio + texto
```

## 🎯 Características Avanzadas

### Multi-usuario
- Cada usuario tiene su propio `cerebro`
- Los datos se almacenan por `chatId`
- No hay interferencia entre usuarios

### Soporte de idiomas
- El bot detecta el idioma del audio
- La transcripción funciona en múltiples idiomas
- TTS responde en el mismo idioma

### Formatos soportados
- **Audio**: OGG, MP3, WAV
- **Documentos**: PDF, TXT, MD
- **Respuestas**: Audio + Texto

## 🔒 Seguridad

- No almacena archivos de audio permanentemente
- Los audios se borran después de procesarse
- Cada usuario solo ve su propio cerebro
- No hay acceso cross-user

## 📝 Notas

- El TTS usa modelos experimentales que pueden cambiar
- Si TTS no funciona, el bot enviará solo texto
- Los audios largos (>2min) pueden fallar en transcripción
- Límites de API de Gemini aplican

## 🆘 Soporte

Si tienes problemas:
1. Verifica los logs: `npm start`
2. Comprueba las variables de entorno en `.env`
3. Asegúrate de que el backend esté corriendo
4. Verifica límites de API en Google AI Studio

---

**¡Disfruta tu bot de voz! 🎉**

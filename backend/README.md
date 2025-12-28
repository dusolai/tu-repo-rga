# Backend Cerebro Diego.

Backend para sistema RAG con Google Gemini.

## 🚀 Despliegue en Google Cloud Run

Este backend está configurado para desplegarse automáticamente en Cloud Run.

### Variables de Entorno Requeridas

- `GEMINI_API_KEY`: Tu clave de API de Google Gemini

### Endpoints

- `GET /` - Health check
- `POST /upload` - Subir archivo a Gemini
- `POST /create-store` - Crear un nuevo RAG store
- `POST /link-file` - Vincular archivo a store
- `POST /chat` - Consultar el cerebro

## 🛠️ Desarrollo Local
```bash
npm install
GEMINI_API_KEY=tu_clave npm start
```

## 📦 Stack Tecnológico

- Node.js 18+
- Express 4.x
- Multer (manejo de archivos)

- Google Generative AI SDK

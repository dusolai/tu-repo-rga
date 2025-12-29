FROM node:20-slim
WORKDIR /usr/src/app

# 1. Copiamos configuraciones
COPY package*.json ./

# 2. INSTALACIÓN NUCLEAR (Incluye firebase-admin)
RUN npm install express multer pdf-parse @google/generative-ai firebase-admin --save

# 3. Copiamos el código
COPY . .

EXPOSE 8080
CMD [ "node", "index.js" ]
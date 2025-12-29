FROM node:20-slim
WORKDIR /usr/src/app

COPY package*.json ./

# Instalamos TODO manualmente para asegurar que no falta nada
RUN npm install express multer pdf-parse @google/generative-ai firebase-admin --save

COPY . .

EXPOSE 8080
CMD [ "node", "index.js" ]
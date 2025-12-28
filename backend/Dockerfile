FROM node:20-slim
WORKDIR /usr/src/app

# 1. Copiamos los archivos de configuración
COPY package*.json ./

# 2. ¡AQUÍ ESTÁ EL TRUCO! 
# Forzamos la instalación manual de las librerías que te faltan.
# Esto ignora cualquier error en tu package.json o bloqueos.
RUN npm install express multer pdf-parse @google/generative-ai --save

# 3. Copiamos el resto del código
COPY . .

# 4. Exponemos el puerto y arrancamos
EXPOSE 8080
CMD [ "node", "index.js" ]

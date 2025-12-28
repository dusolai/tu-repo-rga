# Usamos una imagen ligera de Node.js
FROM node:20-slim

# Creamos el directorio de trabajo
WORKDIR /usr/src/app

# Copiamos primero los archivos de dependencias
COPY package*.json ./

# Instalamos solo lo necesario para producción
RUN npm install --only=production

# Copiamos el resto del código
COPY . .

# Exponemos el puerto 8080
EXPOSE 8080

# Comando para arrancar el servidor
CMD [ "npm", "start" ]
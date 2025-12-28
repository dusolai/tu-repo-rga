# Imagen base oficial de Node.js
FROM node:18-slim

# Directorio de trabajo
WORKDIR /app

# Copiar package files
COPY package*.json ./

# Instalar dependencias de producción
RUN npm install --omit=dev

# Copiar el código
COPY index.js ./

# Exponer el puerto (Cloud Run lo asigna dinámicamente)
EXPOSE 8080

# Variables de entorno por defecto
ENV PORT=8080
ENV NODE_ENV=production

# Comando de inicio
CMD ["node", "index.js"]

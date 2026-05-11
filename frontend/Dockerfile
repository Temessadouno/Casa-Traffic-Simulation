# Base image
FROM node:18-slim

WORKDIR /app

# Copier package.json d'abord (cache optimisé)
COPY package.json package-lock.json* ./

# Installer dépendances
RUN npm install

# Copier le reste du code
COPY . .

# IMPORTANT pour Docker + React
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CHOKIDAR_USEPOLLING=true

EXPOSE 3000

# Lancer React en mode dev
CMD ["npm", "start"]
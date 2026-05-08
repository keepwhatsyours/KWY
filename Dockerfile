FROM node:20-alpine
WORKDIR /app

COPY bot/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY bot/ .

EXPOSE 3030
CMD ["node", "bot.js"]

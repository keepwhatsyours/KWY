FROM node:20-alpine
WORKDIR /app

# Install gmgn-cli globally (peer dependency for /gmgn proxy)
RUN npm install -g gmgn-cli@latest --no-audit --no-fund

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3030
CMD ["node", "bot.js"]

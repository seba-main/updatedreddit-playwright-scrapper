FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
# IMPORTANT: Let Railway provide PORT; don't hard-set it
EXPOSE 3000

CMD ["node", "server.js"]

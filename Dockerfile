# Marginalia web server: serves the single-file page plus the account and sync API.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.js server/features.js ./
COPY app/src/main/assets/index.html ./index.html
ENV NODE_ENV=production
USER node
CMD ["node", "index.js"]

# BangBang server + web. Build from bangbang/:  docker build -t bangbang .
FROM node:24-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
COPY web/ ../web/
COPY contracts/ ../contracts/
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
# tsx runs the TypeScript directly (same as `npm start`); keys come from the host's env vars, never the image.
CMD ["npx", "tsx", "src/index.ts"]

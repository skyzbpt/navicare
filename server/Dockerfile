FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# 以非 root 身分執行（官方 node 映像內建 node 使用者）
USER node
EXPOSE 8080
CMD ["node", "server.js"]

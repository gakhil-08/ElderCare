FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/ ./
COPY --from=frontend-build /app/frontend/dist ./public
RUN mkdir -p /app/backend/data /app/backend/uploads
EXPOSE 8080
CMD ["node", "src/server.js"]

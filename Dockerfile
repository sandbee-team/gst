FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.mjs ./
COPY frontend ./frontend
RUN npm run build

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM python:3.12-slim-bookworm AS runtime
ENV NODE_ENV=production PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 GST_PYTHON=python3 HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/frontend/dist ./frontend/dist
COPY backend ./backend
COPY lib ./lib
COPY server.js package.json captcha_ocr.py captcha_preprocess.py ./
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]

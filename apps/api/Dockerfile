FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --include-workspace-root=false --omit=dev --ignore-scripts && npm i -w apps/api tsx --no-save
COPY apps/api apps/api
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
EXPOSE 4100
HEALTHCHECK CMD wget -qO- http://127.0.0.1:4100/healthz || exit 1
CMD ["npx", "--workspace", "apps/api", "tsx", "src/server.ts"]

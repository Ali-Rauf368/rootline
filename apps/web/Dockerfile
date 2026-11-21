FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root=false
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=http://localhost:4100
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL API_URL=http://api:4100
RUN npm -w apps/web run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production API_URL=http://api:4100
EXPOSE 3100
CMD ["npm", "-w", "apps/web", "run", "start"]

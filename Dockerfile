# صورة واحدة بمرحلتين نهائيتين: api و web
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY db db
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm -w apps/api run build && npm -w apps/web run build

FROM build AS api
ENV PORT=4000
EXPOSE 4000
CMD ["sh", "apps/api/docker-entrypoint.sh"]

FROM build AS web
EXPOSE 5173
CMD ["npm", "-w", "apps/web", "run", "preview", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

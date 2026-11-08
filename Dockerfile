# صورة واحدة بمرحلتين نهائيتين: api و web
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# إعدادات تتحمل الشبكات الضعيفة: إعادة محاولة، مهلة أطول، اتصالات أقل، وذاكرة تخزين
# مؤقت تبقى بين المحاولات (فلا يُعاد تنزيل ما اكتمل). تُعاد العملية حتى 3 مرات.
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 6 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 180000 && \
    npm config set fetch-timeout 600000 && \
    npm config set maxsockets 4 && \
    for i in 1 2 3; do npm ci --no-audit --no-fund --prefer-offline && break; \
      if [ "$i" = 3 ]; then exit 1; fi; echo "npm ci failed, retrying ($i)..."; sleep 10; done
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

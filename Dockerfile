FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY sdks/js ./sdks/js
COPY examples/web-kiosk/package.json ./examples/web-kiosk/package.json
RUN npm ci --no-audit --no-fund && npm run build -w @nativeloc/web
ENV NATIVELOC_DATA=/data PORT=4600 NODE_ENV=production
VOLUME /data
EXPOSE 4600
CMD ["npm", "run", "start", "-w", "@nativeloc/server"]

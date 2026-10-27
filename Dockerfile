FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --rootDir . --outDir dist --strict --skipLibCheck --esModuleInterop --module NodeNext --moduleResolution NodeNext --target ES2023 src/*.ts
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node

FROM runtime AS checkout
EXPOSE 8080
CMD ["node", "dist/src/checkout-main.js"]

FROM runtime AS booth
COPY public ./public
EXPOSE 3000
CMD ["node", "dist/src/main.js"]

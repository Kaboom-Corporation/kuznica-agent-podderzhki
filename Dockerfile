FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
COPY --from=build /app/.output ./.output
COPY --from=build /app/data ./data
COPY --from=build /app/db ./db
COPY --from=build /app/server/assets ./server/assets
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]

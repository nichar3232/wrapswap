FROM node:22-bookworm
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/types ./packages/types
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @wrapswap/types build

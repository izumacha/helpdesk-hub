# ベースイメージ: 軽量な Alpine Linux 上の Node.js 20
FROM node:20-alpine AS base
# 作業ディレクトリ (以降のコマンドのカレント)
WORKDIR /app

# Install dependencies
# 依存解決ステージ (キャッシュ最適化のため分離)
FROM base AS deps
# package.json と package-lock.json を先にコピー (依存変更が無ければキャッシュが効く)
COPY package*.json ./
# lockfile に従って厳密インストール (再現性重視)
RUN npm ci

# Build
# ビルドステージ (Next.js のプロダクションビルドを行う)
FROM base AS builder
# deps から node_modules を持ち込む
COPY --from=deps /app/node_modules ./node_modules
# ソース全体をコピー
COPY . .
# Prisma クライアントを生成 (src/generated/prisma に出力)
RUN npx prisma generate
# Next.js を本番ビルド (standalone 出力に従う)
RUN npm run build

# Production runner
# 実行ステージ (ビルド成果物だけを持つ最小イメージ)
FROM base AS runner
# 本番モード
ENV NODE_ENV=production

# 専用グループ・ユーザーを作成 (root 実行を避けるため)
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# 静的ファイル (画像/フォント等)
COPY --from=builder /app/public ./public
# Next.js standalone のサーバ本体 (server.js + 同梱の node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Next.js が配信する静的ビルド成果物
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Prisma 生成物 (src/generated を相対パスで参照しているため)
COPY --from=builder /app/src/generated ./src/generated

# Prisma CLI, schema, migrations, and seed for DB setup commands
# 起動後に prisma migrate / db seed を実行できるよう CLI と関連ファイルを同梱
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.bin/tsx ./node_modules/.bin/tsx
COPY --from=builder /app/node_modules/tsx ./node_modules/tsx

# 非 root ユーザーで実行 (セキュリティ)
USER nextjs
# コンテナが listen するポート (ドキュメント目的)
EXPOSE 3000
# Next.js が listen するポート
ENV PORT=3000
# 全 IP で listen (コンテナ外からアクセス可能に)
ENV HOSTNAME="0.0.0.0"

# 起動コマンド: standalone が生成した server.js を Node で起動
CMD ["node", "server.js"]

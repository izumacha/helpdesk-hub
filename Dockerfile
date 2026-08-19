# ベースイメージ: 軽量な Alpine Linux 上の Node.js 22 (undici 8 が Node >= 22.19 を要求するため)
FROM node:22-alpine AS base
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
# Prisma CLI のスキーマエンジン (prisma generate / migrate が使うネイティブバイナリ) が
# 要求する OpenSSL 3 を入れる。クエリ自体は Prisma 7 から WebAssembly で組み立てるので
# クエリエンジンのためではない — 消すと prisma generate が動かなくなる
RUN apk add --no-cache openssl
# deps から node_modules を持ち込む
COPY --from=deps /app/node_modules ./node_modules
# ソース全体をコピー
COPY . .
# Prisma クライアントを生成 (src/generated/prisma に出力)
RUN npx prisma generate
# チュートリアル動画リンク (任意)。ヘルプセンターの getting-started ページは
# force-static (SSG) のため next build 実行時点の値が HTML に焼き込まれる。
# --build-arg で渡さない限り docker compose build 経由では反映されないため、
# compose 側で build.args として ${TUTORIAL_VIDEO_URL} を渡す (未設定なら空文字 = 非表示)
ARG TUTORIAL_VIDEO_URL=""
ENV TUTORIAL_VIDEO_URL=$TUTORIAL_VIDEO_URL
# Next.js を本番ビルド (standalone 出力に従う)
RUN npm run build

# Production runner
# 実行ステージ (ビルド成果物だけを持つ最小イメージ)
FROM base AS runner
# 本番モード
ENV NODE_ENV=production
# コンテナ内のタイムゾーンを日本時間 (JST) に設定 (Node.js のデフォルト TZ も日本時間に揃える)
ENV TZ=Asia/Tokyo

# 実行イメージでも `prisma migrate deploy` を叩けるよう OpenSSL 3 を導入する。
# 使うのは Prisma CLI のスキーマエンジン (schema-engine-*-openssl-3.0.x)。
# アプリのクエリは WebAssembly なので不要に見えるが、消すとマイグレーションが動かない
RUN apk add --no-cache openssl

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
# Prisma 7 の設定ファイル。接続 URL と seed コマンドの定義がここにあるため、
# 同梱しないとコンテナ内の `prisma migrate deploy` / `prisma db seed` が動かない
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# seed スクリプトが参照する Prisma クライアントのファクトリ (src/lib/prisma-client.ts) と、
# その中の `@/generated/prisma` を tsx が解決するためのパスエイリアス定義。
# どちらも無いと `prisma db seed` が Cannot find module で落ちる。
# src/lib 全体ではなく必要なファイルだけ入れる — 認証・SSO・メールなどのソースを
# 実行イメージへ持ち込まないため (最小公開)。seed が別の src/lib モジュールを
# 参照するようになったら、その分だけここへ追加する
# (足し忘れ・入れ過ぎはどちらも tests/docker-seed-files.test.ts が落とす)
COPY --from=builder /app/src/lib/prisma-client.ts ./src/lib/prisma-client.ts
COPY --from=builder /app/src/lib/pg-search-path.ts ./src/lib/pg-search-path.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
# Prisma CLI / tsx とその依存をまとめて取り込む (個別コピーでは依存解決が崩れるため)
COPY --from=builder /app/node_modules ./node_modules

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

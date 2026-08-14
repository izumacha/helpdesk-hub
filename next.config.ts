// Next.js 設定ファイルの型 (補完と型安全のため)
import type { NextConfig } from 'next';
// 入口 (proxy) でボディを複製・バッファするときの上限。経路別上限の最大値＋余白から導出している
// (未設定だと既定 10MB で本文が黙って切り詰められる。背景・実測・メモリの見積もりは同ファイル冒頭)
import { ENTRY_MAX_BODY_BYTES } from '@/lib/entry-body-limit';

// Next.js のビルド/実行時の挙動を切り替える設定オブジェクト
const nextConfig: NextConfig = {
  // standalone: 必要最小限のサーバ + 依存だけをまとめた出力 (Docker 配布用)
  output: 'standalone',
  experimental: {
    // 入口でのボディ複製の上限。**未設定だと既定 10MB で、超えた本文はエラーにならず
    // 先頭 10MB に切り詰められてルートハンドラへ渡る**ため、明示的に設定する
    proxyClientMaxBodySize: ENTRY_MAX_BODY_BYTES,
  },
};

// Next.js が読み取れるよう default export
export default nextConfig;

// PostCSS (CSS の前処理ツール) の設定オブジェクト
const config = {
  // 適用するプラグイン一覧
  plugins: {
    // Tailwind CSS v4 の PostCSS プラグインを有効化 (オプションは無し)
    '@tailwindcss/postcss': {},
  },
};

// PostCSS が読み取れるよう default export
export default config;

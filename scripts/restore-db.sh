#!/usr/bin/env bash
# Phase 4 運用: backup-db.sh が作成したダンプから PostgreSQL を復元するスクリプト。
# docs/smb-dx-pivot-plan.md §4 Phase 4「監査ログ / バックアップ自動化」に対応。
#
# 何をするか:
#   pg_restore で custom 形式 (-Fc) のダンプを DATABASE_URL が指す DB に流し込む。
#   既存オブジェクトと衝突しないよう --clean --if-exists で作り直す。
#
# 警告: このスクリプトは対象 DB の内容を上書きする。実行前に必ず接続先を確認すること。
#
# 使い方:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/restore-db.sh <dump-file>
#   ./scripts/restore-db.sh --help

# エラーで即終了 / 未定義変数をエラー / パイプ失敗を検知
set -euo pipefail

# ダンプ対象 DB の接続文字列 (アプリと同じ DATABASE_URL を再利用する)
DATABASE_URL="${DATABASE_URL:-}"

# 情報ログを stderr に出す関数
log() {
    # 標準エラー出力にメッセージを出す
    echo "[restore-db] $*" >&2
}

# エラーログを出して終了コード 1 で停止する関数
die() {
    # エラー内容を標準エラー出力に出す
    echo "[restore-db] ERROR: $*" >&2
    # 異常終了する
    exit 1
}

# 使い方を表示する関数
usage() {
    # ヒアドキュメントで説明を stderr に出力する
    cat >&2 <<'EOF'
使い方: restore-db.sh <dump-file>

環境変数:
  DATABASE_URL   (必須) 復元先 PostgreSQL の接続文字列

引数:
  <dump-file>    backup-db.sh が作成した custom 形式 (.dump) ファイル

注意: 復元先 DB の既存データは上書きされます。
EOF
}

# 第 1 引数が --help なら使い方を出して正常終了する
if [ "${1:-}" = "--help" ]; then
    # 使い方を表示する
    usage
    # 正常終了
    exit 0
fi

# 復元元のダンプファイルパスを第 1 引数から取得する (未指定なら空文字)
DUMP_FILE="${1:-}"

# 前提チェック: DATABASE_URL が空なら停止する
[ -n "$DATABASE_URL" ] || { usage; die "DATABASE_URL が設定されていません。"; }
# ダンプファイルパスが空なら停止する
[ -n "$DUMP_FILE" ] || { usage; die "ダンプファイルを指定してください。"; }
# 指定ファイルが実在し読み取れるか確認する
[ -r "$DUMP_FILE" ] || die "ダンプファイルが見つからないか読み取れません: $DUMP_FILE"
# pg_restore コマンドが存在するか確認する (なければ postgresql-client 未導入)
command -v pg_restore >/dev/null 2>&1 || die "pg_restore が見つかりません。postgresql-client をインストールしてください。"

# 復元を開始する旨をログに出す (接続先のパスワードは出さない)
log "復元を開始します: ${DUMP_FILE}"
# pg_restore でダンプを流し込む。--clean --if-exists で既存オブジェクトを作り直し、
# --no-owner --no-privileges で権限差異による失敗を避ける。
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$DUMP_FILE" \
    || die "pg_restore に失敗しました。"

# 復元成功をログに出す
log "復元が完了しました: ${DUMP_FILE}"

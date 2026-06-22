#!/usr/bin/env bash
# Phase 4 運用: PostgreSQL データベースの自動バックアップスクリプト。
# docs/smb-dx-pivot-plan.md §4 Phase 4「監査ログ / バックアップ自動化」に対応。
#
# 何をするか:
#   1. DATABASE_URL が指す PostgreSQL を pg_dump の custom 形式 (-Fc, 圧縮込み) でダンプする。
#   2. ダンプを BACKUP_DIR にタイムスタンプ付きファイル名で保存する。
#   3. BACKUP_RETENTION_DAYS より古いダンプを削除する (世代管理 / ディスク枯渇防止)。
#
# 設計方針:
#   - fail-closed: 失敗したら途中で安全に停止する (set -euo pipefail)。
#   - 秘密情報 (パスワード) はログに出さない (DATABASE_URL をそのまま echo しない)。
#   - 純粋な CLI ツール (UI 非依存) なので a11y 規約 §7 は対象外。
#
# 使い方:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/backup-db.sh
#   ./scripts/backup-db.sh --dry-run   # 実際には dump せず動作だけ確認する
#   ./scripts/backup-db.sh --help      # 使い方を表示する

# エラーで即終了 (-e) / 未定義変数をエラー (-u) / パイプ失敗を検知 (pipefail)
set -euo pipefail

# ───────────────────────────────────────────────────────────────────────────
# 設定 (環境変数で上書き可能。既定値はマジックナンバーを避けて名前付き定数化)
# ───────────────────────────────────────────────────────────────────────────

# バックアップの保存先ディレクトリ (未設定なら ./var/backups を使う)
BACKUP_DIR="${BACKUP_DIR:-./var/backups}"
# 何日分のバックアップを残すか (これより古いダンプは削除する。既定 14 日)
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
# ダンプ対象 DB の接続文字列 (アプリと同じ DATABASE_URL を再利用する)
DATABASE_URL="${DATABASE_URL:-}"

# ───────────────────────────────────────────────────────────────────────────
# ログ出力ヘルパー (標準エラー出力に出す。標準出力はファイルパス等の結果専用)
# ───────────────────────────────────────────────────────────────────────────

# 情報ログを stderr に出す関数 (引数の文字列をそのまま表示)
log() {
    # >&2 で標準エラー出力にリダイレクトして出力する
    echo "[backup-db] $*" >&2
}

# エラーログを stderr に出して終了コード 1 で停止する関数
die() {
    # エラー内容を stderr に出力する
    echo "[backup-db] ERROR: $*" >&2
    # 異常終了 (呼び出し元のスクリプトも set -e で停止する)
    exit 1
}

# 使い方を表示する関数 (--help で呼ばれる)
usage() {
    # ヒアドキュメントで複数行の説明を stderr に出す
    cat >&2 <<'EOF'
使い方: backup-db.sh [--dry-run] [--help]

環境変数:
  DATABASE_URL            (必須) ダンプ対象 PostgreSQL の接続文字列
  BACKUP_DIR              バックアップ保存先 (既定: ./var/backups)
  BACKUP_RETENTION_DAYS   保持日数。これより古いダンプは削除 (既定: 14)

オプション:
  --dry-run   実際には dump / 削除せず、実行内容だけ表示する
  --help      この使い方を表示する
EOF
}

# ───────────────────────────────────────────────────────────────────────────
# 引数パース (--dry-run / --help を受け付ける)
# ───────────────────────────────────────────────────────────────────────────

# dry-run かどうかのフラグ (既定は false = 実際に実行する)
DRY_RUN=false
# 渡された引数を 1 つずつ順番に処理する
for arg in "$@"; do
    # 引数の値で分岐する
    case "$arg" in
        # --dry-run が来たらフラグを立てる
        --dry-run) DRY_RUN=true ;;
        # --help が来たら使い方を表示して正常終了する
        --help) usage; exit 0 ;;
        # それ以外の未知の引数はエラーにする (タイプミス検知)
        *) usage; die "不明な引数: $arg" ;;
    esac
done

# ───────────────────────────────────────────────────────────────────────────
# 事前チェック (fail-closed: 前提が満たせないなら何もせず止める)
# ───────────────────────────────────────────────────────────────────────────

# DATABASE_URL が空なら処理を続行できないので停止する
[ -n "$DATABASE_URL" ] || die "DATABASE_URL が設定されていません。"
# pg_dump コマンドが PATH に存在するか確認する (なければ postgresql-client 未導入)
command -v pg_dump >/dev/null 2>&1 || die "pg_dump が見つかりません。postgresql-client をインストールしてください。"
# 保持日数が 0 以上の整数かを正規表現で検証する (不正値での誤削除を防ぐ)
[[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS は 0 以上の整数で指定してください: $BACKUP_RETENTION_DAYS"

# ───────────────────────────────────────────────────────────────────────────
# バックアップ本体
# ───────────────────────────────────────────────────────────────────────────

# 保存先ディレクトリを作成する (既に存在しても -p でエラーにしない)
mkdir -p "$BACKUP_DIR"

# ファイル名に使うタイムスタンプを生成する (例: 20260622_181500)。OS 非依存の標準書式のみ使用
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
# ダンプ先のフルパスを組み立てる (custom 形式は拡張子 .dump が慣例)
DUMP_FILE="${BACKUP_DIR}/helpdesk_hub_${TIMESTAMP}.dump"

# dry-run なら実行予定だけ表示して終了する
if [ "$DRY_RUN" = true ]; then
    # 何をする予定かを stderr に表示する (パスワードを含む DATABASE_URL は出さない)
    log "[dry-run] pg_dump -> ${DUMP_FILE}"
    log "[dry-run] ${BACKUP_RETENTION_DAYS} 日より古い *.dump を ${BACKUP_DIR} から削除予定"
    # 実処理はせず正常終了する
    exit 0
fi

# pg_dump を custom 形式 (-Fc, 内部 gzip 圧縮) で実行しファイルへ出力する。
# --no-owner / --no-privileges で復元先の権限差異による失敗を避ける。
log "バックアップを開始します -> ${DUMP_FILE}"
# pg_dump を実行する (接続情報は DATABASE_URL からのみ取得し、コマンドラインに平文展開しない)。
# --file 指定時は失敗しても途中までのファイルが残るため、失敗時は部分ファイルを消してから止める
# (空/不完全なダンプを「成功した世代」と誤認させないための後始末)。
if ! pg_dump --format=custom --no-owner --no-privileges --file="$DUMP_FILE" "$DATABASE_URL"; then
    # 失敗時に生成された部分ファイルを削除する
    rm -f "$DUMP_FILE"
    # 失敗として停止する
    die "pg_dump に失敗しました。"
fi

# 生成されたダンプのサイズを取得する (0 バイトなら異常を疑う)
DUMP_SIZE="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
# サイズが 0 のダンプは壊れている可能性が高いので削除して失敗扱いにする
if [ "$DUMP_SIZE" -eq 0 ]; then
    # 空ファイルを削除する (残すと「成功した世代」と誤認されるため)
    rm -f "$DUMP_FILE"
    # 失敗として停止する
    die "ダンプが 0 バイトでした。バックアップは無効です。"
fi
# 成功したことをサイズ付きで記録する
log "バックアップ完了: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# ───────────────────────────────────────────────────────────────────────────
# 世代管理 (保持日数より古いダンプを削除する)
# ───────────────────────────────────────────────────────────────────────────

# 削除対象 (BACKUP_RETENTION_DAYS 日より古い *.dump) を find で列挙して数える。
# -mtime +N は「N 日より古い」を意味するため、保持日数からそのまま指定できる。
PRUNED=0
# find の結果を while で 1 件ずつ読み (ファイル名に空白があっても安全な -print0 + read -d '')
while IFS= read -r -d '' old_dump; do
    # 古いダンプを削除する
    rm -f "$old_dump"
    # 削除件数のログを残す
    log "古いバックアップを削除しました: ${old_dump}"
    # 削除カウンタを 1 増やす
    PRUNED=$((PRUNED + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'helpdesk_hub_*.dump' -mtime "+${BACKUP_RETENTION_DAYS}" -print0)

# 何件削除したかを最後にまとめて表示する
log "世代管理完了: ${PRUNED} 件の古いバックアップを削除しました (保持 ${BACKUP_RETENTION_DAYS} 日)。"

# 作成したダンプのパスを標準出力に出す (呼び出し側スクリプトがパスを受け取れるように)
echo "$DUMP_FILE"

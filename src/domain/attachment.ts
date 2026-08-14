// 添付ファイルに関する純ドメイン定数とドメイン型をまとめたモジュール。
// UI 層・Server Action 層・データ層から共有して同じ閾値・メッセージを使うための単一の真実源。
//
// **注意 — このファイルは `next.config.ts` の読み込みグラフに入っている。**
// `ticket-body-limits.ts` が下の `MAX_ATTACHMENTS_PER_UPLOAD` / `MAX_ATTACHMENT_SIZE_BYTES` から
// 添付付きアップロードの枠を導出し、それを `entry-body-limit.ts` 経由で `next.config.ts` が読む。
// **新しい import は相対パスで書くこと** (`@/...` はこの連鎖では解決されない)。理由と検証方法は
// `src/lib/entry-body-limit.ts` の import 直前のコメントに 1 か所だけ書いてある。

// 添付として受け付ける MIME 種別 (画像のみ。PDF などは現段階では対象外)
// docs/smb-dx-pivot-plan.md Phase 1 で「スマホで撮った写真を添付」がスコープのため画像に限定する
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg', // JPEG (スマホカメラの既定形式)
  'image/png', // PNG (スクリーンショット用)
  'image/webp', // WebP (Android 系で増えている軽量形式)
  'image/heic', // HEIC (iPhone カメラの既定形式)
] as const;

// 上のリテラル tuple から union 型を導出する (型レベルで MIME を厳格化するため)
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

// 1 ファイル当たりの最大バイト数 (10MB = 10 * 1024 * 1024)
// スマホ写真は概ね 3〜6MB 程度のため余裕を持って 10MB に設定する
export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

// 1 回のアップロード (チケット作成 or コメント投稿) で添付できる最大件数
// 現場の追加写真は概ね 1〜3 枚で済む想定だが余裕を持って 5 枚まで許可する
export const MAX_ATTACHMENTS_PER_UPLOAD = 5;

// 1 件のチケットに生涯で蓄積できる添付ファイルの総数上限。
// MAX_ATTACHMENTS_PER_UPLOAD は「1 回のリクエスト」しか見ないため、同じチケットへの
// コメント追記 (Web フォーム・メールスレッド継続) を繰り返すと際限なく積み上がってしまう
// (監査で発見したギャップ: AttachmentRepository.countByTicket は「5 枚上限チェック用」として
// 用意されていたが、この総数チェックとして呼び出す箇所が一つも無かった)。
// 現場での運用上、1 件の問い合わせに 100 枚を超える写真が必要になることは通常想定しづらいため、
// 余裕を持ってこの値にする
export const MAX_ATTACHMENTS_PER_TICKET = 100;

// MIME に対応する一般的な拡張子の対応表 (保存先キー組み立てや配信時の Content-Disposition で利用)
export const MIME_TO_EXTENSION: Record<AllowedImageMimeType, string> = {
  'image/jpeg': 'jpg', // JPEG は .jpg を採用 (.jpeg ではなく短い方)
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

// 指定された MIME がアプリで受け入れる画像 MIME のいずれかかを判定する型ガード
export function isAllowedImageMimeType(mime: string): mime is AllowedImageMimeType {
  // 配列キャストして includes で判定 (readonly tuple のため string 配列に変換)
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

// バイト数を GB に丸めて文字列化する (プランの添付累計上限を UI/エラーメッセージへ出す用途)
export function formatBytesAsGb(bytes: number): string {
  // 小数第 2 位までに丸める (例: 1.00GB)
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

// バイト数を MB に丸めて文字列化する (ユーザー向けエラーで使う)
function formatMb(bytes: number): string {
  // 小数第 1 位までに丸める (例: 10.0MB)
  return (bytes / (1024 * 1024)).toFixed(1);
}

// 添付の違反を利用者に伝える文言。**サーバー検証 (validations/attachment.ts) と
// フォームの事前検査が同じ文字列を使う**ための単一の参照元 (§6 UI 文言は単一の参照元に集約する)。
// このモジュール冒頭が宣言しているとおり「同じ閾値・メッセージを使うための単一の真実源」は
// ここなので、UI 層からも安全に import できるドメイン側に置く
// (サーバー専用の非同期検証を含む validations/ 側に置くと、Client Component が
// そのモジュール全体を依存グラフに引き込んでしまう)。
export const EMPTY_ATTACHMENT_MESSAGE = '空のファイルは添付できません';
export const ATTACHMENT_TOO_LARGE_MESSAGE = `1 ファイルあたり ${formatMb(MAX_ATTACHMENT_SIZE_BYTES)}MB までです`;
export const TOO_MANY_ATTACHMENTS_MESSAGE = `添付ファイルは最大 ${MAX_ATTACHMENTS_PER_UPLOAD} 件までです`;

/**
 * 1 ファイルに対して「中身を読まずに判定できる違反」(空・サイズ超過) を探す。
 * 違反があれば利用者向けの文言を、無ければ null を返す。
 *
 * **サーバー検証とフォームの事前検査がこの 1 つの関数を共有する。** 文言だけを共有して
 * 判定式を各所に書き写すと、片方に検査を足したり判定順を入れ替えたりしたときに
 * 画面表示と実際の 422 がずれる (規則そのものを 1 箇所に置く / §6 DRY)。
 *
 * MIME とマジックバイトの検査をここに含めないのは、後者が非同期でバイト列の読み出しを伴い、
 * ブラウザ側で先回りする利益が薄いため (サーバーが必ずやり直す)。
 *
 * @param file 判定対象のファイル
 * @returns 違反があればその文言、無ければ null
 */
export function findCheapAttachmentViolation(file: File): string | null {
  // size === 0 のファイルは空ファイル (フォームから誤って送られたケース) として弾く
  if (file.size === 0) return EMPTY_ATTACHMENT_MESSAGE;
  // 1 件あたりのサイズ上限を超えるファイルを弾く
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) return ATTACHMENT_TOO_LARGE_MESSAGE;
  // 安価に判定できる違反は無し (MIME・マジックバイトはサーバー側が見る)
  return null;
}

/**
 * FormData の `files` エントリから「実際に選ばれた添付」だけを取り出す。
 *
 * **未選択の file input が混ぜてくる番兵 (sentinel) を落とすのが目的。** HTML の仕様上、
 * ファイルを 1 つも選んでいない `<input type="file">` もフォームにエントリを 1 件足す。
 * その中身は、**ブラウザでもサーバーでも `File` (name: '', size: 0)** になる
 * (実測: Chromium の `new FormData(form)` は空の File を返し、その `filename=""` パートを
 * undici の `Response.formData()` に通しても空の File が返る)。
 *
 * **`instanceof File` の判定だけでは落ちない**点が要注意で、落とし損ねると
 * `validateUploadedFiles` が 0 バイトとして拒否し、**添付を付けずに送っただけの投稿が
 * 毎回「空のファイルは添付できません」で失敗する**。実際にコメント投稿がこの状態だった。
 * ルート層の回帰テスト (`post-comment-route.test.ts` の「番兵」ケース) が
 * ブラウザと同じ `filename=""` の生ボディで固定してある。
 *
 * 名前のある 0 バイトファイル (利用者が空のファイルを選んだ場合) は番兵ではないので残し、
 * 「空のファイルは添付できません」で弾かれるようにする。
 *
 * @param entries `form.getAll('files')` の戻り値
 * @returns 実際に選ばれた File だけの配列 (未選択なら空配列)
 */
export function selectAttachmentFiles(entries: FormDataEntryValue[]): File[] {
  return entries.filter(
    (entry): entry is File =>
      // 文字列エントリ (想定外の値) は添付ではない
      entry instanceof File &&
      // 番兵 (名前が空 かつ 中身も空) は「未選択」なので添付として数えない
      !(entry.name === '' && entry.size === 0),
  );
}

/**
 * 送信前にブラウザ側で判定できる添付の違反 (件数・空ファイル・1 件あたりのサイズ) を探す。
 * 違反が見つかれば利用者向けの文言を、無ければ null を返す。
 *
 * **なぜフォーム側にも検査が要るのか**: 合計サイズがボディの受け入れ枠
 * (`ticket-body-limits.ts` の `ATTACHMENT_UPLOAD_MAX_BODY_BYTES`) を超えると、**アプリの手前の
 * リバースプロキシ**が本文を受け切らずに切る (`docs/security.md` §7 の `client_max_body_size`)。
 * このとき送信途中の接続が未消費のまま閉じるため、ブラウザが応答より先に接続断を観測して
 * fetch が reject し、画面には「通信状態をご確認ください」という的外れな案内しか出せない
 * (本来出したいのは「1 ファイルあたり 10.0MB までです」)。
 * なお `request-body-limit.ts` にも Content-Length だけで打ち切る事前検査はあるが、
 * `src/proxy.ts` がある現状では入口の複製が本文を受け取り終えてからルートが起動するので
 * (`src/lib/entry-body-limit.ts`)、**そちらは未消費の本文を残さない**。
 * 件数上限 × 1 件あたりの上限は枠の内側に収まるので、**ここで弾いておけば正規の入力が
 * 413 に到達することはなくなり**、違反したときは具体的な理由が画面に出る。
 *
 * **これは体験のための先回りであって、検証の本体ではない。** クライアントの検査は改ざんできるため、
 * 件数・サイズ・MIME・マジックバイトの判定は従来どおりサーバー側の `validateUploadedFiles` が
 * 権威を持つ (§9 認可・検証はサーバー側で強制する)。
 *
 * @param files フォームで選択された File の一覧 (添付なしは空配列)
 * @returns 違反があればその文言、無ければ null
 */
export function findAttachmentPreflightError(files: File[]): string | null {
  // 添付なしは常に許可 (添付は任意のため)
  if (files.length === 0) return null;
  // 件数上限を超えていたら、その時点で確定なので先に返す
  if (files.length > MAX_ATTACHMENTS_PER_UPLOAD) return TOO_MANY_ATTACHMENTS_MESSAGE;
  // 1 件ずつ、サーバー検証と同じ関数で安価な検査だけ当てる
  for (const file of files) {
    const violation = findCheapAttachmentViolation(file);
    // 1 件でも違反があれば、その文言をそのまま返す
    if (violation) return violation;
  }
  // 安価な検査はすべて通過
  return null;
}

// 添付ファイル 1 件分のドメイン表現 (画面表示・API 配信で使う最小情報)
export interface Attachment {
  id: string; // 添付 ID (主キー)
  ticketId: string; // 親チケット ID (必須)
  commentId: string | null; // 紐づくコメント ID (チケット本体への直接添付は null)
  uploaderId: string; // アップロード実行者
  tenantId: string; // 所属テナント (where に必ず注入する)
  mimeType: string; // 検証通過後の MIME (image/jpeg など)
  size: number; // バイト数
  originalName: string; // 元ファイル名 (表示・ダウンロード時のヒント)
  storageKey: string; // 保存先キー (例: tenantId/ticketId/<uuid>.jpg)
  storage: AttachmentStorageKind; // 保存方式 (現状 local 固定)
  createdAt: Date; // 添付日時
}

// 添付の保存先種別 (Prisma enum と 1:1)。Phase 2 以降で s3 を実装する
export type AttachmentStorageKind = 'local' | 's3';

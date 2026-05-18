// 添付ファイル一覧 (サムネイル表示) のサーバーコンポーネント。
// チケット本体 / 各コメントの直下に挿入して使う。
// バイナリは GET /api/attachments/[id] を経由するため、本コンポーネントは ID と表示用メタだけ知っていれば足りる。

// 添付ファイル表示用のサマリ型 (id / mimeType / size / originalName / createdAt)
import type { AttachmentSummary } from '@/domain/attachment-summary';

// 受け取る props (添付一覧 + 表示時の見出し)
interface Props {
  attachments: AttachmentSummary[]; // 表示対象の添付配列 (古い順)
  // 親コンテキスト (チケット本体 / コメント) を区別するための小見出し
  // 省略時は見出しを描画しない (コメント直下のコンパクト表示用)
  heading?: string;
}

// 添付ファイル一覧コンポーネント
export function AttachmentList({ attachments, heading }: Props) {
  // 0 件なら何も描画しない (UI ノイズを増やさない)
  if (attachments.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* 見出しが指定されていれば表示 (チケット本体側で「添付ファイル」を出す用) */}
      {heading && (
        <h3 className="text-xs font-semibold text-gray-500">
          {heading} ({attachments.length}件)
        </h3>
      )}
      {/* サムネをグリッドで並べる (スマホでは 2 列、PC では 4 列を目安) */}
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {attachments.map((a) => (
          <li key={a.id} className="overflow-hidden rounded-md border border-gray-200">
            {/* クリックで原寸を開けるよう <a> でラップする (target=_blank で別タブ) */}
            <a
              href={`/api/attachments/${a.id}`}
              target="_blank"
              rel="noreferrer"
              className="block focus:outline-none focus:ring-2 focus:ring-teal-500"
            >
              {/* 画像本体 (img タグで img/* MIME をブラウザに任せて描画) */}
              {/* Next/Image は外部 URL や認証付き API との相性が悪いため通常の <img> を使う */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/attachments/${a.id}`}
                alt={a.originalName}
                className="aspect-square w-full object-cover"
                loading="lazy"
              />
            </a>
            {/* ファイル名 (はみ出しは省略表示にする) */}
            <p className="truncate px-2 py-1 text-xs text-gray-500" title={a.originalName}>
              {a.originalName}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

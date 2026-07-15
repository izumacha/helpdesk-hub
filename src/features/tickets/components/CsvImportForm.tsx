'use client';

// CSV インポートフォーム (Phase 3 CSV インポート機能 - 列マッピングウィザード付き)
// docs/smb-dx-pivot-plan.md §4 Phase 3「Excel インポート: 最低限の列マッピングウィザード」に対応
// ファイル選択 → 列の対応付け → プレビュー確認 → インポート実行 → 結果表示 の 3 ステップ UI

// 状態管理・非ブロッキング送信のためのフック
import { useState, useTransition } from 'react';
// CSV インポートのサーバーアクション
import { importTickets } from '@/features/tickets/actions/import-tickets';
// インポート結果の型 (成功件数 + エラー一覧)
import type { ImportTicketsResult } from '@/features/tickets/actions/import-tickets';
// RFC 4180 準拠の CSV パーサ と共有定数 (サーバーアクションと同一実装を共有)
import { parseCsvLine, MAX_CSV_BYTES } from '@/lib/csv';

// CSV インポートフォームに渡す Props 型
// categories は将来のカテゴリ選択 UI 向けに受け取るが、MVP では使用しない
interface CsvImportFormProps {
  categories: Array<{ id: string; name: string }>; // カテゴリ一覧 (将来の列マッピング用)
}

// ウィザードのステップを表す文字列リテラル型
// 'select'  : ステップ 1 - CSV ファイルを選択する
// 'map'     : ステップ 2 - CSV の列をシステムフィールドに対応付ける
// 'confirm' : ステップ 3 - プレビューを確認してインポートを実行する
type WizardStep = 'select' | 'map' | 'confirm';

// 列マッピングを表す型 (システムフィールド名 → CSV 列名)
// 空文字は「使わない / 未選択」を意味する
type ColumnMapping = {
  件名: string; // 「件名」フィールドに対応する CSV 列名 (必須。空文字は未選択)
  内容: string; // 「内容」フィールドに対応する CSV 列名 (任意。空文字は使わない)
  期限日: string; // 「期限日」フィールドに対応する CSV 列名 (任意。空文字は使わない)
  優先度: string; // 「優先度」フィールドに対応する CSV 列名 (任意。空文字は使わない)
  // フォローアップ (2026-07-11): CSV エクスポートの「カテゴリ」列と対称にし、エクスポート→
  // 再インポートの往復でカテゴリ情報が失われないようにする
  カテゴリ: string; // 「カテゴリ」フィールドに対応する CSV 列名 (任意。空文字は使わない)
  拠点: string; // 「拠点」フィールドに対応する CSV 列名 (任意。空文字は使わない。Phase 4 多拠点)
  // §3.1 フォローアップ (2026-07-10): 既存 Excel に混在する完了済み行をそのまま取り込めるようにする
  状況: string; // 「状況」フィールドに対応する CSV 列名 (任意。空文字は使わない)
  // フォローアップ (2026-07-13): CSV エクスポートの「担当者」列と対称にし、エクスポート→
  // 再インポートの往復で担当者情報が失われないようにする
  担当者: string; // 「担当者」フィールドに対応する CSV 列名 (任意。空文字は使わない)
  // フォローアップ (2026-07-14): CSV エクスポートの「起票者」列と対称にし、エクスポート→
  // 再インポートの往復で起票者 (依頼者本人) 情報が失われないようにする (監査で発見したギャップ)
  起票者: string; // 「起票者」フィールドに対応する CSV 列名 (任意。空文字は使わない)
  // フォローアップ (2026-07-15 #3): CSV エクスポートの「起票日時」列と対称にし、エクスポート→
  // 再インポートの往復で元の起票日時が失われないようにする (監査で発見したギャップ)
  起票日時: string; // 「起票日時」フィールドに対応する CSV 列名 (任意。空文字は使わない)
};

// プレビューテーブルの 1 行を表す型 (マッピング後の固定システムフィールド)
interface PreviewRow {
  件名: string; // 件名セル
  内容: string; // 内容セル (省略可)
  期限日: string; // 期限日セル (省略可)
  優先度: string; // 優先度セル (省略可)
  カテゴリ: string; // カテゴリセル (省略可。フォローアップ 2026-07-11)
  拠点: string; // 拠点セル (省略可)
  状況: string; // 状況セル (省略可。§3.1 フォローアップ)
  担当者: string; // 担当者セル (省略可。フォローアップ 2026-07-13)
  起票者: string; // 起票者セル (省略可。フォローアップ 2026-07-14)
  起票日時: string; // 起票日時セル (省略可。フォローアップ 2026-07-15 #3)
}

// マッピング設定フォームに表示するシステムフィールドの定義一覧
// 一覧にして管理することで各所に定数を散らさない (§6 定数の一元管理)
const SYSTEM_FIELDS = [
  { key: '件名' as const, label: '件名（必須）', required: true }, // 必須フィールド
  { key: '内容' as const, label: '内容（任意）', required: false }, // 任意フィールド
  { key: '期限日' as const, label: '期限日（任意）', required: false }, // 任意フィールド
  { key: '優先度' as const, label: '優先度（任意）', required: false }, // 任意フィールド
  { key: 'カテゴリ' as const, label: 'カテゴリ（任意）', required: false }, // 任意フィールド (フォローアップ 2026-07-11)
  { key: '拠点' as const, label: '拠点（任意）', required: false }, // 任意フィールド
  { key: '状況' as const, label: '状況（任意）', required: false }, // 任意フィールド (§3.1 フォローアップ)
  { key: '担当者' as const, label: '担当者（任意）', required: false }, // 任意フィールド (フォローアップ 2026-07-13)
  { key: '起票者' as const, label: '起票者（任意）', required: false }, // 任意フィールド (フォローアップ 2026-07-14)
  { key: '起票日時' as const, label: '起票日時（任意）', required: false }, // 任意フィールド (フォローアップ 2026-07-15 #3)
] as const;

// ウィザードのステップ情報一覧 (ステップインジケーターの表示に使う)
// ここで一元管理することで順序変更がしやすい (§6 定数の一元管理)
const WIZARD_STEPS: { key: WizardStep; label: string }[] = [
  { key: 'select', label: 'ファイル選択' }, // ステップ 1
  { key: 'map', label: '列の対応付け' }, // ステップ 2
  { key: 'confirm', label: '確認・実行' }, // ステップ 3
];

// ウィザードの各ステップが何番目かを O(1) で引くためのインデックスマップ
// Array.indexOf を毎回呼ばずに済む (パフォーマンス最適化ではなく可読性向上が目的)
const STEP_INDEX: Record<WizardStep, number> = { select: 0, map: 1, confirm: 2 };

// CSV の 1 セルを RFC 4180 形式でエスケープする純粋関数
// カンマ・ダブルクォート・改行を含む場合はダブルクォートで括り、内部のダブルクォートは "" に変換する
function escapeCsvCell(value: string): string {
  // カンマ・二重引用符・改行 (CR / LF) のいずれかを含む場合は引用符で括る必要がある
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    // 内部のダブルクォートを "" に置換してから全体をダブルクォートで括る (RFC 4180)
    return '"' + value.replace(/"/g, '""') + '"';
  }
  // 特殊文字がなければそのまま返す
  return value;
}

// ColumnMapping を元の CSV テキストに適用し、固定列名 (件名/内容/期限日/優先度) の CSV を生成する純粋関数
// サーバーアクション (importTickets) が期待する列名に合わせてヘッダを書き換える
function applyMapping(csvText: string, mapping: ColumnMapping): string {
  // 改行コード (CRLF / LF どちらにも対応) で行に分割し、空行を除外する
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '');
  // ヘッダ行のみ（データ行ゼロ）またはそれ以下なら空文字を返す
  if (lines.length < 2) return '';
  // ヘッダ行を RFC 4180 パーサで解析して列名の配列を得る
  const headers = parseCsvLine(lines[0] ?? '');
  // 各システムフィールドに対応する元 CSV の列インデックスを求める (マッピング未設定は -1)
  const titleIdx = mapping.件名 ? headers.indexOf(mapping.件名) : -1; // 件名列のインデックス
  const bodyIdx = mapping.内容 ? headers.indexOf(mapping.内容) : -1; // 内容列のインデックス
  const dueIdx = mapping.期限日 ? headers.indexOf(mapping.期限日) : -1; // 期限日列のインデックス
  const priIdx = mapping.優先度 ? headers.indexOf(mapping.優先度) : -1; // 優先度列のインデックス
  const catIdx = mapping.カテゴリ ? headers.indexOf(mapping.カテゴリ) : -1; // カテゴリ列のインデックス (フォローアップ 2026-07-11)
  const locIdx = mapping.拠点 ? headers.indexOf(mapping.拠点) : -1; // 拠点列のインデックス
  const statusIdx = mapping.状況 ? headers.indexOf(mapping.状況) : -1; // 状況列のインデックス (§3.1 フォローアップ)
  const assigneeIdx = mapping.担当者 ? headers.indexOf(mapping.担当者) : -1; // 担当者列のインデックス (フォローアップ 2026-07-13)
  const creatorIdx = mapping.起票者 ? headers.indexOf(mapping.起票者) : -1; // 起票者列のインデックス (フォローアップ 2026-07-14)
  const createdAtIdx = mapping.起票日時 ? headers.indexOf(mapping.起票日時) : -1; // 起票日時列のインデックス (フォローアップ 2026-07-15 #3)
  // 出力 CSV のヘッダ行: サーバーアクションが期待する固定列名で上書きする
  const outLines: string[] = ['件名,内容,期限日,優先度,カテゴリ,拠点,状況,担当者,起票者,起票日時'];
  // データ行を 1 行ずつ変換する
  for (const line of lines.slice(1)) {
    // RFC 4180 パーサで元のセル値を取り出す
    // 引用符が閉じられていない等のパース失敗行はスキップしてインポート処理側のエラーとして扱う
    let cells: string[];
    try {
      cells = parseCsvLine(line); // 行をセル配列に分解する
    } catch {
      // パース失敗行はスキップする (サーバー側でも同じエラーハンドリングが入るため二重管理しない)
      continue;
    }
    // 各フィールドの列インデックスに対応するセルを取り出し、RFC 4180 形式でエスケープして結合する
    const row = [
      escapeCsvCell(titleIdx !== -1 ? (cells[titleIdx] ?? '') : ''), // 件名セル
      escapeCsvCell(bodyIdx !== -1 ? (cells[bodyIdx] ?? '') : ''), // 内容セル
      escapeCsvCell(dueIdx !== -1 ? (cells[dueIdx] ?? '') : ''), // 期限日セル
      escapeCsvCell(priIdx !== -1 ? (cells[priIdx] ?? '') : ''), // 優先度セル
      escapeCsvCell(catIdx !== -1 ? (cells[catIdx] ?? '') : ''), // カテゴリセル (フォローアップ 2026-07-11)
      escapeCsvCell(locIdx !== -1 ? (cells[locIdx] ?? '') : ''), // 拠点セル
      escapeCsvCell(statusIdx !== -1 ? (cells[statusIdx] ?? '') : ''), // 状況セル (§3.1 フォローアップ)
      escapeCsvCell(assigneeIdx !== -1 ? (cells[assigneeIdx] ?? '') : ''), // 担当者セル (フォローアップ 2026-07-13)
      escapeCsvCell(creatorIdx !== -1 ? (cells[creatorIdx] ?? '') : ''), // 起票者セル (フォローアップ 2026-07-14)
      escapeCsvCell(createdAtIdx !== -1 ? (cells[createdAtIdx] ?? '') : ''), // 起票日時セル (フォローアップ 2026-07-15 #3)
    ];
    // カンマ区切りで 1 行にして出力リストに追加する
    outLines.push(row.join(','));
  }
  // 改行で結合して完成した CSV テキストを返す
  return outLines.join('\n');
}

// マッピング後の CSV テキスト (固定列順) から先頭 5 件のプレビュー行を生成する純粋関数
// applyMapping の出力を前提とするため、列インデックスを固定で参照する
function buildPreview(mappedCsvText: string): PreviewRow[] {
  // 改行コード (CRLF / LF どちらにも対応) で行に分割し、空行を除外する
  const lines = mappedCsvText.split(/\r?\n/).filter((l) => l.trim() !== '');
  // ヘッダ含め 2 行以上なければプレビューなし
  if (lines.length < 2) return [];
  // データ行は先頭 5 件に絞る (プレビューなので多すぎない量に制限)
  const dataLines = lines.slice(1, 6);
  // 各データ行を PreviewRow 型にマッピングして返す
  return dataLines.map((line) => {
    // RFC 4180 パーサで各セルを取り出す
    const cells = parseCsvLine(line);
    // applyMapping が出力した列順: 件名[0], 内容[1], 期限日[2], 優先度[3], カテゴリ[4], 拠点[5],
    // 状況[6], 担当者[7], 起票者[8], 起票日時[9]
    return {
      件名: cells[0] ?? '', // 件名セル
      内容: cells[1] ?? '', // 内容セル
      期限日: cells[2] ?? '', // 期限日セル
      優先度: cells[3] ?? '', // 優先度セル
      カテゴリ: cells[4] ?? '', // カテゴリセル (フォローアップ 2026-07-11)
      拠点: cells[5] ?? '', // 拠点セル
      状況: cells[6] ?? '', // 状況セル (§3.1 フォローアップ)
      担当者: cells[7] ?? '', // 担当者セル (フォローアップ 2026-07-13)
      起票者: cells[8] ?? '', // 起票者セル (フォローアップ 2026-07-14)
      起票日時: cells[9] ?? '', // 起票日時セル (フォローアップ 2026-07-15 #3)
    };
  });
}

// CSV ヘッダ一覧から、システムフィールド名と一致する列を自動でマッピングする純粋関数
// 列名が完全一致するものだけ自動対応付けし、一致しないものは空文字 (未選択) にする
function buildAutoMapping(headers: string[]): ColumnMapping {
  // ヘッダ配列に指定した名前が含まれていれば採用し、なければ空文字を返すヘルパー
  const find = (name: string): string => (headers.includes(name) ? name : '');
  // 各システムフィールドについて自動マッピングを試みる
  return {
    件名: find('件名'), // 「件名」列が CSV にあれば自動対応
    内容: find('内容'), // 「内容」列が CSV にあれば自動対応
    期限日: find('期限日'), // 「期限日」列が CSV にあれば自動対応
    優先度: find('優先度'), // 「優先度」列が CSV にあれば自動対応
    カテゴリ: find('カテゴリ'), // 「カテゴリ」列が CSV にあれば自動対応 (フォローアップ 2026-07-11)
    拠点: find('拠点'), // 「拠点」列が CSV にあれば自動対応 (自社の CSV エクスポート結果をそのまま再取込しやすくする)
    状況: find('状況'), // 「状況」列が CSV にあれば自動対応 (§3.1 フォローアップ)
    担当者: find('担当者'), // 「担当者」列が CSV にあれば自動対応 (フォローアップ 2026-07-13)
    起票者: find('起票者'), // 「起票者」列が CSV にあれば自動対応 (自社の CSV エクスポート結果をそのまま再取込しやすくする。フォローアップ 2026-07-14)
    起票日時: find('起票日時'), // 「起票日時」列が CSV にあれば自動対応 (フォローアップ 2026-07-15 #3)
  };
}

// CSV インポートフォームコンポーネント (ウィザード形式)
// MVP では categories を使わないため _ プレフィックスで受け取り ESLint 警告を抑制する
export function CsvImportForm(_props: CsvImportFormProps) {
  // ウィザードの現在ステップ (初期は 'select')
  const [step, setStep] = useState<WizardStep>('select');
  // 読み込んだ生 CSV テキスト (null = 未選択)
  const [csvText, setCsvText] = useState<string | null>(null);
  // CSV から解析したヘッダ列名の配列 (マッピング設定ステップのドロップダウンに使う)
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  // 現在の列マッピング設定 (システムフィールド → CSV 列名)
  const [mapping, setMapping] = useState<ColumnMapping>({
    件名: '',
    内容: '',
    期限日: '',
    優先度: '',
    カテゴリ: '',
    拠点: '',
    状況: '',
    担当者: '',
    起票者: '',
    起票日時: '',
  });
  // マッピングを適用した変換後の CSV テキスト (サーバーアクションへ渡す)
  const [mappedCsvText, setMappedCsvText] = useState<string | null>(null);
  // プレビューテーブルに表示する先頭 5 行のデータ (マッピング後)
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  // インポート実行結果 (null = 未実行)
  const [result, setResult] = useState<ImportTicketsResult | null>(null);
  // サーバーアクションのエラーメッセージ (throw された場合)
  const [error, setError] = useState<string | null>(null);
  // useTransition でインポート中フラグを管理する (ボタン無効化・スピナー表示に使う)
  const [isPending, startTransition] = useTransition();

  // ファイル選択時のハンドラ: CSV を読み込んで自動マッピングを設定し列対応付けステップへ進む
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    // 選択されたファイルを取り出す (未選択なら undefined)
    const file = e.target.files?.[0];
    // ファイルが選択されていなければ全ステートをリセットして終了
    if (!file) {
      setCsvText(null); // 生 CSV テキストをクリア
      setCsvHeaders([]); // ヘッダ一覧をクリア
      setMapping({
        件名: '',
        内容: '',
        期限日: '',
        優先度: '',
        カテゴリ: '',
        拠点: '',
        状況: '',
        担当者: '',
        起票者: '',
        起票日時: '',
      }); // マッピングをクリア
      setMappedCsvText(null); // 変換後 CSV をクリア
      setPreview([]); // プレビューをクリア
      setResult(null); // 結果をクリア
      setError(null); // エラーをクリア
      setStep('select'); // 最初のステップに戻す
      return;
    }
    // ファイルサイズが上限を超える場合はエラーを表示して読み込みをスキップ (DoS 防止)
    if (file.size > MAX_CSV_BYTES) {
      // エラーを表示しつつ、以前のファイルに由来する状態をすべてリセットして不整合を防ぐ
      setCsvText(null); // 前回の生 CSV テキストをクリア
      setCsvHeaders([]); // 前回のヘッダ一覧をクリア
      setMapping({
        件名: '',
        内容: '',
        期限日: '',
        優先度: '',
        カテゴリ: '',
        拠点: '',
        状況: '',
        担当者: '',
        起票者: '',
        起票日時: '',
      }); // 前回のマッピングをクリア
      setMappedCsvText(null); // 前回の変換後 CSV をクリア
      setPreview([]); // 前回のプレビューをクリア
      setResult(null); // 前回の結果をクリア
      setStep('select'); // ファイル選択ステップへ戻す
      setError(`ファイルサイズが大きすぎます（上限 ${MAX_CSV_BYTES / 1024}KB）`); // エラー表示
      return;
    }
    // FileReader で CSV ファイルをテキストとして非同期読み込みする
    const reader = new FileReader();
    // 読み込み完了時のコールバック
    reader.onload = (ev) => {
      // 読み込んだテキストを文字列として取り出す
      const text = ev.target?.result;
      // 読み込み失敗時は何もしない
      if (typeof text !== 'string') return;
      // 前回の結果・エラーをクリアする (新しいファイルに切り替えたので)
      setResult(null);
      setError(null);
      // ヘッダ行を RFC 4180 パーサで解析して列名の配列を得る
      const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
      // ヘッダ行の解析を試みる (引用符が閉じられていない場合は例外が発生する)
      let parsedHeaders: string[] = [];
      try {
        parsedHeaders = parseCsvLine(firstLine); // RFC 4180 パーサで列名を取り出す
      } catch {
        // ヘッダが解析できない場合はエラーを表示して処理を中断する
        // setCsvText はここで呼ばない: 無効なファイルで csvText が上書きされると後続ステップで不整合が生じる
        setError('CSV のヘッダ行が正しくありません（引用符が閉じられていない可能性があります）');
        return;
      }
      // ヘッダ解析が成功してから生 CSV テキストをステートに保存する (順序が重要)
      setCsvText(text);
      // 解析したヘッダ列名をステートに保存する (マッピングフォームのドロップダウンに表示する)
      setCsvHeaders(parsedHeaders);
      // ヘッダ名からシステムフィールドへの自動マッピングを試みる
      const autoMapping = buildAutoMapping(parsedHeaders);
      // 自動マッピング結果をステートに反映する
      setMapping(autoMapping);
      // 列対応付けステップへ進む
      setStep('map');
    };
    // UTF-8 テキストとして読み込む
    reader.readAsText(file, 'UTF-8');
  }

  // マッピングフォームのドロップダウンが変更されたときのハンドラ (部分更新)
  function handleMappingChange(field: keyof ColumnMapping, value: string) {
    // 変更されたフィールドだけを更新し、他のフィールドは保持する
    setMapping((prev) => ({ ...prev, [field]: value }));
  }

  // 「内容を確認する」ボタンのハンドラ: マッピングを検証してプレビューを生成しインポート確認ステップへ進む
  function handleMappingConfirm() {
    // csvText が未設定の場合は何もしない (通常は発火しない)
    if (!csvText) return;
    // 件名列が未選択の場合はエラーを表示して中断する (件名は必須列)
    if (!mapping.件名) {
      setError('「件名」列の対応を設定してください（必須）'); // エラーメッセージを表示する
      return;
    }
    // エラーをクリアする
    setError(null);
    // マッピングを適用して変換後 CSV テキストを生成する
    const mapped = applyMapping(csvText, mapping);
    // 変換後 CSV テキストをステートに保存する (インポート実行時にサーバーアクションへ渡す)
    setMappedCsvText(mapped);
    // プレビューデータを生成してステートに保存する
    setPreview(buildPreview(mapped));
    // インポート確認ステップへ進む
    setStep('confirm');
  }

  // インポート実行ボタンのハンドラ
  function handleImport() {
    // マッピング後 CSV テキストが未設定の場合は何もしない (ボタンは disabled なので通常は発火しない)
    if (!mappedCsvText) return;
    // 前回の結果とエラーをクリアしてから実行する
    setResult(null);
    setError(null);
    // useTransition でバックグラウンド実行する (UI がフリーズしない)
    startTransition(async () => {
      try {
        // サーバーアクションへ変換後 CSV テキストを渡してインポートを実行する
        const res = await importTickets(mappedCsvText);
        // 成功 (部分成功含む) の場合は結果をステートに保存して表示する
        setResult(res);
      } catch (err) {
        // サーバーアクションが throw した場合はエラーメッセージをステートに保存して表示する
        setError(err instanceof Error ? err.message : 'インポートに失敗しました');
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* ウィザードのステップインジケーター: 現在・完了・未来で色分けする */}
      <ol
        className="flex items-center gap-0 text-xs font-medium text-slate-400"
        aria-label="インポートの手順"
      >
        {WIZARD_STEPS.map(({ key, label }, idx) => (
          <li key={key} className="flex items-center">
            {/* ステップ番号バッジ: 現在は teal、完了は淡い teal、未来は slate */}
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                step === key
                  ? 'bg-teal-700 text-white' // 現在のステップ
                  : STEP_INDEX[step] > idx
                    ? 'bg-teal-200 text-teal-800' // 完了済みのステップ
                    : 'bg-slate-200 text-slate-400' // 未到達のステップ
              }`}
              aria-current={step === key ? 'step' : undefined}
            >
              {idx + 1}
            </span>
            {/* ステップラベル: 現在ステップは強調表示する */}
            <span className={`ml-1.5 ${step === key ? 'font-semibold text-teal-700' : ''}`}>
              {label}
            </span>
            {/* ステップ間の区切り線 (最後のステップには不要) */}
            {idx < WIZARD_STEPS.length - 1 && <span className="mx-2 text-slate-300">›</span>}
          </li>
        ))}
      </ol>

      {/* ステップ 1: ファイル選択 */}
      {step === 'select' && (
        <div className="space-y-4">
          {/* CSV の形式ヒント: 列順を気にしなくてよいことを伝える */}
          <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200">
            {/* ヒントのタイトル */}
            <p className="mb-1 font-semibold text-slate-700">どんな CSV でも読み込めます</p>
            {/* 説明文 */}
            <p className="text-xs text-slate-500">
              Excel などの既存シートを CSV に保存したファイルを読み込めます。
              次のステップで「どの列が件名か」を指定できるので、列の順番・名前は問いません。
            </p>
            {/* 制限の説明 */}
            <p className="mt-1 text-xs text-slate-400">1 回のインポートは最大 200 行です。</p>
          </div>

          {/* ファイル選択入力 (CSV のみ許可) */}
          <div className="space-y-1">
            <label htmlFor="csvFile" className="block text-sm font-medium text-slate-700">
              CSV ファイルを選択
            </label>
            <input
              id="csvFile"
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-teal-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-teal-700 hover:file:bg-teal-100"
            />
          </div>

          {/* ファイルサイズエラー等 */}
          {error && (
            <p className="text-sm text-rose-700" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {/* ステップ 2: 列の対応付け (マッピング) */}
      {step === 'map' && (
        <div className="space-y-4">
          {/* 説明文: CSV の列とシステムフィールドを対応付けることを案内する */}
          <p className="text-sm text-slate-600">
            読み込んだ CSV の列と、HelpDesk Hub のフィールドの対応を設定してください。
          </p>

          {/* マッピングフォーム: 各システムフィールドに対応する CSV 列を選ぶ */}
          <div className="space-y-3 rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200">
            {SYSTEM_FIELDS.map(({ key, label, required }) => (
              /* 1 行分: フィールド名ラベル + CSV 列を選ぶドロップダウン */
              <div key={key} className="flex items-center gap-3">
                {/* フィールド名ラベル */}
                <label
                  htmlFor={`map-${key}`}
                  className="w-36 shrink-0 text-sm font-medium text-slate-700"
                >
                  {label}
                </label>
                {/* CSV 列を選ぶドロップダウン */}
                <select
                  id={`map-${key}`}
                  value={mapping[key]}
                  onChange={(e) => handleMappingChange(key, e.target.value)}
                  className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 shadow-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500"
                  aria-required={required}
                >
                  {/* 未選択オプション: 必須フィールドは「選択してください」、任意は「使わない」 */}
                  <option value="">{required ? '（選択してください）' : '使わない'}</option>
                  {/* CSV のヘッダ列を選択肢として列挙する (同名列が重複する場合も key が被らないようインデックスを使う) */}
                  {csvHeaders.map((h, hIdx) => (
                    <option key={`${hIdx}-${h}`} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* 入力値フォーマットのヒント: ユーザーが誤った形式でインポートしてサーバーエラーになるのを防ぐ */}
          <div className="space-y-0.5 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-100">
            <p className="font-semibold">入力値の形式について</p>
            {/* 期限日のフォーマット説明 */}
            <p>
              <span className="font-medium">期限日:</span> YYYY-MM-DD 形式（例:
              2026-03-31）で入力してください。
            </p>
            {/* 優先度の選択肢説明 */}
            <p>
              <span className="font-medium">優先度:</span> <code>高</code>・<code>中</code>・
              <code>低</code>
              のいずれかを入力してください。空欄の場合は「中」になります。
            </p>
            {/* カテゴリのフォーマット説明: 拠点と同じく、既存のカテゴリ名と完全一致させる必要がある
                (フォローアップ 2026-07-11) */}
            <p>
              <span className="font-medium">カテゴリ:</span>{' '}
              登録済みのカテゴリ名と完全に一致する文字列を入力してください。一致しない場合はエラーになります。
            </p>
            {/* 拠点のフォーマット説明: 事前に設定画面で登録した拠点名と完全一致させる必要がある */}
            <p>
              <span className="font-medium">拠点:</span>{' '}
              設定画面で登録済みの拠点名と完全に一致する文字列を入力してください。一致しない場合はエラーになります。
            </p>
            {/* 状況のフォーマット説明 (§3.1 フォローアップ): 既存 Excel の完了済み行をそのまま
                取り込めるようにする列。画面に表示されているのと同じ日本語表記が必要なので、
                Lite/Pro どちらの用語かは確認画面で実際の値を見て判断してもらう */}
            <p>
              <span className="font-medium">状況:</span> 画面に表示されている状況の日本語表記（例:
              「未対応」「対応中」「完了」）と完全に一致する文字列を入力してください。空欄の場合は既定の状況で取り込まれます。一致しない場合はエラーになります。
            </p>
            {/* 担当者のフォーマット説明: 拠点と同じく、既存の担当者名と完全一致させる必要がある
                (フォローアップ 2026-07-13) */}
            <p>
              <span className="font-medium">担当者:</span>{' '}
              登録済みの担当者（エージェント）の氏名と完全に一致する文字列を入力してください。空欄の場合は未アサインで取り込まれます。一致しない場合はエラーになります。
            </p>
            {/* 起票者のフォーマット説明: 拠点/担当者と同じく、既存のメンバー名と完全一致させる必要がある
                (フォローアップ 2026-07-14)。指定が無い場合の既定動作も明記し、意図しない付け替えを防ぐ */}
            <p>
              <span className="font-medium">起票者:</span>{' '}
              登録済みのメンバー（担当者または依頼者）の氏名と完全に一致する文字列を入力してください。空欄の場合はこのインポートを実行した担当者が起票者になります。一致しない場合はエラーになります。
            </p>
            {/* 起票日時のフォーマット説明: 期限日と同じく厳密な日時形式が必要
                (フォローアップ 2026-07-15 #3)。指定が無い場合の既定動作も明記する */}
            <p>
              <span className="font-medium">起票日時:</span> YYYY-MM-DD HH:mm:ss 形式（例:
              2026-03-31
              09:15:00、現在時刻より過去の日時）で入力してください。空欄の場合はこのインポートを実行した時刻になります。
            </p>
          </div>

          {/* 件名未選択時などのマッピングエラー */}
          {error && (
            <p className="text-sm text-rose-700" role="alert">
              {error}
            </p>
          )}

          {/* 操作ボタン: 戻る + 内容を確認する */}
          <div className="flex gap-3">
            {/* 前のステップに戻るボタン */}
            <button
              type="button"
              onClick={() => {
                setStep('select'); // ファイル選択ステップへ戻る
                setError(null); // エラーをクリアする
              }}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-100"
            >
              戻る
            </button>
            {/* マッピングを適用してプレビューステップへ進むボタン */}
            <button
              type="button"
              onClick={handleMappingConfirm}
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800"
            >
              内容を確認する
            </button>
          </div>
        </div>
      )}

      {/* ステップ 3: プレビュー確認 + インポート実行 */}
      {step === 'confirm' && (
        <div className="space-y-4">
          {/* プレビューテーブル: マッピング後のデータ先頭 5 件を表示する */}
          {preview.length > 0 && (
            <div className="overflow-x-auto">
              {/* プレビューの件数表示 */}
              <p className="mb-2 text-sm text-slate-500">プレビュー（先頭 {preview.length} 件）</p>
              <table className="min-w-full divide-y divide-slate-100 rounded-xl bg-white text-sm ring-1 ring-slate-100">
                <thead className="bg-slate-50">
                  <tr>
                    {/* ヘッダセル: 件名 */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      件名
                    </th>
                    {/* ヘッダセル: 内容 (省略表示) */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      内容
                    </th>
                    {/* ヘッダセル: 期限日 */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      期限日
                    </th>
                    {/* ヘッダセル: 優先度 */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      優先度
                    </th>
                    {/* ヘッダセル: カテゴリ (フォローアップ 2026-07-11) */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      カテゴリ
                    </th>
                    {/* ヘッダセル: 拠点 */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      拠点
                    </th>
                    {/* ヘッダセル: 状況 (§3.1 フォローアップ) */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      状況
                    </th>
                    {/* ヘッダセル: 担当者 (フォローアップ 2026-07-13) */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      担当者
                    </th>
                    {/* ヘッダセル: 起票者 (フォローアップ 2026-07-14) */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      起票者
                    </th>
                    {/* ヘッダセル: 起票日時 (フォローアップ 2026-07-15 #3) */}
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">
                      起票日時
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.map((row: PreviewRow, idx: number) => (
                    /* 各プレビュー行 (key に idx を使うのはエラー行との重複防止のため) */
                    <tr key={idx}>
                      {/* 件名セル */}
                      <td className="px-4 py-2 text-slate-800">{row.件名}</td>
                      {/* 内容セル: 長い場合は 20 文字で切り詰める */}
                      <td className="px-4 py-2 text-slate-500">
                        {row.内容.length > 20 ? `${row.内容.slice(0, 20)}…` : row.内容}
                      </td>
                      {/* 期限日セル: 未設定は「―」で表示する */}
                      <td className="px-4 py-2 text-slate-500">{row.期限日 || '―'}</td>
                      {/* 優先度セル: 未設定は「中」で表示する (サーバー側のデフォルトと合わせる) */}
                      <td className="px-4 py-2 text-slate-500">{row.優先度 || '中'}</td>
                      {/* カテゴリセル: 未設定は「―」で表示する (フォローアップ 2026-07-11) */}
                      <td className="px-4 py-2 text-slate-500">{row.カテゴリ || '―'}</td>
                      {/* 拠点セル: 未設定は「―」で表示する */}
                      <td className="px-4 py-2 text-slate-500">{row.拠点 || '―'}</td>
                      {/* 状況セル: 未設定は「―」で表示する (既定の状況が反映される。§3.1 フォローアップ) */}
                      <td className="px-4 py-2 text-slate-500">{row.状況 || '―'}</td>
                      {/* 担当者セル: 未設定は「―」で表示する (フォローアップ 2026-07-13) */}
                      <td className="px-4 py-2 text-slate-500">{row.担当者 || '―'}</td>
                      {/* 起票者セル: 未設定は「―」で表示する (インポート実行者が起票者になる。フォローアップ 2026-07-14) */}
                      <td className="px-4 py-2 text-slate-500">{row.起票者 || '―'}</td>
                      {/* 起票日時セル: 未設定は「―」で表示する (インポート実行時刻になる。フォローアップ 2026-07-15 #3) */}
                      <td className="px-4 py-2 text-slate-500">{row.起票日時 || '―'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* サーバーアクションのエラー表示 (色だけでなくテキストでも状態を伝える §7) */}
          {error && (
            <p className="text-sm text-rose-700" role="alert">
              {error}
            </p>
          )}

          {/* インポート結果表示 (成功件数 + エラー一覧) */}
          {result && (
            <div className="space-y-3" role="status" aria-live="polite">
              {/* 成功件数バナー */}
              <p className="text-sm font-medium text-teal-700">
                {result.imported} 件をインポートしました
                {/* エラーがある場合は合計エラー件数も表示する */}
                {result.errors.length > 0 && `（${result.errors.length} 件のエラーあり）`}
              </p>
              {/* エラー一覧 (エラーがある場合のみ表示) */}
              {result.errors.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-rose-50 p-4 ring-1 ring-rose-100">
                  {result.errors.map((e: { row: number; message: string }, idx: number) => (
                    /* エラー 1 件: 行番号 + エラーメッセージ
                       key に e.row を使うと同一行に複数エラー発生時に重複するため配列インデックスを使う */
                    <li key={idx} className="text-sm text-rose-700">
                      {/* 行番号を強調表示する */}
                      <span className="font-medium">{e.row} 行目:</span> {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 操作ボタン: 戻る + インポート実行 */}
          <div className="flex gap-3">
            {/* マッピング設定ステップへ戻るボタン (インポート実行中は無効) */}
            <button
              type="button"
              onClick={() => {
                setStep('map'); // マッピングステップへ戻る
                setResult(null); // 前回の結果をクリアする
                setError(null); // エラーをクリアする
              }}
              disabled={isPending}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              戻る
            </button>
            {/* インポート実行ボタン (変換後 CSV が未設定 or 実行中は無効) */}
            <button
              type="button"
              onClick={handleImport}
              disabled={!mappedCsvText || isPending}
              className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {/* 実行中はスピナーテキストを表示する */}
              {isPending ? 'インポート中…' : 'インポート'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

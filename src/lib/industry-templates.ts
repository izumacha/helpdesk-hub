/**
 * 業種テンプレート一覧 (Phase 3 業種テンプレ自動投入)
 *
 * 新規テナント作成時に業種を選ぶと、ここで定義したカテゴリが自動で初期投入される。
 * docs/smb-dx-pivot-plan.md §4 Phase 3「業種テンプレ」に対応。
 * カテゴリの追加・変更はこのファイルだけを編集すれば反映される (一元管理)。
 */

// 1 業種のテンプレートを表す型
export interface IndustryTemplate {
  id: string; // URL 安全な英数字 ID (DB / フォームの value として使う)
  label: string; // 画面に表示する日本語名
  categories: string[]; // 自動投入するカテゴリ名の一覧 (初期投入順)
}

// 全業種テンプレートの配列 (画面のドロップダウン選択肢と投入データの正本)
export const INDUSTRY_TEMPLATES: IndustryTemplate[] = [
  {
    // 製造業: ハード/ネットワーク/設備/勤怠給与ソフト/その他
    id: 'manufacturing',
    label: '製造業',
    categories: ['PC・ハードウェア', 'ネットワーク', '設備・機械', '勤怠・給与ソフト', 'その他'],
  },
  {
    // 飲食業: POS/厨房/衛生/シフト/その他
    id: 'food',
    label: '飲食業',
    categories: ['POS・レジ', '厨房設備', '衛生管理', 'シフト・勤怠', 'その他'],
  },
  {
    // 介護・医療: PC・タブレット/介護ソフト/設備/勤怠シフト/その他
    id: 'care',
    label: '介護・医療',
    categories: ['PC・タブレット', '介護ソフト', '設備・施設', '勤怠・シフト', 'その他'],
  },
  {
    // 不動産: PC・ハード/物件管理システム/契約書類/その他
    id: 'real-estate',
    label: '不動産',
    categories: ['PC・ハードウェア', '物件管理システム', '契約書類', 'その他'],
  },
  {
    // 士業: PC・ハード/会計税務ソフト/セキュリティ/その他
    id: 'professional',
    label: '士業（税理士・社労士等）',
    categories: ['PC・ハードウェア', '会計・税務ソフト', 'セキュリティ', 'その他'],
  },
  {
    // 卸売・小売: PC・ハード/在庫管理システム/ネットワーク/その他
    id: 'wholesale',
    label: '卸売・小売',
    categories: ['PC・ハードウェア', '在庫管理システム', 'ネットワーク', 'その他'],
  },
];

// ID でテンプレートを 1 件取得するヘルパー関数 (見つからなければ undefined を返す)
export function findIndustryTemplate(id: string): IndustryTemplate | undefined {
  // 配列を線形探索して id が一致するものを返す
  return INDUSTRY_TEMPLATES.find((t) => t.id === id);
}

// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// テスト対象: mode-aware の状態ラベル取得関数 (§3.1 フォローアップ: 逆写像とラベル一覧取得も対象)
import {
  getStatusLabel,
  getStatusLabelsForMode,
  resolveStatusFromLabel,
  LITE_STATUS_LABELS,
  STATUS_LABELS,
} from '../src/lib/constants';

// getStatusLabel の挙動を Pro / Lite 両モードで検証する
describe('getStatusLabel', () => {
  // Pro モードでは現行の STATUS_LABELS と完全一致を返すこと
  it('returns the Pro label for every TicketStatus when mode is pro', () => {
    // Pro モードで使うすべてのステータスを順に検証
    expect(getStatusLabel('New', 'pro')).toBe(STATUS_LABELS.New);
    expect(getStatusLabel('Open', 'pro')).toBe(STATUS_LABELS.Open);
    expect(getStatusLabel('WaitingForUser', 'pro')).toBe(STATUS_LABELS.WaitingForUser);
    expect(getStatusLabel('InProgress', 'pro')).toBe(STATUS_LABELS.InProgress);
    expect(getStatusLabel('Escalated', 'pro')).toBe(STATUS_LABELS.Escalated);
    expect(getStatusLabel('Resolved', 'pro')).toBe(STATUS_LABELS.Resolved);
    expect(getStatusLabel('Closed', 'pro')).toBe(STATUS_LABELS.Closed);
  });

  // Lite モードでは 3 ステータスに「未対応 / 対応中 / 完了」が返ること
  it('returns the Lite label for Lite statuses when mode is lite', () => {
    // Lite で扱う 3 値が pivot plan §3.1 の用語表どおりに返る
    expect(getStatusLabel('Open', 'lite')).toBe('未対応');
    expect(getStatusLabel('InProgress', 'lite')).toBe('対応中');
    expect(getStatusLabel('Closed', 'lite')).toBe('完了');
    // LITE_STATUS_LABELS 経由で見ても同じこと (DRY 担保)
    expect(getStatusLabel('Open', 'lite')).toBe(LITE_STATUS_LABELS.Open);
  });

  // Lite モードで非 Lite ステータスを渡すと Pro ラベルにフォールバックすること
  it('falls back to Pro label in lite mode for non-Lite statuses', () => {
    // テナント mode を Pro → Lite に切り替えた直後など、Lite 対象外データが残るケース
    // 画面が空にならず、技術用語であっても Pro ラベルを返して表示を守る
    expect(getStatusLabel('New', 'lite')).toBe(STATUS_LABELS.New);
    expect(getStatusLabel('WaitingForUser', 'lite')).toBe(STATUS_LABELS.WaitingForUser);
    expect(getStatusLabel('Escalated', 'lite')).toBe(STATUS_LABELS.Escalated);
    expect(getStatusLabel('Resolved', 'lite')).toBe(STATUS_LABELS.Resolved);
  });
});

// §3.1 フォローアップ (2026-07-10): resolveStatusFromLabel は getStatusLabel の逆写像。
// CSV インポートの「状況」列がテナントの現在モードのラベルから TicketStatus を逆引きするために使う。
describe('resolveStatusFromLabel', () => {
  // Lite モードでは Lite の 3 ラベルだけが解決できる
  it('resolves Lite labels to their TicketStatus in lite mode', () => {
    expect(resolveStatusFromLabel('未対応', 'lite')).toBe('Open');
    expect(resolveStatusFromLabel('対応中', 'lite')).toBe('InProgress');
    expect(resolveStatusFromLabel('完了', 'lite')).toBe('Closed');
  });

  // Lite モードで Pro 専用ラベルを渡しても解決しない (表示と入力の対称性を保つ)
  it('does not resolve Pro-only labels in lite mode', () => {
    expect(resolveStatusFromLabel('解決済み', 'lite')).toBeNull();
    expect(resolveStatusFromLabel('新規', 'lite')).toBeNull();
    expect(resolveStatusFromLabel('エスカレーション', 'lite')).toBeNull();
  });

  // Pro モードでは Pro の 7 ラベルすべてが解決できる
  it('resolves all Pro labels to their TicketStatus in pro mode', () => {
    expect(resolveStatusFromLabel('新規', 'pro')).toBe('New');
    expect(resolveStatusFromLabel('オープン', 'pro')).toBe('Open');
    expect(resolveStatusFromLabel('ユーザー待ち', 'pro')).toBe('WaitingForUser');
    expect(resolveStatusFromLabel('対応中', 'pro')).toBe('InProgress');
    expect(resolveStatusFromLabel('エスカレーション', 'pro')).toBe('Escalated');
    expect(resolveStatusFromLabel('解決済み', 'pro')).toBe('Resolved');
    expect(resolveStatusFromLabel('クローズ', 'pro')).toBe('Closed');
  });

  // 未知のラベル (タイポ等) は null を返す
  it('returns null for unknown labels', () => {
    expect(resolveStatusFromLabel('対応済', 'lite')).toBeNull();
    expect(resolveStatusFromLabel('', 'pro')).toBeNull();
  });
});

// §3.1 フォローアップ: getStatusLabelsForMode はエラーメッセージ用の有効ラベル一覧を返す
describe('getStatusLabelsForMode', () => {
  it('Lite モードでは Lite の3ラベルを返す', () => {
    expect(getStatusLabelsForMode('lite')).toEqual(['未対応', '対応中', '完了']);
  });

  it('Pro モードでは Pro の7ラベルを返す', () => {
    expect(getStatusLabelsForMode('pro')).toEqual(Object.values(STATUS_LABELS));
  });
});

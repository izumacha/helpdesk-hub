// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 遷移可否判定と遷移先一覧取得を提供するドメイン関数 (Pro / Lite 両方)
import {
  getAllowedLiteTransitions,
  getAllowedTransitions,
  getCompletionStatuses,
  isLiteStatus,
  isValidLiteTransition,
  isValidTransition,
} from '../src/domain/ticket-status';

// チケットステータスの遷移ルール (= 仕様の単一真実) を守れているかのテスト
describe('ticket status transition rules', () => {
  // InProgress から想定通りの遷移先が許可されること
  it('allows valid transitions from InProgress', () => {
    // InProgress から行ける状態の集合
    const allowed = getAllowedTransitions('InProgress');
    // 必須の遷移先が含まれていること
    expect(allowed).toContain('WaitingForUser');
    expect(allowed).toContain('Escalated');
    expect(allowed).toContain('Resolved');
    // 個別判定でも true を返すこと
    expect(isValidTransition('InProgress', 'Resolved')).toBe(true);
    expect(isValidTransition('InProgress', 'Escalated')).toBe(true);
  });

  // 解決済みから再オープン (Open) への巻き戻しが許可されること
  it('allows reopening from Resolved to Open', () => {
    expect(isValidTransition('Resolved', 'Open')).toBe(true);
  });

  // クローズ済みからの再オープンも許可されること
  it('allows reopening Closed ticket to Open', () => {
    expect(isValidTransition('Closed', 'Open')).toBe(true);
  });

  // 不正な遷移は false を返すこと
  it('rejects invalid transitions', () => {
    // クローズ済みから直接 InProgress には戻せない
    expect(isValidTransition('Closed', 'InProgress')).toBe(false);
    // Escalated から New に戻すのは不可
    expect(isValidTransition('Escalated', 'New')).toBe(false);
  });

  // Closed からの遷移先は Open のみであること
  it('returns empty array for Closed (except Open)', () => {
    const allowed = getAllowedTransitions('Closed');
    expect(allowed).toEqual(['Open']);
  });
});

// Lite モード (SMB 向け簡易モード) の 3 ステータス遷移ルール (Pivot plan §5.2)
describe('Lite ticket status transition rules', () => {
  // Open から InProgress / Closed への遷移は許可されること
  it('allows Open to transition to InProgress or Closed', () => {
    // Open から行ける状態の集合を取得
    const allowed = getAllowedLiteTransitions('Open');
    // 必須の遷移先 (InProgress / Closed) が含まれていること
    expect(allowed).toContain('InProgress');
    expect(allowed).toContain('Closed');
    // 個別判定も true を返すこと
    expect(isValidLiteTransition('Open', 'InProgress')).toBe(true);
    expect(isValidLiteTransition('Open', 'Closed')).toBe(true);
  });

  // 自己遷移 (Open → Open など) は不可であること
  it('rejects self-transitions in Lite mode', () => {
    // Open → Open はループに見えるので不可
    expect(isValidLiteTransition('Open', 'Open')).toBe(false);
    // InProgress → InProgress も同様に不可
    expect(isValidLiteTransition('InProgress', 'InProgress')).toBe(false);
    // Closed → Closed も不可 (再オープンしてから完了し直すルートを取る)
    expect(isValidLiteTransition('Closed', 'Closed')).toBe(false);
  });

  // InProgress からは Open に戻す or Closed へ完了の 2 経路が許可されること
  it('allows InProgress to transition back to Open or forward to Closed', () => {
    // 対応中→未対応に戻すケースと、対応中→完了で終わらせるケースを許可
    expect(isValidLiteTransition('InProgress', 'Open')).toBe(true);
    expect(isValidLiteTransition('InProgress', 'Closed')).toBe(true);
  });

  // Closed からの遷移先は Open (再オープン) のみであること
  it('returns only Open as transition target from Closed', () => {
    // Lite モードでも完了状態からは再オープンのみ許可 (Pro モードと整合)
    expect(getAllowedLiteTransitions('Closed')).toEqual(['Open']);
    expect(isValidLiteTransition('Closed', 'Open')).toBe(true);
  });

  // isLiteStatus が 3 値で true、Lite 対象外の Pro ステータスで false を返すこと
  it('isLiteStatus returns true only for Open / InProgress / Closed', () => {
    // Lite で扱う 3 値はすべて true
    expect(isLiteStatus('Open')).toBe(true);
    expect(isLiteStatus('InProgress')).toBe(true);
    expect(isLiteStatus('Closed')).toBe(true);
    // 残り 4 値 (Pro 専用) はすべて false
    expect(isLiteStatus('New')).toBe(false);
    expect(isLiteStatus('WaitingForUser')).toBe(false);
    expect(isLiteStatus('Escalated')).toBe(false);
    expect(isLiteStatus('Resolved')).toBe(false);
  });
});

// getAllowedTransitions(from, mode) の mode 引数 (Lite/Pro) 分岐テスト
describe('getAllowedTransitions with tenant mode', () => {
  // mode 省略時は従来どおり Pro 遷移表を返すこと (後方互換)
  it('defaults to Pro transitions when mode is omitted', () => {
    // mode 引数なしで呼ぶと従来の Pro 7 値遷移表が返る
    expect(getAllowedTransitions('Open')).toContain('Escalated');
    expect(getAllowedTransitions('Open')).toContain('WaitingForUser');
  });

  // mode='pro' を明示しても Pro 遷移表を返すこと
  it("returns Pro transitions when mode is 'pro'", () => {
    // Pro 指定時は Escalated/WaitingForUser など 7 値の遷移先が含まれる
    expect(getAllowedTransitions('Open', 'pro')).toContain('Escalated');
    expect(getAllowedTransitions('InProgress', 'pro')).toContain('WaitingForUser');
  });

  // mode='lite' かつ Lite 対応ステータスなら Lite 3 値遷移表を返すこと
  it("returns Lite transitions when mode is 'lite' and status is Lite-compatible", () => {
    // Open (未対応) からは InProgress / Closed のみ (Escalated は含まれない)
    expect(getAllowedTransitions('Open', 'lite')).toEqual(['InProgress', 'Closed']);
    // InProgress (対応中) からは Open / Closed のみ (Resolved/Escalated は含まれない)
    expect(getAllowedTransitions('InProgress', 'lite')).toEqual(['Open', 'Closed']);
    // Closed (完了) からは Open (再オープン) のみ
    expect(getAllowedTransitions('Closed', 'lite')).toEqual(['Open']);
  });

  // mode='lite' でも from が Lite 非対応 (旧データ) なら Pro 遷移表にフォールバックすること
  it("falls back to Pro transitions when mode is 'lite' but status is not in Lite set", () => {
    // 旧データの Escalated/Resolved/WaitingForUser/New 等は Pro 表を引いて経路を確保する
    expect(getAllowedTransitions('Escalated', 'lite')).toEqual(getAllowedTransitions('Escalated'));
    expect(getAllowedTransitions('Resolved', 'lite')).toEqual(getAllowedTransitions('Resolved'));
    expect(getAllowedTransitions('New', 'lite')).toEqual(getAllowedTransitions('New'));
  });
});

// isValidTransition(from, to, mode) の mode 引数 (Lite/Pro) 分岐テスト
describe('isValidTransition with tenant mode', () => {
  // Lite モード: InProgress → Open は Lite 表で許可されているので true
  it("allows InProgress → Open when mode is 'lite'", () => {
    expect(isValidTransition('InProgress', 'Open', 'lite')).toBe(true);
  });

  // Pro モード: InProgress → Open は Pro 表に Open が無いので false
  it("rejects InProgress → Open when mode is 'pro' (default)", () => {
    // mode='pro' を明示しても、省略しても結果は同じ (省略時は 'pro' がデフォルト)
    expect(isValidTransition('InProgress', 'Open', 'pro')).toBe(false);
    expect(isValidTransition('InProgress', 'Open')).toBe(false);
  });

  // Lite モード: Open → Escalated は Lite 表に Escalated が無いので false
  it("rejects Open → Escalated when mode is 'lite'", () => {
    expect(isValidTransition('Open', 'Escalated', 'lite')).toBe(false);
  });

  // Pro モード: Open → Escalated は Pro 表で許可されているので true
  it("allows Open → Escalated when mode is 'pro'", () => {
    expect(isValidTransition('Open', 'Escalated', 'pro')).toBe(true);
  });
});

// updateTicketStatus に組み込まれた Lite ターゲット制限ガードの根拠となるドメイン不変条件
// (Server Action 側で「Lite モードでは newStatus を必ず Lite 3 値に限定」する判定の前提)
describe('Lite mode target restriction invariants', () => {
  // 非 Lite ステータス (Resolved / Escalated / WaitingForUser / New) は isLiteStatus で false となり、
  // Lite テナント上で新規にこれらへ遷移する操作が Server Action のガードで弾かれることを保証する
  it('isLiteStatus rejects every non-Lite status (Lite テナント上で新規セット不可)', () => {
    // Pro 専用 4 値が全て false であることを 1 件ずつ確認 (どれか 1 つでも漏れると抜け穴になる)
    expect(isLiteStatus('Resolved')).toBe(false);
    expect(isLiteStatus('Escalated')).toBe(false);
    expect(isLiteStatus('WaitingForUser')).toBe(false);
    expect(isLiteStatus('New')).toBe(false);
  });

  // getAllowedLiteTransitions の戻り値は常に Lite 3 値の中に閉じていなければならない
  // (Server Action がこの結果を直接ガードに使うため、戻り値に非 Lite が混ざると Lite 制限が破綻する)
  it('getAllowedLiteTransitions returns only Lite statuses for every Lite from-state', () => {
    // Lite 3 値の各 from について、許可される to が全て isLiteStatus を満たすことを確認
    for (const from of ['Open', 'InProgress', 'Closed'] as const) {
      const targets = getAllowedLiteTransitions(from);
      for (const to of targets) {
        // 1 つでも非 Lite が混ざれば false で fail させる
        expect(isLiteStatus(to)).toBe(true);
      }
    }
  });
});

// getCompletionStatuses: update-ticket.ts の resolvedAt 判定と FAQ 候補化可否判定
// (§1.1 フォローアップ) が共有する「完了」の単一定義
describe('getCompletionStatuses', () => {
  // Pro は従来どおり Resolved のみを完了扱いとする
  it('Pro では Resolved のみを完了扱いとする', () => {
    expect(getCompletionStatuses('pro')).toEqual(['Resolved']);
  });

  // Lite は Closed (Lite の「完了」) と旧 Pro データの Resolved の両方を完了扱いとする
  it('Lite では Closed と旧データの Resolved を完了扱いとする', () => {
    expect(getCompletionStatuses('lite')).toEqual(['Closed', 'Resolved']);
  });
});

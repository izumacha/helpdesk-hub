// ドメイン層のユーザー型をインポート
import type { Role, User, UserSummary } from '@/domain/types';

// LINE ワンタイムコードによる紐付け試行の結果。
// - linked: 連携成功 (userId は連携されたメンバー)。同一ユーザーの再送 (冪等) もここに含む。
// - invalid: 一致するコードが無い / 失効済み (= そのテキストはコードではなかった)。
// - conflict: コードは有効だが、その LINE ユーザー ID が既に別メンバーへ連携済みで付け替えできない。
export type LineLinkResult =
  | { status: 'linked'; userId: string }
  | { status: 'invalid' }
  | { status: 'conflict' };

// ユーザー取得系リポジトリの契約 (port)
// 認証フローで使う findById / findByEmail は **tenantId スコープなし** (どのテナントに
// 属するかを判定するためにこそユーザーを引くので、ここで scope を強制すると鶏卵問題になる)。
// 一方、UI から候補を引く系のメソッドは全て tenantId 必須でクロステナント漏洩を防ぐ。
export interface UserRepository {
  findById(id: string): Promise<User | null>; // ID 指定で 1 件取得 (認証用、テナント横断)
  findByEmail(email: string): Promise<User | null>; // メール指定で 1 件取得 (ログイン用、テナント横断)
  // 新規ユーザーを 1 件作成する (招待受諾・テナント作成時の初代管理者登録で使う)。
  // tenantId は招待行 / 作成テナント由来のみを渡す契約 (リクエスト入力から注入しないこと)。
  // email は @unique 制約のため、重複時はアダプタが例外を投げる (呼び出し側で握って案内する)。
  create(input: {
    email: string; // ログイン用メール (小文字正規化済みであること)
    name: string; // 表示名
    passwordHash: string; // bcrypt 済みパスワードハッシュ (平文は渡さない)
    role: Role; // 付与する権限
    tenantId: string; // 所属テナント ID
  }): Promise<User>;
  /** Agents and admins in the given tenant. */
  listAgents(tenantId: string): Promise<UserSummary[]>; // 当該テナント内の agent/admin 一覧
  // 当該テナント内の全ユーザー (agent/admin/requester 問わず) の概要一覧。
  // フォローアップ (2026-07-14): CSV インポートの「起票者」列名解決用に追加。起票者はエージェントに
  // 限らず依頼者 (requester) もなり得るため、agent/admin だけを返す listAgents では解決できない。
  listByTenant(tenantId: string): Promise<UserSummary[]>;
  listAgentIds(tenantId: string): Promise<string[]>; // 当該テナント内の agent/admin の ID だけ
  findSummariesByIds(ids: string[], tenantId: string): Promise<UserSummary[]>; // テナント内 ID 配列から概要
  // エスカレーション一斉メール等、メール送信先として全エージェントの email が必要な場面向け。
  // listAgentIds + findById の N+1 を避けるため専用メソッドとして用意する。
  listAgentEmails(tenantId: string): Promise<Array<{ id: string; email: string }>>;
  // §7.2 Free trial 終了リマインダー等、課金関連の通知先として admin (agent は含まない) の
  // email のみが必要な場面向け。createCheckoutSession 等の課金 Server Action が admin 限定
  // なのと同じ理由で、課金の通知先も admin に限定する
  listAdminEmails(tenantId: string): Promise<Array<{ id: string; email: string }>>;
  // Phase 4 課金: テナント内のスタッフ (agent + admin) 数を返す (プランのシート上限チェック用)
  // requester はカウントしない — シートはヘルプデスクスタッフ分のみ消費する
  countByTenant(tenantId: string): Promise<number>;

  // ── LINE メンバー紐付け (Phase 2 β 解消) ───────────────────────────────
  // 紐付け済み LINE ユーザー ID から当該テナントのメンバーを 1 件引く (起票時に本人を起票者にするため)。
  // クロステナント漏洩防止のため tenantId スコープ必須。未連携・別テナントなら null。
  findByLineUserId(tenantId: string, lineUserId: string): Promise<User | null>;
  // メンバー起点でワンタイムコード (のハッシュ) と失効時刻を自分のユーザー行に保存する。
  // userId / tenantId はセッション由来のみを渡す契約 (他人のコードを書き換えさせない)。
  setLineLinkCode(
    userId: string,
    tenantId: string,
    input: { codeHash: string; expiresAt: Date },
  ): Promise<void>;
  // LINE Webhook 側で、受信コードのハッシュに一致する有効な発行行を探して lineUserId を紐付ける。
  // 原子的に「コード消費 + lineUserId 設定」を行い、二重処理・競合を防ぐ (Invitation.consumeValidToken 方式)。
  linkLineUserByCode(input: {
    codeHash: string; // 受信テキストを正規化してハッシュ化した値
    tenantId: string; // 取り込み先テナント (発行行と同一テナントのみ許可)
    lineUserId: string; // 紐付ける LINE ユーザー ID (Webhook イベント由来)
    now: Date; // 失効判定の基準時刻
  }): Promise<LineLinkResult>;
  // メンバー起点で LINE 連携を解除する (lineUserId と発行中コードをまとめてクリアする)。
  unlinkLineUser(userId: string, tenantId: string): Promise<void>;
}

// 'use server' アクションモジュールの公開面 (export) をリポジトリ全体で固定する回帰テスト。
//
// /security-review・/code-review ultra 指摘対応 (2026-07-19): Next.js は 'use server'
// ファイルの export をすべて「公開 Server Action エンドポイント」として登録する。過去に
// 認証チェックを持たない共有ヘルパー (issueInvitation) や読み取り専用ヘルパー
// (isInvitationAcceptable / isSignupAcceptable) が export されて意図しない公開エンドポイントに
// なっていたため、単一モジュールのスナップショットではなく src/features/**/actions/*.ts 全体を
// 静的に走査し、「意図した Server Action だけが export されている」ことを許可リストで検証する。
// 新しいアクションを追加したら、この許可リストに意図を持って追記すること。

// Node 標準のファイル走査・読み取り (テストは vitest の node 環境で動く)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 走査対象のルート (src/features 配下の actions ディレクトリのみが対象)
const FEATURES_ROOT = path.resolve(__dirname, '../../src/features');

// モジュールごとの「意図した公開 Server Action」の許可リスト (キーは src/features からの相対パス)。
// ここに無い runtime export が現れたらテストが落ちる = 公開エンドポイントの無断追加を検知する。
const ACTION_EXPORT_ALLOWLIST: Record<string, string[]> = {
  'auth/actions/accept-invitation.ts': ['acceptInvitation'],
  'auth/actions/complete-signup.ts': ['completeSignup'],
  'auth/actions/logout.ts': ['logout'],
  'auth/actions/request-magic-link.ts': ['requestMagicLink'],
  'auth/actions/request-signup.ts': ['requestSignup'],
  'faq/actions/faq-actions.ts': ['createFaqCandidate', 'updateFaqStatus', 'updateFaqContent'],
  'notifications/actions/notification-actions.ts': ['markAllRead'],
  'settings/actions/create-category.ts': ['createCategory'],
  'settings/actions/create-checkout-session.ts': ['createCheckoutSession'],
  'settings/actions/create-invitation.ts': ['createInvitation'],
  'settings/actions/create-invitations-bulk.ts': ['createInvitationsBulk'],
  'settings/actions/create-location.ts': ['createLocation'],
  'settings/actions/create-portal-session.ts': ['createPortalSession'],
  'settings/actions/create-tenant.ts': ['createTenant'],
  'settings/actions/delete-category.ts': ['deleteCategory'],
  'settings/actions/delete-line-config.ts': ['deleteLineConfig'],
  'settings/actions/delete-location.ts': ['deleteLocation'],
  'settings/actions/delete-sso-config.ts': ['deleteSsoConfig'],
  'settings/actions/link-line-account.ts': [
    'generateLineLinkCode_action',
    'unlinkLineAccount_action',
  ],
  'settings/actions/regenerate-inbound-token.ts': ['regenerateInboundToken'],
  'settings/actions/update-category.ts': ['updateCategory'],
  'settings/actions/update-line-config.ts': ['updateLineConfig'],
  'settings/actions/update-location.ts': ['updateLocation'],
  'settings/actions/update-notification-channels.ts': ['updateNotificationChannels'],
  'settings/actions/update-sso-config.ts': ['updateSsoConfig'],
  'settings/actions/update-tenant-mode.ts': ['updateTenantMode'],
  'tickets/actions/import-tickets.ts': ['importTickets'],
  'tickets/actions/update-ticket.ts': [
    'updateTicketStatus',
    'updateTicketPriority',
    'updateTicketAssignee',
    'updateTicketCategory',
    'updateTicketLocation',
    'escalateTicket',
  ],
};

// src/features 配下から actions ディレクトリ直下の .ts ファイルを再帰的に列挙する
function listActionFiles(): string[] {
  // recursive readdir で全ファイルの相対パスを取得する
  const entries = readdirSync(FEATURES_ROOT, { recursive: true }) as string[];
  // パス区切りを POSIX 形式へ正規化し、actions ディレクトリ直下の .ts のみに絞る
  return entries
    .map((p) => p.split(path.sep).join('/'))
    .filter((p) => /(^|\/)actions\/[^/]+\.ts$/.test(p))
    .sort();
}

// ファイル本文から「実行時に存在する export」の名前一覧を静的に抽出する。
// 型のみの export (export type / export interface) は実行時に消えるため対象外。
// それ以外の export 行は fail-closed で扱う: 意図された形 (export async function) だけを
// 名前として抽出し、未知の形 (export * / class / enum / const / 再 export / default 等) は
// すべて禁止マーカーとして記録し、許可リスト照合で必ず失敗させる
// (/code-review ultra 指摘対応 2026-07-19: 既知形の列挙だけだと export * 等が無音で通るため)。
function extractRuntimeExports(source: string): string[] {
  // 検出した実行時 export 名 (または禁止形マーカー) を貯める配列
  const names: string[] = [];
  // 行頭の export で始まる行をすべて走査する (このリポジトリの整形規則では export は行頭に置かれる)
  for (const m of source.matchAll(/^export\s.*$/gm)) {
    // export 行の全文 (末尾空白は落とす)
    const line = m[0].trimEnd();
    // 型のみの export は実行時に消えるためスキップする
    if (/^export\s+(type|interface|declare)\b/.test(line)) {
      continue;
    }
    // 意図された唯一の形: 行頭の export async function 宣言 (generator の * は含まない)
    const action = /^export\s+async\s+function\s+(\w+)\s*\(/.exec(line);
    // async function なら関数名を記録する
    if (action) {
      names.push(action[1]);
      continue;
    }
    // それ以外の実行時 export (export * / class / enum / const / let / var / default /
    // export { ... } / async function* 等) はエンドポイントとして意図されないため、
    // 行そのものを禁止マーカーとして記録し、許可リストと一致せず必ず失敗させる
    names.push(`[forbidden-form] ${line}`);
  }
  // 抽出結果を返す
  return names;
}

describe('Server Action モジュールの公開面 (export surface)', () => {
  // 走査対象を一度だけ列挙する
  const files = listActionFiles();

  it('actions ディレクトリのモジュールがすべて許可リストに登録されている', () => {
    // 実ファイル一覧と許可リストのキー一覧が一致すること (新規アクション追加時は許可リストも更新する)
    expect(files).toEqual(Object.keys(ACTION_EXPORT_ALLOWLIST).sort());
  });

  // モジュールごとに「先頭 'use server' + 許可された async 関数のみ export」を検証する
  it.each(files)('%s は許可された Server Action だけを export する', (relPath) => {
    // 対象ファイルの本文を読み込む
    const source = readFileSync(path.join(FEATURES_ROOT, relPath), 'utf8');
    // 'use server' ディレクティブがファイル先頭にあること (アクションモジュールの前提)
    expect(source.startsWith("'use server';")).toBe(true);
    // 実行時 export の一覧を抽出し、許可リストと完全一致することを確認する。
    // 許可リスト外の export (認証なしヘルパー・定数・再 export 等) が増えると
    // 公開 Server Action エンドポイントが無断で増えるため、ここで検知して失敗させる
    expect(extractRuntimeExports(source).sort()).toEqual(
      [...(ACTION_EXPORT_ALLOWLIST[relPath] ?? [])].sort(),
    );
  });
});

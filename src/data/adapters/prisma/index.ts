// Prisma クライアント型 (トランザクション分離レベルの定数値は実行時に使うため型 import にしない)
import { Prisma, type PrismaClient } from '@/generated/prisma';
import type { Repos, UnitOfWork } from '@/data/ports/unit-of-work';
// 各エンティティ用の Prisma リポジトリ生成関数を取り込む
import { makeAttachmentRepo } from './attachment-repository.prisma';
import { makeCategoryRepo } from './category-repository.prisma';
import { makeEmailThreadRepo } from './email-thread-repository.prisma';
import { makeFaqRepo } from './faq-repository.prisma';
import { makeInvitationRepo } from './invitation-repository.prisma';
import { makeLineConfigRepo } from './line-config-repository.prisma';
import { makeLineLinkCodeRepo } from './line-link-code-repository.prisma';
import { makeLineMessageRepo } from './line-message-repository.prisma';
import { makeLocationRepo } from './location-repository.prisma';
import { makeMagicLinkRepo } from './magic-link-repository.prisma';
import { makeNotificationRepo } from './notification-repository.prisma';
import { makeQuarantinedEmailRepo } from './quarantined-email-repository.prisma';
import { makeSettingsAuditLogRepo } from './settings-audit-log-repository.prisma';
import { makeSsoConfigRepo } from './sso-config-repository.prisma';
import { makeTenantRepo } from './tenant-repository.prisma';
import { makeTicketCommentRepo } from './ticket-comment-repository.prisma';
import { makeTicketHistoryRepo } from './ticket-history-repository.prisma';
import { makeTicketRepo } from './ticket-repository.prisma';
import { makeUserRepo } from './user-repository.prisma';
// Prisma クライアント/トランザクション共通型
import type { PrismaLike } from './types';

// 共通型を外部にも再公開 (別のモジュールから使うため)
export type { PrismaLike } from './types';

// 指定 Prisma クライアント (または tx) で動く全リポジトリを組み立てて返す関数
export function buildPrismaRepos(db: PrismaLike): Repos {
  // 各ポートに対応する Prisma 実装を組み立てる
  return {
    tickets: makeTicketRepo(db),
    users: makeUserRepo(db),
    notifications: makeNotificationRepo(db),
    faq: makeFaqRepo(db),
    history: makeTicketHistoryRepo(db),
    comments: makeTicketCommentRepo(db),
    categories: makeCategoryRepo(db),
    tenants: makeTenantRepo(db),
    magicLinks: makeMagicLinkRepo(db),
    invitations: makeInvitationRepo(db),
    attachments: makeAttachmentRepo(db),
    emailThreads: makeEmailThreadRepo(db),
    lineMessages: makeLineMessageRepo(db), // LINE 取り込みの冪等化 (Phase 2)
    lineLinkCodes: makeLineLinkCodeRepo(db), // LINE 連携コード処理の冪等化 (Phase 2.1 フォローアップ)
    locations: makeLocationRepo(db), // Phase 4 多拠点
    ssoConfigs: makeSsoConfigRepo(db), // Phase 4 Enterprise: SAML SSO 設定
    lineConfigs: makeLineConfigRepo(db), // Phase 2 フォローアップ: テナント単位の LINE 連携設定
    settingsAudit: makeSettingsAuditLogRepo(db), // §4.2 フォローアップ: 設定変更監査ログ
    quarantinedEmails: makeQuarantinedEmailRepo(db), // §3.2 フォローアップ: 隔離した受信メールの記録
  };
}

// Serializable 分離レベルで書き込み競合を検知したときに Prisma が投げるエラーコード。
// ("Transaction failed due to a write conflict or a deadlock. Please retry your transaction.")
const SERIALIZATION_FAILURE_CODE = 'P2034';

// Prisma の $transaction を用いた UnitOfWork 実装を生成する関数
export function buildPrismaUow(client: PrismaClient): UnitOfWork {
  return {
    // run に渡した関数をトランザクション内で実行する
    async run(fn, options) {
      // Prisma のトランザクションを開始し、tx クライアント用の Repos を渡して実行。
      // isolationLevel は options で明示されたときだけ指定し、それ以外は DB の既定に委ねる
      return client.$transaction(async (tx) => fn(buildPrismaRepos(tx)), {
        isolationLevel:
          options?.isolationLevel === 'Serializable'
            ? Prisma.TransactionIsolationLevel.Serializable
            : undefined,
      });
    },
    // Prisma 固有のエラーコードで書き込み競合を判定する (呼び出し側に Prisma の型を持ち込ませない)
    isTransactionConflict(err) {
      return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === SERIALIZATION_FAILURE_CODE
      );
    },
  };
}

// Prisma の生成クライアントと Role 列挙型 (役割) を取り込む
import { PrismaClient, Role } from '../src/generated/prisma';
// パスワードをハッシュ化するためのライブラリ (平文で DB に保存しないため)
import { hash } from 'bcryptjs';

// DB へ接続するクライアントのインスタンスを作成
const prisma = new PrismaClient();

// 投入するチケット用カテゴリの一覧 (画面の選択肢になる)
const CATEGORIES = [
  'ネットワーク・接続',
  'ハードウェア',
  'ソフトウェア・アプリ',
  'アカウント・認証',
  'セキュリティ',
  'その他',
];

// シード処理本体 (上から順に DB に書き込む)
async function main() {
  // 全ユーザー共通のパスワード "password123" をハッシュ化
  const password = await hash('password123', 12);

  // ── Users ────────────────────────────────────────────
  // 依頼者ユーザー1: メールが一致すれば何もせず、無ければ新規作成 (upsert)
  const requester1 = await prisma.user.upsert({
    where: { email: 'requester1@example.com' },
    update: {},
    create: { email: 'requester1@example.com', name: '田中 花子', passwordHash: password, role: Role.requester },
  });
  // 依頼者ユーザー2
  const requester2 = await prisma.user.upsert({
    where: { email: 'requester2@example.com' },
    update: {},
    create: { email: 'requester2@example.com', name: '鈴木 一郎', passwordHash: password, role: Role.requester },
  });
  // 依頼者ユーザー3
  const requester3 = await prisma.user.upsert({
    where: { email: 'requester3@example.com' },
    update: {},
    create: { email: 'requester3@example.com', name: '伊藤 直子', passwordHash: password, role: Role.requester },
  });
  // エージェント1 (ヘルプデスク担当者)
  const agent1 = await prisma.user.upsert({
    where: { email: 'agent1@example.com' },
    update: {},
    create: { email: 'agent1@example.com', name: '佐藤 健太', passwordHash: password, role: Role.agent },
  });
  // エージェント2
  const agent2 = await prisma.user.upsert({
    where: { email: 'agent2@example.com' },
    update: {},
    create: { email: 'agent2@example.com', name: '山田 美咲', passwordHash: password, role: Role.agent },
  });
  // エージェント3
  const agent3 = await prisma.user.upsert({
    where: { email: 'agent3@example.com' },
    update: {},
    create: { email: 'agent3@example.com', name: '中村 大輔', passwordHash: password, role: Role.agent },
  });
  // 管理者ユーザー (admin ロール)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: { email: 'admin@example.com', name: '管理者', passwordHash: password, role: Role.admin },
  });

  // 進捗ログ
  console.log('✅ Users seeded');

  // ── Categories ───────────────────────────────────────
  // カテゴリを名前 → レコードで引けるよう Map 風オブジェクトを用意
  const cats: Record<string, { id: string }> = {};
  // 定義済みカテゴリ名を順番に upsert (重複作成を防ぐ)
  for (const name of CATEGORIES) {
    cats[name] = await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log('✅ Categories seeded');

  // 現在時刻と相対日付ヘルパー (期限/解決日時の計算用)
  const now = new Date();
  // 24 時間前
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // 3 日前
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  // 2 日後
  const twoDaysLater = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  // 10 時間後
  const tenHoursLater = new Date(now.getTime() + 10 * 60 * 60 * 1000);

  // ── Tickets ──────────────────────────────────────────
  // 投入するチケットの定義一覧 (status / priority / 担当者などをバリエーション付きで用意)
  const ticketDefs = [
    {
      id: 'seed-t-01',
      title: 'VPN に接続できない',
      body: '昨日からVPNへの接続がタイムアウトします。社内ネットワークへのアクセスが必要です。',
      status: 'New' as const,
      priority: 'High' as const,
      creatorId: requester1.id,
      categoryId: cats['ネットワーク・接続'].id,
    },
    {
      id: 'seed-t-02',
      title: 'パスワードを忘れてしまいました',
      body: 'メールにリセットリンクが届きません。急ぎで対応をお願いします。',
      status: 'Open' as const,
      priority: 'Medium' as const,
      creatorId: requester2.id,
      assigneeId: agent1.id,
      categoryId: cats['アカウント・認証'].id,
    },
    {
      id: 'seed-t-03',
      title: 'プリンターが認識されない',
      body: '共有プリンターに印刷しようとすると「プリンターが見つかりません」と表示されます。',
      status: 'Resolved' as const,
      priority: 'Low' as const,
      creatorId: requester1.id,
      assigneeId: agent1.id,
      categoryId: cats['ハードウェア'].id,
      resolvedAt: yesterday,
    },
    {
      id: 'seed-t-04',
      title: 'Slack の通知が来ない',
      body: 'PCを再起動してから Slack のプッシュ通知が届かなくなりました。',
      status: 'InProgress' as const,
      priority: 'Medium' as const,
      creatorId: requester3.id,
      assigneeId: agent2.id,
      categoryId: cats['ソフトウェア・アプリ'].id,
      resolutionDueAt: twoDaysLater,
    },
    {
      id: 'seed-t-05',
      title: '不審なメールが届いた',
      body: '添付ファイル付きの不審なメールが届きました。開いてしまいましたが問題ないでしょうか？',
      status: 'Escalated' as const,
      priority: 'High' as const,
      creatorId: requester2.id,
      assigneeId: agent3.id,
      categoryId: cats['セキュリティ'].id,
      escalatedAt: yesterday,
      escalationReason: 'セキュリティインシデントの可能性があるため二次対応へ',
      resolutionDueAt: yesterday,
    },
    {
      id: 'seed-t-06',
      title: 'ファイルサーバーにアクセスできない',
      body: '今朝から社内ファイルサーバーへの接続が拒否されます。',
      status: 'WaitingForUser' as const,
      priority: 'High' as const,
      creatorId: requester1.id,
      assigneeId: agent1.id,
      categoryId: cats['ネットワーク・接続'].id,
      resolutionDueAt: tenHoursLater,
    },
    {
      id: 'seed-t-07',
      title: 'Excel が起動しない',
      body: 'Windows Update 後から Excel が起動しません。エラーコード 0x80004005 が表示されます。',
      status: 'New' as const,
      priority: 'Medium' as const,
      creatorId: requester3.id,
      categoryId: cats['ソフトウェア・アプリ'].id,
    },
    {
      id: 'seed-t-08',
      title: 'ノートPCのバッテリーが急速に減る',
      body: '先週から充電が 2 時間しか持たなくなりました。',
      status: 'Resolved' as const,
      priority: 'Low' as const,
      creatorId: requester2.id,
      assigneeId: agent2.id,
      categoryId: cats['ハードウェア'].id,
      resolvedAt: threeDaysAgo,
    },
    {
      id: 'seed-t-09',
      title: '二要素認証が設定できない',
      body: '認証アプリのQRコードをスキャンしてもコードが生成されません。',
      status: 'Open' as const,
      priority: 'Medium' as const,
      creatorId: requester1.id,
      assigneeId: agent3.id,
      categoryId: cats['アカウント・認証'].id,
      resolutionDueAt: twoDaysLater,
    },
    {
      id: 'seed-t-10',
      title: 'リモートデスクトップが接続できない',
      body: 'VPN 経由でリモートデスクトップ接続しようとすると認証エラーになります。',
      status: 'Closed' as const,
      priority: 'Medium' as const,
      creatorId: requester3.id,
      assigneeId: agent1.id,
      categoryId: cats['ネットワーク・接続'].id,
      resolvedAt: threeDaysAgo,
    },
  ];

  // 各定義をチケットテーブルへ upsert (再実行しても重複しない)
  for (const def of ticketDefs) {
    await prisma.ticket.upsert({
      where: { id: def.id },
      update: {},
      create: def,
    });
  }

  console.log('✅ Tickets seeded');

  // ── Comments ─────────────────────────────────────────
  // 各チケットに紐づくコメントの定義 (やり取りの履歴を再現)
  const commentDefs = [
    { ticketId: 'seed-t-02', authorId: agent1.id, body: '確認します。メールアドレスを教えてください。' },
    { ticketId: 'seed-t-02', authorId: requester2.id, body: 'suzuki@example.com です。よろしくお願いします。' },
    { ticketId: 'seed-t-03', authorId: agent1.id, body: 'ドライバを再インストールしたところ認識されました。' },
    { ticketId: 'seed-t-05', authorId: agent3.id, body: '添付ファイルをスキャンしました。マルウェアは検出されませんでしたが念のためパスワードの変更を推奨します。' },
    { ticketId: 'seed-t-06', authorId: agent1.id, body: 'アクセス権限の設定を確認します。マシン名を教えてください。' },
    { ticketId: 'seed-t-06', authorId: requester1.id, body: 'PC-TANAKA-001 です。' },
  ];

  // ticketId/authorId/body の組が無ければ新規作成 (重複登録を避ける)
  for (const c of commentDefs) {
    const exists = await prisma.ticketComment.findFirst({
      where: { ticketId: c.ticketId, authorId: c.authorId, body: c.body },
    });
    if (!exists) await prisma.ticketComment.create({ data: c });
  }

  console.log('✅ Comments seeded');

  // ── Histories ─────────────────────────────────────────
  // 変更履歴 (担当変更・ステータス変更・エスカレーション) の定義
  const historyDefs = [
    { ticketId: 'seed-t-02', changedById: admin.id, field: 'assignee' as const, oldValue: null, newValue: agent1.name },
    { ticketId: 'seed-t-03', changedById: agent1.id, field: 'status' as const, oldValue: 'Open', newValue: 'Resolved' },
    { ticketId: 'seed-t-05', changedById: agent3.id, field: 'escalation' as const, oldValue: 'InProgress', newValue: 'Escalated' },
    { ticketId: 'seed-t-09', changedById: admin.id, field: 'assignee' as const, oldValue: null, newValue: agent3.name },
  ];

  // 同一の (ticketId, changedById, field) があれば追加しない
  for (const h of historyDefs) {
    const exists = await prisma.ticketHistory.findFirst({
      where: { ticketId: h.ticketId, changedById: h.changedById, field: h.field },
    });
    if (!exists) await prisma.ticketHistory.create({ data: h });
  }

  console.log('✅ Histories seeded');

  // ── FAQ Candidate ────────────────────────────────────
  // seed-t-03 の FAQ 候補 (公開済み) が無ければ作る
  const faqExists = await prisma.faqCandidate.findFirst({ where: { ticketId: 'seed-t-03' } });
  if (!faqExists) {
    await prisma.faqCandidate.create({
      data: {
        ticketId: 'seed-t-03',
        createdById: agent1.id,
        question: '共有プリンターで「プリンターが見つかりません」と表示される',
        answer: 'プリンタードライバを削除し、最新のドライバを再インストールすることで解決します。[コントロールパネル] → [デバイスとプリンター] → 対象プリンターを右クリックして削除後、再度追加してください。',
        status: 'Published',
      },
    });
  }

  // seed-t-08 の FAQ 候補 (未公開、Candidate ステータス)
  const faqExists2 = await prisma.faqCandidate.findFirst({ where: { ticketId: 'seed-t-08' } });
  if (!faqExists2) {
    await prisma.faqCandidate.create({
      data: {
        ticketId: 'seed-t-08',
        createdById: agent2.id,
        question: 'ノートPCのバッテリーの持ちが急に悪くなった',
        answer: 'バッテリーのキャリブレーションを実施してください。完全放電後に満充電することで正確な残量表示が回復します。改善しない場合はバッテリー交換が必要です。',
        status: 'Candidate',
      },
    });
  }

  // 完了メッセージとログイン用情報の表示
  console.log('✅ FAQ candidates seeded');
  console.log('\nSeed completed!\nDefault password: password123');
  console.log('Users:', [
    'requester1@example.com', 'requester2@example.com', 'requester3@example.com',
    'agent1@example.com', 'agent2@example.com', 'agent3@example.com',
    'admin@example.com',
  ].join(', '));
}

// メイン処理を実行: 失敗したら終了コード 1、最後に必ず DB 接続を閉じる
main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

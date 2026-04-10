import { PrismaClient, Role } from '../src/generated/prisma';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

const CATEGORIES = [
  'ネットワーク・接続',
  'ハードウェア',
  'ソフトウェア・アプリ',
  'アカウント・認証',
  'セキュリティ',
  'その他',
];

async function main() {
  const password = await hash('password123', 12);

  // ── Users ────────────────────────────────────────────
  const requester1 = await prisma.user.upsert({
    where: { email: 'requester1@example.com' },
    update: {},
    create: {
      email: 'requester1@example.com',
      name: '田中 花子',
      passwordHash: password,
      role: Role.requester,
    },
  });

  const requester2 = await prisma.user.upsert({
    where: { email: 'requester2@example.com' },
    update: {},
    create: {
      email: 'requester2@example.com',
      name: '鈴木 一郎',
      passwordHash: password,
      role: Role.requester,
    },
  });

  const agent1 = await prisma.user.upsert({
    where: { email: 'agent1@example.com' },
    update: {},
    create: {
      email: 'agent1@example.com',
      name: '佐藤 健太',
      passwordHash: password,
      role: Role.agent,
    },
  });

  await prisma.user.upsert({
    where: { email: 'agent2@example.com' },
    update: {},
    create: {
      email: 'agent2@example.com',
      name: '山田 美咲',
      passwordHash: password,
      role: Role.agent,
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: '管理者',
      passwordHash: password,
      role: Role.admin,
    },
  });

  console.log('✅ Users seeded');

  // ── Categories ───────────────────────────────────────
  const categories: Record<string, { id: string }> = {};
  for (const name of CATEGORIES) {
    const cat = await prisma.category.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    categories[name] = cat;
  }

  console.log('✅ Categories seeded');

  // ── Sample tickets ───────────────────────────────────
  await prisma.ticket.createMany({
    skipDuplicates: true,
    data: [
      {
        id: 'seed-ticket-1',
        title: 'VPN に接続できない',
        body: '昨日からVPNへの接続がタイムアウトします。社内ネットワークへのアクセスが必要です。',
        status: 'New',
        priority: 'High',
        creatorId: requester1.id,
        categoryId: categories['ネットワーク・接続'].id,
      },
      {
        id: 'seed-ticket-2',
        title: 'パスワードを忘れてしまいました',
        body: 'メールにリセットリンクが届きません。急ぎで対応をお願いします。',
        status: 'Open',
        priority: 'Medium',
        creatorId: requester2.id,
        assigneeId: agent1.id,
        categoryId: categories['アカウント・認証'].id,
      },
      {
        id: 'seed-ticket-3',
        title: 'プリンターが認識されない',
        body: '共有プリンターに印刷しようとすると「プリンターが見つかりません」と表示されます。',
        status: 'Resolved',
        priority: 'Low',
        creatorId: requester1.id,
        assigneeId: agent1.id,
        categoryId: categories['ハードウェア'].id,
      },
    ],
  });

  console.log('✅ Sample tickets seeded');
  console.log('\nSeed completed! Default password: password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

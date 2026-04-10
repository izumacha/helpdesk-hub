import { PrismaClient, Role } from '../src/generated/prisma';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const password = await hash('password123', 12);

  // requester users
  await prisma.user.upsert({
    where: { email: 'requester1@example.com' },
    update: {},
    create: {
      email: 'requester1@example.com',
      name: '田中 花子',
      passwordHash: password,
      role: Role.requester,
    },
  });

  await prisma.user.upsert({
    where: { email: 'requester2@example.com' },
    update: {},
    create: {
      email: 'requester2@example.com',
      name: '鈴木 一郎',
      passwordHash: password,
      role: Role.requester,
    },
  });

  // agent users
  await prisma.user.upsert({
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

  // admin user
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

  console.log('✅ Seed completed');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

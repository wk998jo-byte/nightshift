import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: npx tsx scripts/set-admin-password.ts <new-password>');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.update({
    where: { username: 'admin' },
    data: { passwordHash },
  });
  console.log('Admin password updated successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

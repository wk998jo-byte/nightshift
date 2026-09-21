import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const updated = await prisma.project.updateMany({
    where: { code: 'BQ-DHA' },
    data: {
      name: 'Bin Quraya Company Limited Headquarters',
      locationLabel: 'Bin Quraya HQ, Dhahran',
      latitude: 26.3252708,
      longitude: 50.0743019,
      radiusMeters: 200,
    },
  });
  const p = await prisma.project.findFirst({ where: { code: 'BQ-DHA' } });
  console.log('updated', updated.count);
  console.log(p);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

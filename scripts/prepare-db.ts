import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

function loadEnvFile(file: string) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile('.env');
loadEnvFile('.env.local');

function run(cmd: string) {
  console.log('>', cmd);
  execSync(cmd, { stdio: 'inherit', env: process.env });
}

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error(
      'DATABASE_URL is not set. PostgreSQL is required. Copy .env.example and set DATABASE_URL to a postgresql:// connection string.'
    );
    process.exit(1);
  }

  if (!process.env.AUTH_SECRET?.trim() || !process.env.QR_SECRET?.trim()) {
    console.error(
      'AUTH_SECRET and QR_SECRET must be set in .env or .env.local. Copy .env.example and replace the placeholder values.'
    );
    process.exit(1);
  }

  run('npx prisma generate');
  run('npx prisma migrate deploy');

  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    console.log('Production environment detected — demo seed skipped.');
    console.log('Bootstrap production data separately with: npm run bootstrap:production');
  } else {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const count = await prisma.user.count();
      if (count === 0) {
        run('npx tsx prisma/seed.ts');
      } else {
        console.log(`Database already has ${count} users — seed skipped.`);
      }
    } finally {
      await prisma.$disconnect();
    }
  }

  if (!existsSync('public/bin-quraya-logo-clear.png') && existsSync('public/bin-quraya-logo.png')) {
    console.log('Note: clear logo missing; UI falls back if needed.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

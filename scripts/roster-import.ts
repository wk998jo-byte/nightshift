import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../src/lib/db';
import { writeAudit } from '../src/lib/auth';
import { applyOfficialRoster, planOfficialRoster, summarizePlan } from '../src/lib/roster-import';
import { OFFICIAL_ROSTER_FILE } from '../src/lib/roster-official';

function arg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--') ? process.argv[idx + 1] : '';
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const apply = has('--apply');
  const dryRun = has('--dry-run') || !apply;
  const fileArg = arg('--file') || OFFICIAL_ROSTER_FILE;
  const filePath = resolve(process.cwd(), fileArg);
  const csvText = readFileSync(filePath, 'utf8');

  if (dryRun && !apply) {
    const plan = await planOfficialRoster(prisma, csvText);
    console.log(JSON.stringify({ mode: 'dry-run', ...summarizePlan(plan) }, null, 2));
    if (!plan.ok) process.exitCode = 1;
    return;
  }

  const plan = await applyOfficialRoster(prisma, csvText, async (row) => {
    await writeAudit({
      action: row.action,
      entityType: row.entityType,
      newValue: row.newValue,
    });
  });
  console.log(JSON.stringify({ mode: 'apply', ...summarizePlan(plan) }, null, 2));
  if (!plan.ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

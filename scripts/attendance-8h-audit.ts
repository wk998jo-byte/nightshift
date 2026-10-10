import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import { isDemoEmployeeCode, isDemoEmployeeName } from '../src/lib/demo-employee';
import { calendarDateInAppZone } from '../src/lib/timezone';
import {
  formatAttendance8hAuditReport,
  summarizeAttendance8hAudit,
  type CompletedAttendanceAuditRow,
} from '../src/lib/attendance-8h-audit';
import type { DayExceptionRecord } from '../src/lib/day-status';

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

function databaseUrlLooksPostgres(url: string): boolean {
  return /^(postgres|postgresql):\/\//i.test(url);
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!url || !databaseUrlLooksPostgres(url)) {
    console.log('DRY RUN ONLY');
    console.log('PRODUCTION WRITES: 0');
    console.log('');
    console.log('No PostgreSQL DATABASE_URL is configured in this environment.');
    console.log('On Replit, run this read-only command:');
    console.log('');
    console.log('DATABASE_URL="$PROD_DATABASE_URL" npm run attendance:8h:audit');
    console.log('');
    console.log('DRY RUN ONLY');
    console.log('PRODUCTION WRITES: 0');
    process.exit(0);
  }

  const prisma = new PrismaClient({
    log: ['error'],
  });

  try {
    const [records, exceptions] = await Promise.all([
      prisma.attendanceRecord.findMany({
        include: {
          employee: { select: { employeeCode: true, fullName: true, isActive: true } },
          shift: { select: { gracePeriodMinutes: true, minWorkMinutes: true } },
          assignment: { select: { workDate: true } },
        },
        orderBy: [{ scheduledStart: 'asc' }],
      }),
      prisma.dayException.findMany(),
    ]);

    const exceptionByKey = new Map<string, DayExceptionRecord[]>();
    for (const row of exceptions) {
      const record: DayExceptionRecord = {
        workDate: row.workDate,
        employeeId: row.employeeId,
        type: row.type as DayExceptionRecord['type'],
        expectedStartTime: row.expectedStartTime,
        expectedEndTime: row.expectedEndTime,
        expectedWorkMinutes: row.expectedWorkMinutes,
      };
      const keys = [row.workDate];
      if (row.employeeId) keys.push(`${row.workDate}:${row.employeeId}`);
      for (const key of keys) {
        const list = exceptionByKey.get(key) || [];
        list.push(record);
        exceptionByKey.set(key, list);
      }
    }

    const completed: CompletedAttendanceAuditRow[] = [];
    let skippedOpenOrMissing = 0;
    for (const row of records) {
      if (isDemoEmployeeCode(row.employee.employeeCode) || isDemoEmployeeName(row.employee.fullName)) {
        continue;
      }
      if (!row.checkInAt || !row.checkOutAt) {
        skippedOpenOrMissing += 1;
        continue;
      }
      const workDate = row.assignment?.workDate || calendarDateInAppZone(row.scheduledStart);
      const employeeExceptions = [
        ...(exceptionByKey.get(workDate) || []).filter((item) => item.employeeId == null),
        ...(exceptionByKey.get(`${workDate}:${row.employeeId}`) || []),
      ];
      completed.push({
        id: row.id,
        workDate,
        employeeId: row.employeeId,
        employeeCode: row.employee.employeeCode,
        employeeName: row.employee.fullName,
        checkInAt: row.checkInAt,
        checkOutAt: row.checkOutAt,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
        workedMinutes: row.workedMinutes,
        lateMinutes: row.lateMinutes,
        earlyLeaveMinutes: row.earlyLeaveMinutes,
        overtimeMinutes: row.overtimeMinutes,
        statusPrimary: row.statusPrimary,
        flags: row.flags,
        checkInMethod: row.checkInMethod,
        checkOutMethod: row.checkOutMethod,
        gracePeriodMinutes: row.shift.gracePeriodMinutes,
        minWorkMinutes: row.shift.minWorkMinutes,
        exceptions: employeeExceptions,
      });
    }

    const summary = summarizeAttendance8hAudit({
      rows: completed,
      skippedOpenOrMissing,
    });
    console.log(formatAttendance8hAuditReport(summary));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.log('DRY RUN ONLY');
  console.log('PRODUCTION WRITES: 0');
  process.exit(1);
});

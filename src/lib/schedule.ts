import { prisma } from './db';
import {
  diffMinutes,
  formatDuration,
  resolveWorkDateForShift,
  scheduledWindow,
} from './attendance-calc';

export type TimingPhase = 'early' | 'on_time' | 'late' | 'in_shift';

export function getShiftTiming(
  now: Date,
  scheduledStart: Date,
  scheduledEnd: Date,
  gracePeriodMinutes: number
) {
  const msUntilStart = scheduledStart.getTime() - now.getTime();
  const msUntilEnd = scheduledEnd.getTime() - now.getTime();

  if (now < scheduledStart) {
    const minutesUntilStart = Math.max(1, Math.ceil(msUntilStart / 60000));
    return {
      phase: 'early' as TimingPhase,
      minutesUntilStart,
      lateMinutes: 0,
      earlyMinutes: minutesUntilStart,
      labelAr: `باقي على بداية الشفت ${formatDuration(minutesUntilStart)}`,
      labelEn: `Shift starts in ${formatDuration(minutesUntilStart)}`,
      msUntilStart,
      msUntilEnd,
    };
  }

  const rawLate = Math.max(0, diffMinutes(now, scheduledStart));
  const lateMinutes = Math.max(0, rawLate - gracePeriodMinutes);

  if (lateMinutes > 0) {
    return {
      phase: 'late' as TimingPhase,
      minutesUntilStart: 0,
      lateMinutes,
      earlyMinutes: 0,
      labelAr: `متأخر ${lateMinutes} دقيقة عن بداية الشفت`,
      labelEn: `Late by ${lateMinutes} minutes`,
      msUntilStart: 0,
      msUntilEnd,
    };
  }

  if (now <= scheduledEnd) {
    return {
      phase: 'on_time' as TimingPhase,
      minutesUntilStart: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
      labelAr: 'في الوقت / ضمن فترة السماح',
      labelEn: 'On time / within grace',
      msUntilStart: 0,
      msUntilEnd,
    };
  }

  return {
    phase: 'in_shift' as TimingPhase,
    minutesUntilStart: 0,
    lateMinutes: 0,
    earlyMinutes: 0,
    labelAr: 'انتهى وقت الشفت المجدول',
    labelEn: 'Scheduled shift window ended',
    msUntilStart: 0,
    msUntilEnd,
  };
}

/** Ensure employee has a SCHEDULED assignment for the current/upcoming night shift night */
export async function ensureTonightAssignment(employeeId: string, projectId?: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) return null;

  const night =
    (await prisma.shift.findFirst({
      where: { crossesMidnight: true, isActive: true },
    })) ||
    (await prisma.shift.findFirst({ where: { isActive: true } }));

  if (!night) return null;

  const workDate = resolveWorkDateForShift(
    new Date(),
    night.startTime,
    night.endTime,
    night.crossesMidnight
  );

  const targetProjectId = projectId || employee.defaultProjectId;
  if (!targetProjectId) return null;

  let assignment = await prisma.employeeShiftAssignment.findFirst({
    where: {
      employeeId,
      workDate,
      projectId: targetProjectId,
      status: 'SCHEDULED',
    },
    include: { project: true, shift: true },
  });

  if (!assignment) {
    assignment = await prisma.employeeShiftAssignment.create({
      data: {
        employeeId,
        projectId: targetProjectId,
        shiftId: night.id,
        workDate,
        status: 'SCHEDULED',
      },
      include: { project: true, shift: true },
    });
  }

  const window = scheduledWindow(
    assignment.workDate,
    assignment.shift.startTime,
    assignment.shift.endTime,
    assignment.shift.crossesMidnight
  );

  const timing = getShiftTiming(
    new Date(),
    window.scheduledStart,
    window.scheduledEnd,
    assignment.shift.gracePeriodMinutes
  );

  return { assignment, night, workDate, window, timing };
}

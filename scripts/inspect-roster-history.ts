import { prisma } from '../src/lib/db';
import { OFFICIAL_ROSTER_START } from '../src/lib/roster-official';

/** READ-ONLY inspection of assignments and attendance before the official roster start. */
async function main() {
  const before = OFFICIAL_ROSTER_START;
  const [assignments, attendance, employees] = await Promise.all([
    prisma.employeeShiftAssignment.findMany({
      where: { workDate: { lt: before } },
      include: {
        employee: { select: { employeeCode: true, fullName: true, isActive: true } },
        shift: { select: { startTime: true, endTime: true } },
        attendance: { select: { id: true, checkInAt: true, checkOutAt: true } },
      },
      orderBy: [{ workDate: 'asc' }, { employeeId: 'asc' }],
    }),
    prisma.attendanceRecord.findMany({
      where: { assignment: { workDate: { lt: before } } },
      select: {
        id: true,
        employeeId: true,
        checkInAt: true,
        assignment: { select: { workDate: true } },
      },
    }),
    prisma.employee.findMany({
      select: { employeeCode: true, fullName: true, isActive: true },
      orderBy: { employeeCode: 'asc' },
    }),
  ]);

  const withAttendance = assignments.filter((row) => row.attendance.some((a) => a.checkInAt));
  const dates = [...new Set(assignments.map((row) => row.workDate))].sort();
  const report = {
    mode: 'read-only',
    cutoff: before,
    destructive: false,
    employeeCount: employees.length,
    assignmentCount: assignments.length,
    attendanceCount: attendance.length,
    lockedAssignmentCount: withAttendance.length,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    uniqueDates: dates.length,
    byEmployee: assignments.reduce<Record<string, { assignments: number; withAttendance: number }>>((acc, row) => {
      const code = row.employee.employeeCode;
      if (!acc[code]) acc[code] = { assignments: 0, withAttendance: 0 };
      acc[code].assignments += 1;
      if (row.attendance.some((a) => a.checkInAt)) acc[code].withAttendance += 1;
      return acc;
    }, {}),
    sample: assignments.slice(0, 20).map((row) => ({
      workDate: row.workDate,
      employeeCode: row.employee.employeeCode,
      status: row.status,
      shift: `${row.shift.startTime}→${row.shift.endTime}`,
      hasCheckIn: row.attendance.some((a) => a.checkInAt),
    })),
  };
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { randomBytes } from 'crypto';
import { PrismaClient, Role, AssignmentStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { resolveWorkDateForShift } from '../src/lib/attendance-calc';

const prisma = new PrismaClient();

/** Development-only demo roster. No real employee identities. */
const DEMO_CREW = [
  {
    employeeCode: 'EMP-0147',
    badgeNumber: '0147',
    username: 'EMP-0147',
    fullName: 'Demo Employee',
    department: 'Night Shift',
    position: 'Night Operator',
    pin: '1234',
  },
  {
    employeeCode: 'EMP-0148',
    badgeNumber: '0148',
    username: 'EMP-0148',
    fullName: 'Demo Employee Two',
    department: 'Night Shift',
    position: 'Night Operator',
    pin: '1234',
  },
] as const;

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'Demo seed is disabled in production. Use npm run bootstrap:production on the production database.'
    );
    process.exit(1);
  }

  const existingUsers = await prisma.user.count();
  const resetDemo = process.env.RESET_DEMO === '1';

  if (existingUsers > 0 && !resetDemo) {
    console.log(`Seed skipped: database already has ${existingUsers} users.`);
    console.log('To replace local demo data only, set RESET_DEMO=1 (this deletes existing rows).');
    return;
  }

  if (resetDemo) {
    console.log('RESET_DEMO=1 — clearing existing rows for a fresh demo seed.');
  }

  await prisma.attendanceAdjustment.deleteMany();
  await prisma.attendanceRecord.deleteMany();
  await prisma.qrSession.deleteMany();
  await prisma.qrTerminal.deleteMany();
  await prisma.employeeShiftAssignment.deleteMany();
  await prisma.leave.deleteMany();
  await prisma.device.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.projectSupervisor.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.project.deleteMany();

  const night = await prisma.shift.create({
    data: {
      name: 'Night Shift',
      startTime: '18:00',
      endTime: '06:00',
      crossesMidnight: true,
      gracePeriodMinutes: 5,
      checkinWindowBeforeMinutes: 30,
      checkoutWindowAfterMinutes: 180,
    },
  });

  const project = await prisma.project.create({
    data: {
      name: 'Demo Night Site',
      code: 'DEMO-01',
      locationLabel: 'Demo Site — Development',
      latitude: 26.3252708,
      longitude: 50.0743019,
      radiusMeters: 200,
    },
  });

  const adminEmp = await prisma.employee.create({
    data: {
      employeeCode: 'ADMIN',
      badgeNumber: '0001',
      fullName: 'Demo Admin',
      department: 'IT',
      position: 'Admin',
      company: 'Demo Company',
      defaultProjectId: project.id,
    },
  });

  const supervisor = await prisma.employee.create({
    data: {
      employeeCode: 'EMP-0201',
      badgeNumber: '0201',
      fullName: 'Demo Supervisor',
      department: 'Operations',
      position: 'Supervisor',
      company: 'Demo Company',
      defaultProjectId: project.id,
    },
  });

  await prisma.user.create({
    data: {
      username: 'admin',
      passwordHash: await bcrypt.hash('admin123', 10),
      role: Role.ADMIN,
      employeeId: adminEmp.id,
    },
  });

  await prisma.user.create({
    data: {
      username: 'EMP-0201',
      passwordHash: await bcrypt.hash('1234', 10),
      role: Role.SUPERVISOR,
      employeeId: supervisor.id,
    },
  });

  await prisma.projectSupervisor.create({
    data: { projectId: project.id, employeeId: supervisor.id },
  });

  await prisma.qrTerminal.create({
    data: {
      projectId: project.id,
      name: 'Gate Tablet',
      slug: 'bin-quraya-dhahran',
      secretKey: randomBytes(32).toString('hex'),
      rotationSeconds: 30,
    },
  });

  const workDate = resolveWorkDateForShift(new Date(), '18:00', '06:00', true);

  for (const row of DEMO_CREW) {
    const emp = await prisma.employee.create({
      data: {
        employeeCode: row.employeeCode,
        badgeNumber: row.badgeNumber,
        fullName: row.fullName,
        department: row.department,
        position: row.position,
        company: 'Demo Company',
        defaultProjectId: project.id,
      },
    });

    await prisma.user.create({
      data: {
        username: row.username,
        passwordHash: await bcrypt.hash(row.pin, 10),
        role: Role.EMPLOYEE,
        employeeId: emp.id,
      },
    });

    await prisma.employeeShiftAssignment.create({
      data: {
        employeeId: emp.id,
        projectId: project.id,
        shiftId: night.id,
        workDate,
        status: AssignmentStatus.SCHEDULED,
      },
    });
  }

  await prisma.employeeShiftAssignment.create({
    data: {
      employeeId: supervisor.id,
      projectId: project.id,
      shiftId: night.id,
      workDate,
      status: AssignmentStatus.SCHEDULED,
    },
  });

  console.log('Seed OK — development demo accounts');
  console.log('Admin: admin / admin123');
  console.log('Supervisor: EMP-0201 / 1234');
  console.log('Employee: EMP-0147 / 1234');
  console.log('Employee: EMP-0148 / 1234');
  console.log('Terminal: /terminal/bin-quraya-dhahran');
  console.log('Tonight workDate:', workDate);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

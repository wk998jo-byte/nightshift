import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import {
  assertBootstrapAllowed,
  assertSafeAdminPassword,
  computeCrossesMidnight,
  parseGraceMinutes,
  parseHHMM,
  parseLatitude,
  parseLongitude,
  parseRadiusMeters,
  parseTerminalSlug,
  readBootstrapInput,
  retireLegacyShift,
  ensureAdmin,
  ensureTerminal,
  ensureProductionEmployees,
  deactivateUnusedDemoEmployees,
  isClearlyDemoEmployee,
  BootstrapError,
} from './bootstrap-production';

function validEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PROD_ADMIN_USERNAME: 'ops-admin',
    PROD_ADMIN_PASSWORD: 'a-strong-password',
    PROD_ADMIN_FULL_NAME: 'Operations Admin',
    PROD_ADMIN_EMPLOYEE_CODE: 'ADM-0001',
    PROD_ADMIN_BADGE_NUMBER: '1001',
    PROD_PROJECT_NAME: 'Riyadh Night Site',
    PROD_PROJECT_CODE: 'RYD-01',
    PROD_PROJECT_LOCATION_LABEL: 'Riyadh',
    PROD_PROJECT_LATITUDE: '24.7136',
    PROD_PROJECT_LONGITUDE: '46.6753',
    PROD_PROJECT_RADIUS_METERS: '150',
    PROD_SHIFT_1_NAME: 'Night Shift 1',
    PROD_SHIFT_1_START_TIME: '15:30',
    PROD_SHIFT_1_END_TIME: '03:30',
    PROD_SHIFT_1_GRACE_MINUTES: '5',
    PROD_SHIFT_2_NAME: 'Night Shift 2',
    PROD_SHIFT_2_START_TIME: '19:30',
    PROD_SHIFT_2_END_TIME: '07:30',
    PROD_SHIFT_2_GRACE_MINUTES: '5',
    PROD_TERMINAL_NAME: 'Gate Tablet',
    PROD_TERMINAL_SLUG: 'riyadh-gate',
    PROD_EMPLOYEE_1_FULL_NAME: 'Test Operator One',
    PROD_EMPLOYEE_1_CODE: 'T-1001',
    PROD_EMPLOYEE_1_BADGE: 'T-1001',
    PROD_EMPLOYEE_1_USERNAME: 'T-1001',
    PROD_EMPLOYEE_1_PASSWORD: 'employee-pass-one',
    PROD_EMPLOYEE_1_POSITION: 'Control Operator',
    PROD_EMPLOYEE_2_FULL_NAME: 'Test Operator Two',
    PROD_EMPLOYEE_2_CODE: 'T-1002',
    PROD_EMPLOYEE_2_BADGE: 'T-1002',
    PROD_EMPLOYEE_2_USERNAME: 'T-1002',
    PROD_EMPLOYEE_2_PASSWORD: 'employee-pass-two',
    PROD_EMPLOYEE_2_POSITION: 'Safety Operator',
    PROD_EMPLOYEE_3_FULL_NAME: 'Test Operator Three',
    PROD_EMPLOYEE_3_CODE: 'T-1003',
    PROD_EMPLOYEE_3_BADGE: 'T-1003',
    PROD_EMPLOYEE_3_USERNAME: 'T-1003',
    PROD_EMPLOYEE_3_PASSWORD: 'employee-pass-three',
    PROD_EMPLOYEE_3_POSITION: 'Safety Operator',
    ...overrides,
  };
}

describe('production bootstrap guards and validation', () => {
  it('refuses to run unless NODE_ENV is production', () => {
    assert.throws(
      () => assertBootstrapAllowed('development', undefined),
      (err: unknown) => err instanceof BootstrapError && /NODE_ENV is not "production"/.test(err.message)
    );
  });

  it('allows an explicit test override without production NODE_ENV', () => {
    assert.doesNotThrow(() => assertBootstrapAllowed('development', '1'));
    assert.doesNotThrow(() => assertBootstrapAllowed('production', undefined));
  });

  it('parses both production night shifts as crossing midnight', () => {
    assert.equal(parseHHMM('15:30', 'PROD_SHIFT_1_START_TIME'), '15:30');
    assert.equal(parseHHMM('03:30', 'PROD_SHIFT_1_END_TIME'), '03:30');
    assert.equal(computeCrossesMidnight('15:30', '03:30'), true);
    assert.equal(parseHHMM('19:30', 'PROD_SHIFT_2_START_TIME'), '19:30');
    assert.equal(parseHHMM('07:30', 'PROD_SHIFT_2_END_TIME'), '07:30');
    assert.equal(computeCrossesMidnight('19:30', '07:30'), true);
    assert.equal(computeCrossesMidnight('08:00', '17:00'), false);
  });

  it('rejects invalid HH:mm values', () => {
    assert.throws(() => parseHHMM('25:00', 'PROD_SHIFT_1_START_TIME'), BootstrapError);
    assert.throws(() => parseHHMM('18', 'PROD_SHIFT_1_START_TIME'), BootstrapError);
    assert.throws(() => parseHHMM('18:0', 'PROD_SHIFT_1_START_TIME'), BootstrapError);
  });

  it('validates coordinates and radius', () => {
    assert.equal(parseLatitude('26.3252708'), 26.3252708);
    assert.equal(parseLongitude('50.0743019'), 50.0743019);
    assert.equal(parseRadiusMeters('200'), 200);
    assert.throws(() => parseLatitude('100'), BootstrapError);
    assert.throws(() => parseLongitude('200'), BootstrapError);
    assert.throws(() => parseRadiusMeters('0'), BootstrapError);
    assert.throws(() => parseRadiusMeters('12.5'), BootstrapError);
  });

  it('rejects demo admin passwords and incomplete env', () => {
    assert.throws(() => assertSafeAdminPassword('admin123'), BootstrapError);
    assert.throws(() => assertSafeAdminPassword('1234'), BootstrapError);
    assert.throws(() => assertSafeAdminPassword('short'), BootstrapError);
    assert.throws(() => readBootstrapInput({}), BootstrapError);
    assert.throws(() => parseGraceMinutes('-1'), BootstrapError);
    assert.throws(() => parseTerminalSlug('Riyadh Gate'), BootstrapError);
  });

  it('reads both night shifts from env without using a single PROD_SHIFT_* set', () => {
    const input = readBootstrapInput(validEnv());
    assert.equal(input.adminUsername, 'ops-admin');
    assert.equal(input.terminalSlug, 'riyadh-gate');
    assert.equal(input.shifts.length, 2);
    assert.equal(input.shifts[0].name, 'Night Shift 1');
    assert.equal(input.shifts[0].startTime, '15:30');
    assert.equal(input.shifts[0].endTime, '03:30');
    assert.equal(input.shifts[0].crossesMidnight, true);
    assert.equal(input.shifts[1].name, 'Night Shift 2');
    assert.equal(input.shifts[1].startTime, '19:30');
    assert.equal(input.shifts[1].endTime, '07:30');
    assert.equal(input.shifts[1].crossesMidnight, true);
    assert.ok('adminPassword' in input);
    assert.notEqual(input.adminPassword, 'admin123');
    assert.equal(input.employees.length, 3);
    assert.equal(input.employees[0].employeeCode, 'T-1001');
    assert.equal(input.employees[0].username, 'T-1001');
    assert.equal(input.employees[2].position, 'Safety Operator');
  });

  it('rejects colliding production employee identifiers', () => {
    assert.throws(
      () =>
        readBootstrapInput(
          validEnv({
            PROD_EMPLOYEE_2_CODE: 'T-1001',
          })
        ),
      (err: unknown) => err instanceof BootstrapError && /already used by PROD_EMPLOYEE_1/.test(err.message)
    );
    assert.throws(
      () =>
        readBootstrapInput(
          validEnv({
            PROD_EMPLOYEE_1_USERNAME: 'ops-admin',
          })
        ),
      (err: unknown) => err instanceof BootstrapError && /already used by PROD_ADMIN/.test(err.message)
    );
    assert.throws(
      () =>
        readBootstrapInput(
          validEnv({
            PROD_EMPLOYEE_1_PASSWORD: '1234',
          })
        ),
      (err: unknown) => err instanceof BootstrapError && /demo password/.test(err.message)
    );
  });

  it('rejects duplicate shift names', () => {
    assert.throws(
      () =>
        readBootstrapInput(
          validEnv({
            PROD_SHIFT_2_NAME: 'Night Shift 1',
          })
        ),
      (err: unknown) => err instanceof BootstrapError && /must be different/.test(err.message)
    );
  });
});

function mockLegacyDb(options: {
  shift?: { id: string; name: string; startTime: string; endTime: string; isActive: boolean } | null;
  assignmentCount?: number;
  attendanceCount?: number;
}) {
  const updates: Array<{ id: string; isActive: boolean }> = [];
  let queried = false;
  const prisma = {
    shift: {
      async findMany() {
        queried = true;
        return options.shift ? [options.shift] : [];
      },
      async update(args: { where: { id: string }; data: { isActive: boolean } }) {
        updates.push({ id: args.where.id, isActive: args.data.isActive });
        return args;
      },
    },
    employeeShiftAssignment: {
      async count() {
        return options.assignmentCount ?? 0;
      },
    },
    attendanceRecord: {
      async count() {
        return options.attendanceCount ?? 0;
      },
    },
  };
  return { prisma, updates, wasQueried: () => queried };
}

describe('legacy production shift', () => {
  it('legacy unused → becomes inactive', async () => {
    const { prisma, updates } = mockLegacyDb({
      shift: {
        id: 'legacy-1',
        name: 'Night Shift',
        startTime: '18:00',
        endTime: '06:00',
        isActive: true,
      },
      assignmentCount: 0,
      attendanceCount: 0,
    });
    const input = readBootstrapInput(
      validEnv({
        PROD_SHIFT_NAME: 'Night Shift',
        PROD_SHIFT_START_TIME: '18:00',
        PROD_SHIFT_END_TIME: '06:00',
      })
    );
    await retireLegacyShift(prisma, input);
    assert.deepEqual(updates, [{ id: 'legacy-1', isActive: false }]);
  });

  it('legacy used → warning and left unchanged', async () => {
    const { prisma, updates } = mockLegacyDb({
      shift: {
        id: 'legacy-1',
        name: 'Night Shift',
        startTime: '18:00',
        endTime: '06:00',
        isActive: true,
      },
      assignmentCount: 3,
      attendanceCount: 0,
    });
    const input = readBootstrapInput(
      validEnv({
        PROD_SHIFT_NAME: 'Night Shift',
        PROD_SHIFT_START_TIME: '18:00',
        PROD_SHIFT_END_TIME: '06:00',
      })
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await retireLegacyShift(prisma, input);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(updates.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WARNING: Legacy shift/);
    assert.match(warnings[0], /3 assignment/);
  });

  it('no legacy → succeeds', async () => {
    const { prisma, updates, wasQueried } = mockLegacyDb({
      shift: {
        id: 'legacy-1',
        name: 'Night Shift',
        startTime: '18:00',
        endTime: '06:00',
        isActive: true,
      },
    });
    const input = readBootstrapInput(validEnv());
    await retireLegacyShift(prisma, input);
    assert.equal(input.legacyShift, undefined);
    assert.equal(wasQueried(), false);
    assert.equal(updates.length, 0);
  });
});

function mockAdminWorld(options: {
  employees: Array<{
    id: string;
    employeeCode: string;
    badgeNumber: string;
    fullName: string;
    defaultProjectId: string | null;
    company?: string;
  }>;
  users: Array<{
    id: string;
    username: string;
    passwordHash: string;
    role: Role;
    employeeId: string;
  }>;
  assignmentCountByEmployee?: Record<string, number>;
  attendanceCountByEmployee?: Record<string, number>;
  terminals?: Array<{
    id: string;
    projectId: string;
    name: string;
    slug: string;
    rotationSeconds: number;
  }>;
}) {
  const employees = options.employees.map((e) => ({ company: 'Demo Company', ...e }));
  const users = [...options.users];
  const terminals = [...(options.terminals ?? [])];
  const employeeUpdates: unknown[] = [];
  const userUpdates: unknown[] = [];
  const createdTerminals: unknown[] = [];

  const prisma: Record<string, unknown> = {};
  Object.assign(prisma, {
    user: {
      async findUnique(args: { where: { username: string } }) {
        const user = users.find((u) => u.username === args.where.username) ?? null;
        if (!user) return null;
        const employee = employees.find((e) => e.id === user.employeeId) ?? null;
        return { ...user, employee };
      },
      async create() {
        throw new Error('unexpected user.create');
      },
      async update(args: { where: { id: string }; data: { passwordHash: string; role: Role } }) {
        userUpdates.push(args);
        const user = users.find((u) => u.id === args.where.id);
        if (user) {
          user.passwordHash = args.data.passwordHash;
          user.role = args.data.role;
        }
        return args;
      },
    },
    employee: {
      async findUnique(args: { where: { employeeCode?: string; badgeNumber?: string } }) {
        const found =
          employees.find((e) =>
            args.where.employeeCode
              ? e.employeeCode === args.where.employeeCode
              : e.badgeNumber === args.where.badgeNumber
          ) ?? null;
        if (!found) return null;
        const user = users.find((u) => u.employeeId === found.id) ?? null;
        return { ...found, user };
      },
      async create() {
        throw new Error('unexpected employee.create');
      },
      async update(args: {
        where: { id: string };
        data: {
          employeeCode: string;
          badgeNumber: string;
          fullName: string;
          defaultProjectId: string;
          company: string;
        };
      }) {
        employeeUpdates.push(args);
        const employee = employees.find((e) => e.id === args.where.id);
        if (employee) {
          employee.employeeCode = args.data.employeeCode;
          employee.badgeNumber = args.data.badgeNumber;
          employee.fullName = args.data.fullName;
          employee.defaultProjectId = args.data.defaultProjectId;
          employee.company = args.data.company;
        }
        return args;
      },
    },
    employeeShiftAssignment: {
      async count(args: { where: { employeeId?: string; shiftId?: string } }) {
        if (args.where.employeeId) {
          return options.assignmentCountByEmployee?.[args.where.employeeId] ?? 0;
        }
        return 0;
      },
    },
    attendanceRecord: {
      async count(args: { where: { employeeId?: string; shiftId?: string } }) {
        if (args.where.employeeId) {
          return options.attendanceCountByEmployee?.[args.where.employeeId] ?? 0;
        }
        return 0;
      },
    },
    qrTerminal: {
      async findUnique(args: { where: { slug: string } }) {
        return terminals.find((t) => t.slug === args.where.slug) ?? null;
      },
      async create(args: { data: { projectId: string; name: string; slug: string; rotationSeconds: number } }) {
        createdTerminals.push(args.data);
        terminals.push({ id: 'term-1', ...args.data });
        return { id: 'term-1', ...args.data };
      },
    },
    async $transaction<T>(fn: (tx: typeof prisma) => Promise<T>) {
      return fn(prisma);
    },
  });

  return { prisma, employees, users, employeeUpdates, userUpdates, createdTerminals, terminals };
}

describe('legacy production admin', () => {
  const projectId = 'proj-real';

  it('legacy ADMIN placeholder without attendance/assignments becomes the real admin', async () => {
    const oldHash = await bcrypt.hash('old-legacy-pass', 10);
    const { prisma, employees, users } = mockAdminWorld({
      employees: [
        {
          id: 'emp-admin',
          employeeCode: 'ADMIN',
          badgeNumber: '0001',
          fullName: 'Demo Admin',
          defaultProjectId: 'proj-old',
        },
      ],
      users: [
        {
          id: 'user-admin',
          username: 'ops-admin',
          passwordHash: oldHash,
          role: Role.ADMIN,
          employeeId: 'emp-admin',
        },
      ],
    });
    const input = readBootstrapInput(validEnv());
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await ensureAdmin(prisma as never, input, projectId);
    } finally {
      console.log = originalLog;
    }

    assert.equal(employees[0].employeeCode, 'ADM-0001');
    assert.equal(employees[0].badgeNumber, '1001');
    assert.equal(employees[0].fullName, 'Operations Admin');
    assert.equal(employees[0].defaultProjectId, projectId);
    assert.equal(employees[0].company, 'Bin Quraya');
    assert.equal(users.length, 1);
    assert.equal(users[0].role, Role.ADMIN);
    assert.equal(await bcrypt.compare(input.adminPassword, users[0].passwordHash), true);
    assert.equal(logs.includes('Legacy admin reconciled successfully.'), true);
  });

  it('new password is valid after legacy admin reconcile', async () => {
    const { prisma, users } = mockAdminWorld({
      employees: [
        {
          id: 'emp-admin',
          employeeCode: 'ADMIN',
          badgeNumber: '0001',
          fullName: 'Demo Admin',
          defaultProjectId: null,
        },
      ],
      users: [
        {
          id: 'user-admin',
          username: 'ops-admin',
          passwordHash: await bcrypt.hash('not-the-new-one', 10),
          role: Role.ADMIN,
          employeeId: 'emp-admin',
        },
      ],
    });
    const input = readBootstrapInput(validEnv());
    await ensureAdmin(prisma as never, input, projectId);
    assert.equal(await bcrypt.compare('a-strong-password', users[0].passwordHash), true);
    assert.equal(await bcrypt.compare('not-the-new-one', users[0].passwordHash), false);
  });

  it('target employeeCode/badge conflict => fail without changes', async () => {
    const oldHash = await bcrypt.hash('old-legacy-pass', 10);
    const { prisma, employees, users, employeeUpdates, userUpdates } = mockAdminWorld({
      employees: [
        {
          id: 'emp-admin',
          employeeCode: 'ADMIN',
          badgeNumber: '0001',
          fullName: 'Demo Admin',
          defaultProjectId: null,
        },
        {
          id: 'emp-other',
          employeeCode: 'ADM-0001',
          badgeNumber: '9999',
          fullName: 'Someone Else',
          defaultProjectId: projectId,
        },
      ],
      users: [
        {
          id: 'user-admin',
          username: 'ops-admin',
          passwordHash: oldHash,
          role: Role.ADMIN,
          employeeId: 'emp-admin',
        },
      ],
    });
    const input = readBootstrapInput(validEnv());
    await assert.rejects(
      () => ensureAdmin(prisma as never, input, projectId),
      (err: unknown) => err instanceof BootstrapError && /already used by another employee/.test(err.message)
    );
    assert.equal(employees[0].employeeCode, 'ADMIN');
    assert.equal(employees[0].badgeNumber, '0001');
    assert.equal(users[0].passwordHash, oldHash);
    assert.equal(employeeUpdates.length, 0);
    assert.equal(userUpdates.length, 0);
  });

  it('used legacy admin => fail without changes', async () => {
    const oldHash = await bcrypt.hash('old-legacy-pass', 10);
    const { prisma, employees, users, employeeUpdates, userUpdates } = mockAdminWorld({
      employees: [
        {
          id: 'emp-admin',
          employeeCode: 'ADMIN',
          badgeNumber: '0001',
          fullName: 'Demo Admin',
          defaultProjectId: null,
        },
      ],
      users: [
        {
          id: 'user-admin',
          username: 'ops-admin',
          passwordHash: oldHash,
          role: Role.ADMIN,
          employeeId: 'emp-admin',
        },
      ],
      assignmentCountByEmployee: { 'emp-admin': 2 },
      attendanceCountByEmployee: { 'emp-admin': 1 },
    });
    const input = readBootstrapInput(validEnv());
    await assert.rejects(
      () => ensureAdmin(prisma as never, input, projectId),
      (err: unknown) => err instanceof BootstrapError && /still in use/.test(err.message)
    );
    assert.equal(employees[0].employeeCode, 'ADMIN');
    assert.equal(users[0].passwordHash, oldHash);
    assert.equal(employeeUpdates.length, 0);
    assert.equal(userUpdates.length, 0);
  });

  it('bootstrap completes Admin + Terminal successfully while used legacy shift only warns', async () => {
    const { prisma, employees, createdTerminals } = mockAdminWorld({
      employees: [
        {
          id: 'emp-admin',
          employeeCode: 'ADMIN',
          badgeNumber: '0001',
          fullName: 'Demo Admin',
          defaultProjectId: null,
        },
      ],
      users: [
        {
          id: 'user-admin',
          username: 'ops-admin',
          passwordHash: await bcrypt.hash('old-legacy-pass', 10),
          role: Role.ADMIN,
          employeeId: 'emp-admin',
        },
      ],
    });
    const input = readBootstrapInput(
      validEnv({
        PROD_SHIFT_NAME: 'Night Shift',
        PROD_SHIFT_START_TIME: '18:00',
        PROD_SHIFT_END_TIME: '06:00',
      })
    );
    await ensureAdmin(prisma as never, input, projectId);
    await ensureTerminal(prisma as never, input, projectId);

    const { prisma: shiftDb, updates } = mockLegacyDb({
      shift: {
        id: 'legacy-1',
        name: 'Night Shift',
        startTime: '18:00',
        endTime: '06:00',
        isActive: true,
      },
      assignmentCount: 3,
      attendanceCount: 0,
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await retireLegacyShift(shiftDb, input);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(employees[0].employeeCode, 'ADM-0001');
    assert.equal(createdTerminals.length, 1);
    assert.equal(updates.length, 0);
    assert.match(warnings[0], /WARNING: Legacy shift/);
  });
});

function mockStaffWorld(options: {
  employees?: Array<{
    id: string;
    employeeCode: string;
    badgeNumber: string;
    fullName: string;
    position?: string | null;
    company?: string;
    isActive?: boolean;
    defaultProjectId: string | null;
  }>;
  users?: Array<{
    id: string;
    username: string;
    passwordHash: string;
    role: Role;
    isActive?: boolean;
    employeeId: string;
  }>;
  attendanceCountByEmployee?: Record<string, number>;
}) {
  const employees = (options.employees ?? []).map((e) => ({
    ...e,
    position: e.position ?? null,
    company: e.company ?? 'Bin Quraya',
    isActive: e.isActive ?? true,
  }));
  const users = (options.users ?? []).map((u) => ({
    ...u,
    isActive: u.isActive ?? true,
  }));
  let seq = 1;
  const assignmentCreates: unknown[] = [];
  const logs: string[] = [];

  const prisma: Record<string, unknown> = {};
  Object.assign(prisma, {
    user: {
      async findUnique(args: { where: { username: string } }) {
        const user = users.find((u) => u.username === args.where.username) ?? null;
        if (!user) return null;
        const employee = employees.find((e) => e.id === user.employeeId) ?? null;
        return { ...user, employee };
      },
      async create(args: {
        data: {
          username: string;
          passwordHash: string;
          role: Role;
          employeeId: string;
          isActive: boolean;
        };
      }) {
        const row = { id: `user-${seq++}`, ...args.data };
        users.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: { isActive?: boolean } }) {
        const user = users.find((u) => u.id === args.where.id);
        if (user && args.data.isActive !== undefined) user.isActive = args.data.isActive;
        return args;
      },
    },
    employee: {
      async findUnique(args: { where: { employeeCode?: string; badgeNumber?: string } }) {
        const found =
          employees.find((e) =>
            args.where.employeeCode
              ? e.employeeCode === args.where.employeeCode
              : e.badgeNumber === args.where.badgeNumber
          ) ?? null;
        if (!found) return null;
        const user = users.find((u) => u.employeeId === found.id) ?? null;
        return { ...found, user };
      },
      async findMany() {
        return employees.map((e) => ({
          ...e,
          user: users.find((u) => u.employeeId === e.id) ?? null,
        }));
      },
      async create(args: {
        data: {
          employeeCode: string;
          badgeNumber: string;
          fullName: string;
          position: string;
          company: string;
          defaultProjectId: string;
          isActive: boolean;
        };
      }) {
        const row = { id: `emp-${seq++}`, ...args.data };
        employees.push(row);
        return row;
      },
      async update(args: { where: { id: string }; data: { isActive?: boolean } }) {
        const employee = employees.find((e) => e.id === args.where.id);
        if (employee && args.data.isActive !== undefined) employee.isActive = args.data.isActive;
        return args;
      },
    },
    employeeShiftAssignment: {
      async count() {
        return 0;
      },
      async create(args: unknown) {
        assignmentCreates.push(args);
        throw new Error('shift assignment must not be created during employee bootstrap');
      },
    },
    attendanceRecord: {
      async count(args: { where: { employeeId?: string } }) {
        return options.attendanceCountByEmployee?.[args.where.employeeId ?? ''] ?? 0;
      },
    },
  });

  return { prisma, employees, users, assignmentCreates, logs };
}

describe('production employees bootstrap', () => {
  const projectId = 'proj-real';

  it('creates three EMPLOYEE users with bcrypt passwords and no shift assignment', async () => {
    const { prisma, employees, users, assignmentCreates } = mockStaffWorld({});
    const input = readBootstrapInput(validEnv());
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      const result = await ensureProductionEmployees(prisma as never, input, projectId);
      assert.equal(result.created, 3);
      assert.equal(result.assignmentCreates, 0);
    } finally {
      console.log = originalLog;
    }

    assert.equal(employees.length, 3);
    assert.equal(users.length, 3);
    assert.equal(assignmentCreates.length, 0);
    for (const spec of input.employees) {
      const employee = employees.find((e) => e.employeeCode === spec.employeeCode);
      const user = users.find((u) => u.username === spec.username);
      assert.ok(employee);
      assert.ok(user);
      assert.equal(user.role, Role.EMPLOYEE);
      assert.equal(user.isActive, true);
      assert.equal(employee.isActive, true);
      assert.equal(employee.company, 'Bin Quraya');
      assert.equal(employee.position, spec.position);
      assert.equal(employee.defaultProjectId, projectId);
      assert.notEqual(user.passwordHash, spec.password);
      assert.match(user.passwordHash, /^\$2[aby]\$/);
      assert.equal(await bcrypt.compare(spec.password, user.passwordHash), true);
    }
  });

  it('rerun does not create duplicates or change password', async () => {
    const { prisma, employees, users } = mockStaffWorld({});
    const input = readBootstrapInput(validEnv());
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      await ensureProductionEmployees(prisma as never, input, projectId);
      const firstHash = users[0].passwordHash;
      const second = await ensureProductionEmployees(prisma as never, input, projectId);
      assert.equal(second.created, 0);
      assert.equal(second.unchanged, 3);
      assert.equal(employees.length, 3);
      assert.equal(users.length, 3);
      assert.equal(users[0].passwordHash, firstHash);
    } finally {
      console.log = originalLog;
    }
  });

  it('fails clearly when username/badge/code belong to someone else', async () => {
    const { prisma, employees, users } = mockStaffWorld({
      employees: [
        {
          id: 'emp-other',
          employeeCode: 'T-1001',
          badgeNumber: 'OTHER',
          fullName: 'Someone Else',
          defaultProjectId: projectId,
        },
      ],
      users: [
        {
          id: 'user-other',
          username: 'other-user',
          passwordHash: await bcrypt.hash('other-pass-word', 10),
          role: Role.EMPLOYEE,
          employeeId: 'emp-other',
        },
      ],
    });
    const input = readBootstrapInput(validEnv());
    await assert.rejects(
      () => ensureProductionEmployees(prisma as never, input, projectId),
      (err: unknown) => err instanceof BootstrapError && /already has username/.test(err.message)
    );
    assert.equal(employees.length, 1);
    assert.equal(users.length, 1);
  });

  it('refuses to change an existing employee password silently', async () => {
    const oldHash = await bcrypt.hash('original-employee-pass', 10);
    const { prisma, users } = mockStaffWorld({
      employees: [
        {
          id: 'emp-1',
          employeeCode: 'T-1001',
          badgeNumber: 'T-1001',
          fullName: 'Test Operator One',
          defaultProjectId: projectId,
        },
      ],
      users: [
        {
          id: 'user-1',
          username: 'T-1001',
          passwordHash: oldHash,
          role: Role.EMPLOYEE,
          employeeId: 'emp-1',
        },
      ],
    });
    const input = readBootstrapInput(validEnv());
    await assert.rejects(
      () => ensureProductionEmployeeForTest(prisma, input, projectId),
      (err: unknown) =>
        err instanceof BootstrapError && /different password/.test(err.message)
    );
    assert.equal(users[0].passwordHash, oldHash);
  });
});

async function ensureProductionEmployeeForTest(
  prisma: unknown,
  input: ReturnType<typeof readBootstrapInput>,
  projectId: string
) {
  return ensureProductionEmployees(prisma as never, input, projectId);
}

describe('demo employee deactivation and shift schedule visibility', () => {
  it('deactivates unused demo employees without deleting records', async () => {
    const { prisma, employees, users } = mockStaffWorld({
      employees: [
        {
          id: 'demo-1',
          employeeCode: 'EMP-0147',
          badgeNumber: '0147',
          fullName: 'Demo Employee',
          defaultProjectId: 'proj-old',
        },
        {
          id: 'demo-2',
          employeeCode: 'EMP-0148',
          badgeNumber: '0148',
          fullName: 'Demo Employee Two',
          defaultProjectId: 'proj-old',
        },
        {
          id: 'demo-sv',
          employeeCode: 'EMP-0201',
          badgeNumber: '0201',
          fullName: 'Demo Supervisor',
          defaultProjectId: 'proj-old',
        },
      ],
      users: [
        {
          id: 'u1',
          username: 'EMP-0147',
          passwordHash: 'x',
          role: Role.EMPLOYEE,
          employeeId: 'demo-1',
        },
        {
          id: 'u2',
          username: 'EMP-0148',
          passwordHash: 'x',
          role: Role.EMPLOYEE,
          employeeId: 'demo-2',
        },
        {
          id: 'u3',
          username: 'EMP-0201',
          passwordHash: 'x',
          role: Role.SUPERVISOR,
          employeeId: 'demo-sv',
        },
      ],
    });
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      const result = await deactivateUnusedDemoEmployees(prisma as never);
      assert.equal(result.deactivated, 3);
    } finally {
      console.log = originalLog;
    }
    assert.equal(employees.every((e) => e.isActive === false), true);
    assert.equal(users.every((u) => u.isActive === false), true);
  });

  it('does not deactivate a demo employee who has attendance', async () => {
    const { prisma, employees, users } = mockStaffWorld({
      employees: [
        {
          id: 'demo-1',
          employeeCode: 'EMP-0147',
          badgeNumber: '0147',
          fullName: 'Demo Employee',
          defaultProjectId: 'proj-old',
        },
      ],
      users: [
        {
          id: 'u1',
          username: 'EMP-0147',
          passwordHash: 'x',
          role: Role.EMPLOYEE,
          employeeId: 'demo-1',
        },
      ],
      attendanceCountByEmployee: { 'demo-1': 2 },
    });
    await deactivateUnusedDemoEmployees(prisma as never);
    assert.equal(employees[0].isActive, true);
    assert.equal(users[0].isActive, true);
  });

  it('recognizes demo identifiers without treating ADMIN as demo', () => {
    assert.equal(
      isClearlyDemoEmployee({ employeeCode: 'EMP-0147', fullName: 'Demo Employee' }),
      true
    );
    assert.equal(
      isClearlyDemoEmployee({ employeeCode: 'EMP-0201', fullName: 'Demo Supervisor' }),
      true
    );
    assert.equal(
      isClearlyDemoEmployee({
        employeeCode: 'ADMIN',
        fullName: 'Demo Admin',
        user: { username: 'ops-admin', role: Role.ADMIN },
      }),
      false
    );
  });
});

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalize, resolve } from 'node:path';
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

type EnvMap = Record<string, string | undefined>;

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEMO_PASSWORDS = new Set(['admin123', '1234']);

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export function assertBootstrapAllowed(
  nodeEnv = process.env.NODE_ENV,
  allowFlag = process.env.ALLOW_PRODUCTION_BOOTSTRAP
): void {
  if (nodeEnv === 'production') return;
  if (allowFlag === '1') return;
  throw new BootstrapError(
    'Refusing to run production bootstrap: NODE_ENV is not "production". Set ALLOW_PRODUCTION_BOOTSTRAP=1 only for explicit testing against a production database.'
  );
}

export function requireEnv(name: string, env: EnvMap = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new BootstrapError(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseHHMM(value: string, name: string): string {
  const trimmed = value.trim();
  if (!HHMM_RE.test(trimmed)) {
    throw new BootstrapError(`${name} must be HH:mm (00:00–23:59).`);
  }
  return trimmed;
}

export function minutesOfDay(hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map(Number);
  return hour * 60 + minute;
}

export function computeCrossesMidnight(startTime: string, endTime: string): boolean {
  if (startTime === endTime) {
    throw new BootstrapError('Shift start and end times cannot be the same.');
  }
  return minutesOfDay(endTime) <= minutesOfDay(startTime);
}

export function parseLatitude(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < -90 || n > 90) {
    throw new BootstrapError('PROD_PROJECT_LATITUDE must be a number between -90 and 90.');
  }
  return n;
}

export function parseLongitude(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < -180 || n > 180) {
    throw new BootstrapError('PROD_PROJECT_LONGITUDE must be a number between -180 and 180.');
  }
  return n;
}

export function parseRadiusMeters(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new BootstrapError('PROD_PROJECT_RADIUS_METERS must be a positive integer.');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50_000) {
    throw new BootstrapError('PROD_PROJECT_RADIUS_METERS must be an integer between 1 and 50000.');
  }
  return n;
}

export function parseGraceMinutes(value: string, name = 'shift grace minutes'): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new BootstrapError(`${name} must be a non-negative integer.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 180) {
    throw new BootstrapError(`${name} must be an integer between 0 and 180.`);
  }
  return n;
}

export function parseTerminalSlug(value: string): string {
  const slug = value.trim();
  if (!SLUG_RE.test(slug)) {
    throw new BootstrapError(
      'PROD_TERMINAL_SLUG must be lowercase letters, digits, and hyphens (e.g. site-gate-1).'
    );
  }
  return slug;
}

export function assertSafeAdminPassword(password: string): void {
  if (password.length < 8) {
    throw new BootstrapError('PROD_ADMIN_PASSWORD must be at least 8 characters.');
  }
  if (DEMO_PASSWORDS.has(password)) {
    throw new BootstrapError('PROD_ADMIN_PASSWORD cannot be a development demo password.');
  }
}

export function assertSafeEmployeePassword(password: string, name: string): void {
  if (password.length < 4) {
    throw new BootstrapError(`${name} must be at least 4 characters.`);
  }
  if (DEMO_PASSWORDS.has(password)) {
    throw new BootstrapError(`${name} cannot be a development demo password.`);
  }
}

function sameCoord(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function conflict(message: string): never {
  throw new BootstrapError(message);
}

function requirePostgresUrl(url: string): string {
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new BootstrapError('DATABASE_URL must be a PostgreSQL connection string (postgresql://).');
  }
  return url;
}

type ShiftSpec = {
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  crossesMidnight: boolean;
};

type LegacyShiftSpec = {
  name: string;
  startTime?: string;
  endTime?: string;
};

type BootstrapInput = {
  adminUsername: string;
  adminPassword: string;
  adminFullName: string;
  adminEmployeeCode: string;
  adminBadgeNumber: string;
  projectName: string;
  projectCode: string;
  projectLocationLabel: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  shifts: [ShiftSpec, ShiftSpec];
  legacyShift?: LegacyShiftSpec;
  terminalName: string;
  terminalSlug: string;
  employees: [ProductionEmployeeSpec, ProductionEmployeeSpec, ProductionEmployeeSpec];
};

export type ProductionEmployeeSpec = {
  index: 1 | 2 | 3;
  fullName: string;
  employeeCode: string;
  badgeNumber: string;
  username: string;
  password: string;
  position: string;
};

export type AdminDb = {
  user: {
    findUnique: (args: {
      where: { username: string };
      include: { employee: true };
    }) => Promise<{
      id: string;
      username: string;
      passwordHash: string;
      role: Role;
      employeeId: string | null;
      employee: {
        id: string;
        employeeCode: string;
        badgeNumber: string;
        fullName: string;
        defaultProjectId: string | null;
        company: string;
      } | null;
    } | null>;
    create: (args: {
      data: {
        username: string;
        passwordHash: string;
        role: Role;
        employeeId: string;
      };
    }) => Promise<{ id: string; username: string }>;
    update: (args: { where: { id: string }; data: { passwordHash: string; role: Role } }) => Promise<unknown>;
  };
  employee: {
    findUnique: (args: {
      where: { employeeCode?: string; badgeNumber?: string };
      include?: { user: true };
    }) => Promise<{
      id: string;
      employeeCode: string;
      badgeNumber: string;
      fullName: string;
      defaultProjectId: string | null;
      user?: { id: string; username: string } | null;
    } | null>;
    create: (args: {
      data: {
        employeeCode: string;
        badgeNumber: string;
        fullName: string;
        defaultProjectId: string;
      };
    }) => Promise<{ id: string; employeeCode: string }>;
    update: (args: {
      where: { id: string };
      data: {
        employeeCode: string;
        badgeNumber: string;
        fullName: string;
        defaultProjectId: string;
        company: string;
      };
    }) => Promise<unknown>;
  };
  employeeShiftAssignment: {
    count: (args: { where: { employeeId?: string; shiftId?: string } }) => Promise<number>;
  };
  attendanceRecord: {
    count: (args: { where: { employeeId?: string; shiftId?: string } }) => Promise<number>;
  };
  $transaction?: <T>(fn: (tx: AdminDb) => Promise<T>) => Promise<T>;
};

const LEGACY_ADMIN_CODE = 'ADMIN';

export type LegacyShiftDb = {
  shift: {
    findMany: (args: {
      where: { name: string };
    }) => Promise<Array<{ id: string; name: string; startTime: string; endTime: string; isActive: boolean }>>;
    update: (args: { where: { id: string }; data: { isActive: boolean } }) => Promise<unknown>;
  };
  employeeShiftAssignment: {
    count: (args: { where: { shiftId?: string; employeeId?: string } }) => Promise<number>;
  };
  attendanceRecord: {
    count: (args: { where: { shiftId?: string; employeeId?: string } }) => Promise<number>;
  };
};

function readLegacyShiftSpec(env: EnvMap): LegacyShiftSpec | undefined {
  const name = env.PROD_SHIFT_NAME?.trim();
  if (!name) return undefined;
  const startRaw = env.PROD_SHIFT_START_TIME?.trim();
  const endRaw = env.PROD_SHIFT_END_TIME?.trim();
  return {
    name,
    startTime: startRaw ? parseHHMM(startRaw, 'PROD_SHIFT_START_TIME') : undefined,
    endTime: endRaw ? parseHHMM(endRaw, 'PROD_SHIFT_END_TIME') : undefined,
  };
}

function readShiftSpec(env: EnvMap, index: 1 | 2): ShiftSpec {
  const prefix = `PROD_SHIFT_${index}`;
  const startTime = parseHHMM(requireEnv(`${prefix}_START_TIME`, env), `${prefix}_START_TIME`);
  const endTime = parseHHMM(requireEnv(`${prefix}_END_TIME`, env), `${prefix}_END_TIME`);
  return {
    name: requireEnv(`${prefix}_NAME`, env),
    startTime,
    endTime,
    graceMinutes: parseGraceMinutes(requireEnv(`${prefix}_GRACE_MINUTES`, env), `${prefix}_GRACE_MINUTES`),
    crossesMidnight: computeCrossesMidnight(startTime, endTime),
  };
}

function readEmployeeSpec(env: EnvMap, index: 1 | 2 | 3): ProductionEmployeeSpec {
  const prefix = `PROD_EMPLOYEE_${index}`;
  const password = requireEnv(`${prefix}_PASSWORD`, env);
  assertSafeEmployeePassword(password, `${prefix}_PASSWORD`);
  return {
    index,
    fullName: requireEnv(`${prefix}_FULL_NAME`, env),
    employeeCode: requireEnv(`${prefix}_CODE`, env),
    badgeNumber: requireEnv(`${prefix}_BADGE`, env),
    username: requireEnv(`${prefix}_USERNAME`, env),
    password,
    position: requireEnv(`${prefix}_POSITION`, env),
  };
}

function assertDistinctStaffIdentifiers(
  admin: { username: string; employeeCode: string; badgeNumber: string },
  employees: ProductionEmployeeSpec[]
): void {
  const claimed = new Map<string, string>();
  const claim = (kind: string, value: string, owner: string) => {
    const key = `${kind}:${value}`;
    const previous = claimed.get(key);
    if (previous) {
      throw new BootstrapError(`Conflict: ${owner} ${kind} ${value} is already used by ${previous}.`);
    }
    claimed.set(key, owner);
  };

  claim('username', admin.username, 'PROD_ADMIN');
  claim('employeeCode', admin.employeeCode, 'PROD_ADMIN');
  claim('badgeNumber', admin.badgeNumber, 'PROD_ADMIN');
  for (const employee of employees) {
    const owner = `PROD_EMPLOYEE_${employee.index}`;
    claim('username', employee.username, owner);
    claim('employeeCode', employee.employeeCode, owner);
    claim('badgeNumber', employee.badgeNumber, owner);
  }
}

export function readBootstrapInput(env: EnvMap = process.env): BootstrapInput {
  const adminPassword = requireEnv('PROD_ADMIN_PASSWORD', env);
  assertSafeAdminPassword(adminPassword);
  const shift1 = readShiftSpec(env, 1);
  const shift2 = readShiftSpec(env, 2);
  if (shift1.name === shift2.name) {
    throw new BootstrapError('PROD_SHIFT_1_NAME and PROD_SHIFT_2_NAME must be different.');
  }
  const employees: [ProductionEmployeeSpec, ProductionEmployeeSpec, ProductionEmployeeSpec] = [
    readEmployeeSpec(env, 1),
    readEmployeeSpec(env, 2),
    readEmployeeSpec(env, 3),
  ];
  const adminUsername = requireEnv('PROD_ADMIN_USERNAME', env);
  const adminEmployeeCode = requireEnv('PROD_ADMIN_EMPLOYEE_CODE', env);
  const adminBadgeNumber = requireEnv('PROD_ADMIN_BADGE_NUMBER', env);
  assertDistinctStaffIdentifiers(
    { username: adminUsername, employeeCode: adminEmployeeCode, badgeNumber: adminBadgeNumber },
    employees
  );

  return {
    adminUsername,
    adminPassword,
    adminFullName: requireEnv('PROD_ADMIN_FULL_NAME', env),
    adminEmployeeCode,
    adminBadgeNumber,
    projectName: requireEnv('PROD_PROJECT_NAME', env),
    projectCode: requireEnv('PROD_PROJECT_CODE', env),
    projectLocationLabel: requireEnv('PROD_PROJECT_LOCATION_LABEL', env),
    latitude: parseLatitude(requireEnv('PROD_PROJECT_LATITUDE', env)),
    longitude: parseLongitude(requireEnv('PROD_PROJECT_LONGITUDE', env)),
    radiusMeters: parseRadiusMeters(requireEnv('PROD_PROJECT_RADIUS_METERS', env)),
    shifts: [shift1, shift2],
    legacyShift: readLegacyShiftSpec(env),
    terminalName: requireEnv('PROD_TERMINAL_NAME', env),
    terminalSlug: parseTerminalSlug(requireEnv('PROD_TERMINAL_SLUG', env)),
    employees,
  };
}

async function ensureProject(prisma: PrismaClient, input: BootstrapInput) {
  const existing = await prisma.project.findUnique({ where: { code: input.projectCode } });
  if (!existing) {
    const created = await prisma.project.create({
      data: {
        name: input.projectName,
        code: input.projectCode,
        locationLabel: input.projectLocationLabel,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: input.radiusMeters,
      },
    });
    console.log(`Created project ${created.code}`);
    return created;
  }

  if (existing.name !== input.projectName) {
    conflict(
      `Conflict: project code ${input.projectCode} already exists with name=${JSON.stringify(existing.name)}, expected ${JSON.stringify(input.projectName)}.`
    );
  }
  if ((existing.locationLabel ?? '') !== input.projectLocationLabel) {
    conflict(
      `Conflict: project code ${input.projectCode} already exists with a different location label.`
    );
  }
  if (!sameCoord(existing.latitude, input.latitude) || !sameCoord(existing.longitude, input.longitude)) {
    conflict(
      `Conflict: project code ${input.projectCode} already exists with different coordinates.`
    );
  }
  if (existing.radiusMeters !== input.radiusMeters) {
    conflict(
      `Conflict: project code ${input.projectCode} already exists with radiusMeters=${existing.radiusMeters}, expected ${input.radiusMeters}.`
    );
  }
  console.log(`Project ${existing.code} already exists — unchanged.`);
  return existing;
}

async function ensureShift(prisma: PrismaClient, spec: ShiftSpec) {
  const matches = await prisma.shift.findMany({ where: { name: spec.name } });
  if (matches.length > 1) {
    conflict(
      `Conflict: multiple shifts named ${JSON.stringify(spec.name)} already exist. Refusing to guess.`
    );
  }
  const existing = matches[0];
  if (!existing) {
    const created = await prisma.shift.create({
      data: {
        name: spec.name,
        startTime: spec.startTime,
        endTime: spec.endTime,
        crossesMidnight: spec.crossesMidnight,
        gracePeriodMinutes: spec.graceMinutes,
      },
    });
    console.log(
      `Created shift ${created.name} (${created.startTime} → ${created.endTime}, crossesMidnight=${created.crossesMidnight})`
    );
    return created;
  }

  if (
    existing.startTime !== spec.startTime ||
    existing.endTime !== spec.endTime ||
    existing.crossesMidnight !== spec.crossesMidnight ||
    existing.gracePeriodMinutes !== spec.graceMinutes
  ) {
    conflict(
      `Conflict: shift ${JSON.stringify(spec.name)} already exists with different schedule or grace settings. Refusing to change existing records.`
    );
  }
  console.log(`Shift ${existing.name} already exists — unchanged.`);
  return existing;
}

async function runAdminTx<T>(prisma: AdminDb, fn: (tx: AdminDb) => Promise<T>): Promise<T> {
  if (prisma.$transaction) {
    return prisma.$transaction(fn);
  }
  return fn(prisma);
}

function isLegacyAdminPlaceholder(
  employee: { employeeCode: string },
  input: BootstrapInput
): boolean {
  return employee.employeeCode === LEGACY_ADMIN_CODE && input.adminEmployeeCode !== LEGACY_ADMIN_CODE;
}

export async function ensureAdmin(prisma: AdminDb, input: BootstrapInput, projectId: string) {
  const byUsername = await prisma.user.findUnique({
    where: { username: input.adminUsername },
    include: { employee: true },
  });
  const byCode = await prisma.employee.findUnique({
    where: { employeeCode: input.adminEmployeeCode },
    include: { user: true },
  });
  const byBadge = await prisma.employee.findUnique({
    where: { badgeNumber: input.adminBadgeNumber },
    include: { user: true },
  });

  if (byCode && byBadge && byCode.id !== byBadge.id) {
    conflict(
      `Conflict: PROD_ADMIN_EMPLOYEE_CODE and PROD_ADMIN_BADGE_NUMBER refer to different employees.`
    );
  }

  const existingEmployee = byCode ?? byBadge ?? null;

  if (byUsername) {
    if (byUsername.role !== Role.ADMIN) {
      conflict(
        `Conflict: username ${input.adminUsername} already exists with role=${byUsername.role}, expected ADMIN.`
      );
    }
    if (!byUsername.employee) {
      conflict(`Conflict: username ${input.adminUsername} already exists without a linked employee.`);
    }
    if (existingEmployee && byUsername.employee.id !== existingEmployee.id) {
      if (!isLegacyAdminPlaceholder(byUsername.employee, input)) {
        conflict(
          `Conflict: username ${input.adminUsername} is linked to employee ${byUsername.employee.employeeCode}, but ${input.adminEmployeeCode}/${input.adminBadgeNumber} belong to a different employee. Refusing to modify records.`
        );
      }
    }

    const linked = byUsername.employee;
    const alreadyMatches =
      linked.employeeCode === input.adminEmployeeCode &&
      linked.badgeNumber === input.adminBadgeNumber &&
      linked.fullName === input.adminFullName &&
      (!linked.defaultProjectId || linked.defaultProjectId === projectId);

    if (alreadyMatches) {
      const passwordMatches = await bcrypt.compare(input.adminPassword, byUsername.passwordHash);
      if (!passwordMatches) {
        conflict(
          `Conflict: username ${input.adminUsername} already exists with a different password. Refusing to change existing records.`
        );
      }
      console.log(`Admin user ${byUsername.username} already exists — unchanged.`);
      return byUsername;
    }

    if (isLegacyAdminPlaceholder(linked, input)) {
      return reconcileLegacyAdmin(prisma, byUsername, linked, input, projectId, byCode, byBadge);
    }

    assertEmployeeMatches(linked, input, projectId);
    const passwordMatches = await bcrypt.compare(input.adminPassword, byUsername.passwordHash);
    if (!passwordMatches) {
      conflict(
        `Conflict: username ${input.adminUsername} already exists with a different password. Refusing to change existing records.`
      );
    }
    console.log(`Admin user ${byUsername.username} already exists — unchanged.`);
    return byUsername;
  }

  if (existingEmployee?.user) {
    conflict(
      `Conflict: employee ${existingEmployee.employeeCode} already has username ${existingEmployee.user.username}, expected ${input.adminUsername}.`
    );
  }

  if (existingEmployee) {
    assertEmployeeMatches(existingEmployee, input, projectId);
    const createdUser = await prisma.user.create({
      data: {
        username: input.adminUsername,
        passwordHash: await bcrypt.hash(input.adminPassword, 10),
        role: Role.ADMIN,
        employeeId: existingEmployee.id,
      },
    });
    console.log(`Created admin user ${createdUser.username} linked to existing employee ${existingEmployee.employeeCode}.`);
    return createdUser;
  }

  const employee = await prisma.employee.create({
    data: {
      employeeCode: input.adminEmployeeCode,
      badgeNumber: input.adminBadgeNumber,
      fullName: input.adminFullName,
      defaultProjectId: projectId,
    },
  });
  const createdUser = await prisma.user.create({
    data: {
      username: input.adminUsername,
      passwordHash: await bcrypt.hash(input.adminPassword, 10),
      role: Role.ADMIN,
      employeeId: employee.id,
    },
  });
  console.log(`Created admin employee ${employee.employeeCode} and user ${createdUser.username}.`);
  return createdUser;
}

async function reconcileLegacyAdmin(
  prisma: AdminDb,
  user: { id: string; username: string; role: Role },
  employee: { id: string; employeeCode: string; badgeNumber: string; fullName: string },
  input: BootstrapInput,
  projectId: string,
  byCode: { id: string } | null,
  byBadge: { id: string } | null
) {
  if (byCode && byCode.id !== employee.id) {
    conflict(
      `Conflict: PROD_ADMIN_EMPLOYEE_CODE ${input.adminEmployeeCode} is already used by another employee. Refusing to modify records.`
    );
  }
  if (byBadge && byBadge.id !== employee.id) {
    conflict(
      `Conflict: PROD_ADMIN_BADGE_NUMBER ${input.adminBadgeNumber} is already used by another employee. Refusing to modify records.`
    );
  }

  const assignmentCount = await prisma.employeeShiftAssignment.count({
    where: { employeeId: employee.id },
  });
  const attendanceCount = await prisma.attendanceRecord.count({
    where: { employeeId: employee.id },
  });
  if (assignmentCount > 0 || attendanceCount > 0) {
    conflict(
      `Legacy admin employee ${employee.employeeCode} is still in use (${assignmentCount} assignment(s), ${attendanceCount} attendance record(s)). Refusing to modify it.`
    );
  }

  const passwordHash = await bcrypt.hash(input.adminPassword, 10);
  await runAdminTx(prisma, async (tx) => {
    await tx.employee.update({
      where: { id: employee.id },
      data: {
        employeeCode: input.adminEmployeeCode,
        badgeNumber: input.adminBadgeNumber,
        fullName: input.adminFullName,
        defaultProjectId: projectId,
        company: 'Bin Quraya',
      },
    });
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        role: Role.ADMIN,
      },
    });
  });
  console.log('Legacy admin reconciled successfully.');
  return { id: user.id, username: user.username };
}

function assertEmployeeMatches(
  employee: { employeeCode: string; badgeNumber: string; fullName: string; defaultProjectId: string | null },
  input: BootstrapInput,
  projectId: string
) {
  if (employee.employeeCode !== input.adminEmployeeCode) {
    conflict(
      `Conflict: employee already exists with employeeCode=${employee.employeeCode}, expected ${input.adminEmployeeCode}.`
    );
  }
  if (employee.badgeNumber !== input.adminBadgeNumber) {
    conflict(
      `Conflict: employee already exists with badgeNumber=${employee.badgeNumber}, expected ${input.adminBadgeNumber}.`
    );
  }
  if (employee.fullName !== input.adminFullName) {
    conflict(
      `Conflict: employee ${employee.employeeCode} already exists with a different full name.`
    );
  }
  if (employee.defaultProjectId && employee.defaultProjectId !== projectId) {
    conflict(
      `Conflict: employee ${employee.employeeCode} is linked to a different default project.`
    );
  }
}

export async function ensureTerminal(prisma: PrismaClient, input: BootstrapInput, projectId: string) {
  const existing = await prisma.qrTerminal.findUnique({ where: { slug: input.terminalSlug } });
  if (!existing) {
    const created = await prisma.qrTerminal.create({
      data: {
        projectId,
        name: input.terminalName,
        slug: input.terminalSlug,
        secretKey: randomBytes(32).toString('hex'),
        rotationSeconds: 30,
      },
    });
    console.log(`Created terminal ${created.slug} (rotationSeconds=30).`);
    return created;
  }

  if (existing.projectId !== projectId) {
    conflict(
      `Conflict: terminal slug ${input.terminalSlug} already exists on a different project.`
    );
  }
  if (existing.name !== input.terminalName) {
    conflict(
      `Conflict: terminal slug ${input.terminalSlug} already exists with name=${JSON.stringify(existing.name)}, expected ${JSON.stringify(input.terminalName)}.`
    );
  }
  if (existing.rotationSeconds !== 30) {
    conflict(
      `Conflict: terminal slug ${input.terminalSlug} already exists with rotationSeconds=${existing.rotationSeconds}, expected 30.`
    );
  }
  console.log(`Terminal ${existing.slug} already exists — unchanged.`);
  return existing;
}

function isSameAsCurrentShift(
  existing: { name: string; startTime: string; endTime: string },
  shifts: ShiftSpec[]
): boolean {
  return shifts.some(
    (spec) =>
      spec.name === existing.name &&
      spec.startTime === existing.startTime &&
      spec.endTime === existing.endTime
  );
}

export async function retireLegacyShift(prisma: LegacyShiftDb, input: BootstrapInput): Promise<void> {
  const legacy = input.legacyShift;
  if (!legacy) {
    return;
  }

  const matches = await prisma.shift.findMany({ where: { name: legacy.name } });
  if (matches.length === 0) {
    console.log(`Legacy shift ${JSON.stringify(legacy.name)} not found — nothing to do.`);
    return;
  }
  if (matches.length > 1) {
    conflict(
      `Conflict: multiple shifts named ${JSON.stringify(legacy.name)} already exist. Refusing to guess.`
    );
  }

  const existing = matches[0];
  if (legacy.startTime && existing.startTime !== legacy.startTime) {
    conflict(
      `Conflict: legacy shift ${JSON.stringify(legacy.name)} has startTime=${existing.startTime}, expected ${legacy.startTime}. Refusing to modify it.`
    );
  }
  if (legacy.endTime && existing.endTime !== legacy.endTime) {
    conflict(
      `Conflict: legacy shift ${JSON.stringify(legacy.name)} has endTime=${existing.endTime}, expected ${legacy.endTime}. Refusing to modify it.`
    );
  }

  if (isSameAsCurrentShift(existing, input.shifts)) {
    console.log(`Legacy shift ${existing.name} is one of the current production shifts — unchanged.`);
    return;
  }

  const assignmentCount = await prisma.employeeShiftAssignment.count({
    where: { shiftId: existing.id },
  });
  const attendanceCount = await prisma.attendanceRecord.count({
    where: { shiftId: existing.id },
  });

  if (assignmentCount > 0 || attendanceCount > 0) {
    console.warn(
      `WARNING: Legacy shift ${JSON.stringify(existing.name)} is still in use (${assignmentCount} assignment(s), ${attendanceCount} attendance record(s)). Left unchanged.`
    );
    return;
  }

  if (!existing.isActive) {
    console.log(`Legacy shift ${existing.name} is already inactive — unchanged.`);
    return;
  }

  await prisma.shift.update({
    where: { id: existing.id },
    data: { isActive: false },
  });
  console.log(
    `Legacy shift ${existing.name} had no assignments or attendance — set isActive=false.`
  );
}

export const DEMO_EMPLOYEE_CODES = new Set(['EMP-0147', 'EMP-0148', 'EMP-0201']);

export function isClearlyDemoEmployee(employee: {
  employeeCode: string;
  fullName: string;
  user?: { username: string; role: Role } | null;
}): boolean {
  if (employee.user?.role === Role.ADMIN) return false;
  const code = employee.employeeCode.trim().toUpperCase();
  const username = employee.user?.username?.trim().toUpperCase() ?? '';
  if (DEMO_EMPLOYEE_CODES.has(code) || DEMO_EMPLOYEE_CODES.has(username)) return true;
  const name = employee.fullName.trim();
  if (/^Demo Employee(\s|$)/i.test(name)) return true;
  if (/^Demo Supervisor(\s|$)/i.test(name)) return true;
  return false;
}

export type ProductionStaffDb = {
  user: {
    findUnique: (args: {
      where: { username: string };
      include?: { employee: true };
    }) => Promise<{
      id: string;
      username: string;
      passwordHash: string;
      role: Role;
      isActive: boolean;
      employeeId: string | null;
      employee: {
        id: string;
        employeeCode: string;
        badgeNumber: string;
        fullName: string;
        position: string | null;
        company: string;
        isActive: boolean;
        defaultProjectId: string | null;
      } | null;
    } | null>;
    create: (args: {
      data: {
        username: string;
        passwordHash: string;
        role: Role;
        employeeId: string;
        isActive: boolean;
      };
    }) => Promise<{ id: string; username: string }>;
    update: (args: { where: { id: string }; data: { isActive?: boolean } }) => Promise<unknown>;
  };
  employee: {
    findUnique: (args: {
      where: { employeeCode?: string; badgeNumber?: string };
      include?: { user: true };
    }) => Promise<{
      id: string;
      employeeCode: string;
      badgeNumber: string;
      fullName: string;
      position: string | null;
      company: string;
      isActive: boolean;
      defaultProjectId: string | null;
      user?: { id: string; username: string; role: Role; isActive: boolean; passwordHash: string } | null;
    } | null>;
    findMany: (args?: { include?: { user: true } }) => Promise<
      Array<{
        id: string;
        employeeCode: string;
        badgeNumber: string;
        fullName: string;
        isActive: boolean;
        user?: { id: string; username: string; role: Role; isActive: boolean } | null;
      }>
    >;
    create: (args: {
      data: {
        employeeCode: string;
        badgeNumber: string;
        fullName: string;
        position: string;
        company: string;
        defaultProjectId: string;
        isActive: boolean;
      };
    }) => Promise<{ id: string; employeeCode: string }>;
    update: (args: { where: { id: string }; data: { isActive?: boolean } }) => Promise<unknown>;
  };
  employeeShiftAssignment: {
    count: (args: { where: { employeeId?: string } }) => Promise<number>;
    create?: (args: unknown) => Promise<unknown>;
  };
  attendanceRecord: {
    count: (args: { where: { employeeId?: string } }) => Promise<number>;
  };
};

export async function ensureProductionEmployee(
  prisma: ProductionStaffDb,
  spec: ProductionEmployeeSpec,
  projectId: string
): Promise<{ employeeId: string; created: boolean }> {
  const byUsername = await prisma.user.findUnique({
    where: { username: spec.username },
    include: { employee: true },
  });
  const byCode = await prisma.employee.findUnique({
    where: { employeeCode: spec.employeeCode },
    include: { user: true },
  });
  const byBadge = await prisma.employee.findUnique({
    where: { badgeNumber: spec.badgeNumber },
    include: { user: true },
  });

  if (byCode && byBadge && byCode.id !== byBadge.id) {
    conflict(
      `Conflict: PROD_EMPLOYEE_${spec.index} employeeCode and badgeNumber refer to different employees.`
    );
  }

  if (byUsername) {
    if (byUsername.role !== Role.EMPLOYEE) {
      conflict(
        `Conflict: username ${spec.username} already exists with role=${byUsername.role}, expected EMPLOYEE.`
      );
    }
    if (!byUsername.employee) {
      conflict(`Conflict: username ${spec.username} already exists without a linked employee.`);
    }
    const linked = byUsername.employee;
    if (byCode && byCode.id !== linked.id) {
      conflict(
        `Conflict: username ${spec.username} is linked to a different employee than PROD_EMPLOYEE_${spec.index}_CODE.`
      );
    }
    if (byBadge && byBadge.id !== linked.id) {
      conflict(
        `Conflict: username ${spec.username} is linked to a different employee than PROD_EMPLOYEE_${spec.index}_BADGE.`
      );
    }
    if (linked.employeeCode !== spec.employeeCode || linked.badgeNumber !== spec.badgeNumber) {
      conflict(
        `Conflict: username ${spec.username} belongs to employee ${linked.employeeCode}/${linked.badgeNumber}, expected ${spec.employeeCode}/${spec.badgeNumber}.`
      );
    }
    const passwordMatches = await bcrypt.compare(spec.password, byUsername.passwordHash);
    if (!passwordMatches) {
      conflict(
        `Conflict: username ${spec.username} already exists with a different password. Refusing to change existing records.`
      );
    }
    console.log(`Employee ${linked.employeeCode} already exists — unchanged.`);
    return { employeeId: linked.id, created: false };
  }

  const existingEmployee = byCode ?? byBadge ?? null;
  if (existingEmployee?.user) {
    conflict(
      `Conflict: employee ${existingEmployee.employeeCode} already has username ${existingEmployee.user.username}, expected ${spec.username}.`
    );
  }
  if (existingEmployee) {
    if (existingEmployee.employeeCode !== spec.employeeCode || existingEmployee.badgeNumber !== spec.badgeNumber) {
      conflict(
        `Conflict: employee identifiers for PROD_EMPLOYEE_${spec.index} do not match the existing record ${existingEmployee.employeeCode}/${existingEmployee.badgeNumber}.`
      );
    }
    const createdUser = await prisma.user.create({
      data: {
        username: spec.username,
        passwordHash: await bcrypt.hash(spec.password, 10),
        role: Role.EMPLOYEE,
        employeeId: existingEmployee.id,
        isActive: true,
      },
    });
    console.log(`Created employee user ${createdUser.username} linked to existing employee ${existingEmployee.employeeCode}.`);
    return { employeeId: existingEmployee.id, created: false };
  }

  const employee = await prisma.employee.create({
    data: {
      employeeCode: spec.employeeCode,
      badgeNumber: spec.badgeNumber,
      fullName: spec.fullName,
      position: spec.position,
      company: 'Bin Quraya',
      defaultProjectId: projectId,
      isActive: true,
    },
  });
  const createdUser = await prisma.user.create({
    data: {
      username: spec.username,
      passwordHash: await bcrypt.hash(spec.password, 10),
      role: Role.EMPLOYEE,
      employeeId: employee.id,
      isActive: true,
    },
  });
  console.log(`Created employee ${employee.employeeCode} and user ${createdUser.username}.`);
  return { employeeId: employee.id, created: true };
}

export async function ensureProductionEmployees(
  prisma: ProductionStaffDb,
  input: BootstrapInput,
  projectId: string
): Promise<{ created: number; unchanged: number; assignmentCreates: number }> {
  let created = 0;
  let unchanged = 0;
  for (const spec of input.employees) {
    const result = await ensureProductionEmployee(prisma, spec, projectId);
    if (result.created) created += 1;
    else unchanged += 1;
  }
  return { created, unchanged, assignmentCreates: 0 };
}

export async function deactivateUnusedDemoEmployees(prisma: ProductionStaffDb): Promise<{ deactivated: number }> {
  const employees = await prisma.employee.findMany({ include: { user: true } });
  let deactivated = 0;
  for (const employee of employees) {
    if (!isClearlyDemoEmployee(employee)) continue;
    const attendanceCount = await prisma.attendanceRecord.count({
      where: { employeeId: employee.id },
    });
    if (attendanceCount > 0) {
      console.log(
        `Demo employee ${employee.employeeCode} has attendance — left unchanged.`
      );
      continue;
    }
    const userInactive = !employee.user || employee.user.isActive === false;
    if (!employee.isActive && userInactive) {
      continue;
    }
    if (employee.isActive) {
      await prisma.employee.update({
        where: { id: employee.id },
        data: { isActive: false },
      });
    }
    if (employee.user && employee.user.isActive) {
      await prisma.user.update({
        where: { id: employee.user.id },
        data: { isActive: false },
      });
    }
    console.log(`Deactivated demo employee ${employee.employeeCode}.`);
    deactivated += 1;
  }
  return { deactivated };
}

export async function bootstrapProduction(prisma: PrismaClient, input: BootstrapInput): Promise<void> {
  const project = await ensureProject(prisma, input);
  for (const spec of input.shifts) {
    await ensureShift(prisma, spec);
  }
  await ensureAdmin(prisma as unknown as AdminDb, input, project.id);
  await ensureProductionEmployees(prisma as unknown as ProductionStaffDb, input, project.id);
  await ensureTerminal(prisma, input, project.id);
  await retireLegacyShift(prisma, input);
  await deactivateUnusedDemoEmployees(prisma as unknown as ProductionStaffDb);
}

function isExecutedDirectly(): boolean {
  try {
    const self = normalize(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] ? normalize(resolve(process.argv[1])) : '';
    return self.toLowerCase() === invoked.toLowerCase();
  } catch {
    return false;
  }
}

async function main() {
  assertBootstrapAllowed();
  const databaseUrl = requirePostgresUrl(requireEnv('DATABASE_URL'));
  // Use the validated URL without logging it (may contain credentials).
  void databaseUrl;

  const input = readBootstrapInput();
  const prisma = new PrismaClient();
  try {
    await bootstrapProduction(prisma, input);
    console.log('Production bootstrap complete.');
  } finally {
    await prisma.$disconnect();
  }
}

if (isExecutedDirectly()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

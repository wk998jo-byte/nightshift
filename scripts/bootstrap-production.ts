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
    throw new BootstrapError('PROD_SHIFT_START_TIME and PROD_SHIFT_END_TIME cannot be the same.');
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

export function parseGraceMinutes(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new BootstrapError('PROD_SHIFT_GRACE_MINUTES must be a non-negative integer.');
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 180) {
    throw new BootstrapError('PROD_SHIFT_GRACE_MINUTES must be an integer between 0 and 180.');
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
  shiftName: string;
  shiftStartTime: string;
  shiftEndTime: string;
  shiftGraceMinutes: number;
  crossesMidnight: boolean;
  terminalName: string;
  terminalSlug: string;
};

export function readBootstrapInput(env: EnvMap = process.env): BootstrapInput {
  const shiftStartTime = parseHHMM(requireEnv('PROD_SHIFT_START_TIME', env), 'PROD_SHIFT_START_TIME');
  const shiftEndTime = parseHHMM(requireEnv('PROD_SHIFT_END_TIME', env), 'PROD_SHIFT_END_TIME');
  const adminPassword = requireEnv('PROD_ADMIN_PASSWORD', env);
  assertSafeAdminPassword(adminPassword);

  return {
    adminUsername: requireEnv('PROD_ADMIN_USERNAME', env),
    adminPassword,
    adminFullName: requireEnv('PROD_ADMIN_FULL_NAME', env),
    adminEmployeeCode: requireEnv('PROD_ADMIN_EMPLOYEE_CODE', env),
    adminBadgeNumber: requireEnv('PROD_ADMIN_BADGE_NUMBER', env),
    projectName: requireEnv('PROD_PROJECT_NAME', env),
    projectCode: requireEnv('PROD_PROJECT_CODE', env),
    projectLocationLabel: requireEnv('PROD_PROJECT_LOCATION_LABEL', env),
    latitude: parseLatitude(requireEnv('PROD_PROJECT_LATITUDE', env)),
    longitude: parseLongitude(requireEnv('PROD_PROJECT_LONGITUDE', env)),
    radiusMeters: parseRadiusMeters(requireEnv('PROD_PROJECT_RADIUS_METERS', env)),
    shiftName: requireEnv('PROD_SHIFT_NAME', env),
    shiftStartTime,
    shiftEndTime,
    shiftGraceMinutes: parseGraceMinutes(requireEnv('PROD_SHIFT_GRACE_MINUTES', env)),
    crossesMidnight: computeCrossesMidnight(shiftStartTime, shiftEndTime),
    terminalName: requireEnv('PROD_TERMINAL_NAME', env),
    terminalSlug: parseTerminalSlug(requireEnv('PROD_TERMINAL_SLUG', env)),
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

async function ensureShift(prisma: PrismaClient, input: BootstrapInput) {
  const matches = await prisma.shift.findMany({ where: { name: input.shiftName } });
  if (matches.length > 1) {
    conflict(
      `Conflict: multiple shifts named ${JSON.stringify(input.shiftName)} already exist. Refusing to guess.`
    );
  }
  const existing = matches[0];
  if (!existing) {
    const created = await prisma.shift.create({
      data: {
        name: input.shiftName,
        startTime: input.shiftStartTime,
        endTime: input.shiftEndTime,
        crossesMidnight: input.crossesMidnight,
        gracePeriodMinutes: input.shiftGraceMinutes,
      },
    });
    console.log(
      `Created shift ${created.name} (${created.startTime} → ${created.endTime}, crossesMidnight=${created.crossesMidnight})`
    );
    return created;
  }

  if (
    existing.startTime !== input.shiftStartTime ||
    existing.endTime !== input.shiftEndTime ||
    existing.crossesMidnight !== input.crossesMidnight ||
    existing.gracePeriodMinutes !== input.shiftGraceMinutes
  ) {
    conflict(
      `Conflict: shift ${JSON.stringify(input.shiftName)} already exists with different schedule or grace settings. Refusing to change existing records.`
    );
  }
  console.log(`Shift ${existing.name} already exists — unchanged.`);
  return existing;
}

async function ensureAdmin(prisma: PrismaClient, input: BootstrapInput, projectId: string) {
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
      conflict(`Conflict: username ${input.adminUsername} is linked to a different employee.`);
    }
    assertEmployeeMatches(byUsername.employee, input, projectId);
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

async function ensureTerminal(prisma: PrismaClient, input: BootstrapInput, projectId: string) {
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

export async function bootstrapProduction(prisma: PrismaClient, input: BootstrapInput): Promise<void> {
  const project = await ensureProject(prisma, input);
  await ensureShift(prisma, input);
  await ensureAdmin(prisma, input, project.id);
  await ensureTerminal(prisma, input, project.id);
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

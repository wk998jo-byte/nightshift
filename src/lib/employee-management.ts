import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { isDemoEmployeeCode, isDemoEmployeeName } from './demo-employee';

export const PEOPLE_EMPLOYEE_WHERE = {
  user: { role: 'EMPLOYEE' as const },
};

const BN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function canViewPeople(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'HR' || role === 'SUPERVISOR';
}

export function canManagePeople(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'HR';
}

export type EmployeeWriteError = {
  ok: false;
  status: number;
  error: string;
};

export type PublicUser = {
  username: string;
  role: string;
  isActive: boolean;
};

export type PublicSupervisor = {
  id: string;
  fullName: string;
  employeeCode: string;
  badgeNumber: string;
};

export type PublicProject = {
  id: string;
  name: string;
  code: string;
};

export type PublicEmployee = {
  id: string;
  employeeCode: string;
  badgeNumber: string;
  fullName: string;
  mobile: string | null;
  department: string | null;
  position: string | null;
  company: string;
  defaultProjectId: string | null;
  defaultProject: PublicProject | null;
  supervisorId: string | null;
  supervisor: PublicSupervisor | null;
  isActive: boolean;
  createdAt: string;
  hasPhoto: boolean;
  photoUpdatedAt: string | null;
  user: PublicUser | null;
};

const optionalText = (max: number) =>
  z.preprocess((value) => {
    if (value == null || value === '') return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
  }, z.string().max(max).nullable());

const optionalId = z.preprocess((value) => {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}, z.string().min(1).nullable());

export const employeeCreateSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required').max(120),
    bn: z
      .string()
      .trim()
      .min(1, 'BN is required')
      .max(32)
      .regex(BN_RE, 'BN must be letters, numbers, hyphen, or underscore'),
    mobile: optionalText(40),
    position: optionalText(80),
    department: optionalText(80),
    defaultProjectId: optionalId,
    supervisorId: optionalId,
    isActive: z.boolean().optional().default(true),
    password: z.string().min(8, 'Password must be at least 8 characters').max(200),
    confirmPassword: z.string().min(1, 'Confirm the password'),
  })
  .refine((row) => row.password === row.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const employeeUpdateSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(120),
  bn: z
    .string()
    .trim()
    .min(1, 'BN is required')
    .max(32)
    .regex(BN_RE, 'BN must be letters, numbers, hyphen, or underscore'),
  mobile: optionalText(40).optional().nullable(),
  position: optionalText(80).optional().nullable(),
  department: optionalText(80).optional().nullable(),
  defaultProjectId: optionalId.optional().nullable(),
  supervisorId: optionalId.optional().nullable(),
  isActive: z.boolean(),
});

export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;
export type EmployeeUpdateInput = z.infer<typeof employeeUpdateSchema>;

export function parseEmployeeCreate(body: unknown): EmployeeWriteError | { ok: true; data: EmployeeCreateInput } {
  const parsed = employeeCreateSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, error: parsed.error.issues[0]?.message || 'Invalid employee' };
  }
  return { ok: true, data: parsed.data };
}

export function parseEmployeeUpdate(body: unknown): EmployeeWriteError | { ok: true; data: EmployeeUpdateInput } {
  const parsed = employeeUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, error: parsed.error.issues[0]?.message || 'Invalid employee' };
  }
  return { ok: true, data: parsed.data };
}

export function includePeopleEmployee(person: {
  fullName: string;
  employeeCode: string;
  user?: { role: string } | null;
}): boolean {
  if (isDemoEmployeeCode(person.employeeCode) || isDemoEmployeeName(person.fullName)) return false;
  if (person.user && person.user.role !== 'EMPLOYEE') return false;
  return true;
}

export function publicUser(user: { username?: string; role?: string; isActive?: boolean; passwordHash?: string } | null | undefined): PublicUser | null {
  if (!user) return null;
  return {
    username: user.username || '',
    role: user.role || 'EMPLOYEE',
    isActive: user.isActive !== false,
  };
}

export function toPublicEmployee(row: {
  id: string;
  employeeCode: string;
  badgeNumber: string;
  fullName: string;
  mobile?: string | null;
  department?: string | null;
  position?: string | null;
  company?: string | null;
  defaultProjectId?: string | null;
  defaultProject?: PublicProject | null;
  supervisorId?: string | null;
  supervisor?: PublicSupervisor | null;
  isActive: boolean;
  createdAt: Date | string;
  photo?: { updatedAt?: Date | string } | null;
  hasPhoto?: boolean;
  user?: { username?: string; role?: string; isActive?: boolean; passwordHash?: string } | null;
}): PublicEmployee {
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  const photoUpdatedAt = row.photo?.updatedAt
    ? row.photo.updatedAt instanceof Date
      ? row.photo.updatedAt.toISOString()
      : String(row.photo.updatedAt)
    : null;
  const json = JSON.stringify({
    id: row.id,
    employeeCode: row.employeeCode,
    badgeNumber: row.badgeNumber,
    fullName: row.fullName,
    mobile: row.mobile ?? null,
    department: row.department ?? null,
    position: row.position ?? null,
    company: row.company || 'Bin Quraya',
    defaultProjectId: row.defaultProjectId ?? null,
    defaultProject: row.defaultProject
      ? { id: row.defaultProject.id, name: row.defaultProject.name, code: row.defaultProject.code }
      : null,
    supervisorId: row.supervisorId ?? null,
    supervisor: row.supervisor
      ? {
          id: row.supervisor.id,
          fullName: row.supervisor.fullName,
          employeeCode: row.supervisor.employeeCode,
          badgeNumber: row.supervisor.badgeNumber,
        }
      : null,
    isActive: row.isActive,
    createdAt,
    hasPhoto: Boolean(row.hasPhoto || row.photo),
    photoUpdatedAt,
    user: publicUser(row.user),
  });
  if (/password/i.test(json) || json.includes('passwordHash')) {
    throw new Error('Refusing to serialize employee secrets');
  }
  return JSON.parse(json) as PublicEmployee;
}

export function employeeJsonHasSecrets(value: unknown): boolean {
  const raw = JSON.stringify(value);
  return /passwordHash|"password"\s*:/i.test(raw) || /"data"\s*:\s*\[/.test(raw);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002');
}

export type EmployeeManagementDb = {
  $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
  employee: {
    findUnique: (args: any) => Promise<any>;
    findFirst: (args: any) => Promise<any>;
    findMany: (args?: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  user: {
    findUnique: (args: any) => Promise<any>;
    findFirst?: (args: any) => Promise<any>;
    create: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
  project: {
    findUnique: (args: any) => Promise<any>;
  };
  employeePhoto?: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    delete: (args: any) => Promise<any>;
    deleteMany?: (args: any) => Promise<any>;
  };
  auditLog: {
    create: (args: any) => Promise<any>;
  };
  attendanceRecord?: {
    update?: (args: any) => Promise<any>;
    updateMany?: (args: any) => Promise<any>;
  };
};

export type EmployeeAuditInput = {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  employeeId?: string;
  oldValue?: unknown;
  newValue?: unknown;
};

export function assertManagedEmployeeRole(user: { role?: string } | null | undefined): EmployeeWriteError | { ok: true } {
  if (!user) return { ok: false, status: 409, error: 'Employee has no login account' };
  if (user.role !== 'EMPLOYEE') {
    return { ok: false, status: 403, error: 'This account cannot be managed from People' };
  }
  return { ok: true };
}

export async function writeEmployeeManagementAudit(
  tx: { auditLog: { create: (args: any) => Promise<any> } },
  input: EmployeeAuditInput
) {
  if (employeeJsonHasSecrets({ oldValue: input.oldValue, newValue: input.newValue })) {
    throw new Error('Refusing to audit employee secrets');
  }
  await tx.auditLog.create({
    data: {
      actorId: input.actorId || null,
      action: input.action,
      entityType: input.entityType || 'Employee',
      entityId: input.entityId,
      employeeId: input.employeeId,
      oldValue: input.oldValue != null ? JSON.stringify(input.oldValue) : null,
      newValue: input.newValue != null ? JSON.stringify(input.newValue) : null,
    },
  });
}

async function loadSupervisor(
  db: EmployeeManagementDb,
  supervisorId: string | null,
  selfId?: string
): Promise<{ ok: true; supervisor: PublicSupervisor | null } | EmployeeWriteError> {
  if (!supervisorId) return { ok: true, supervisor: null };
  if (selfId && supervisorId === selfId) {
    return { ok: false, status: 400, error: 'An employee cannot supervise themselves' };
  }
  const supervisor = await db.employee.findUnique({
    where: { id: supervisorId },
    select: { id: true, fullName: true, employeeCode: true, badgeNumber: true, isActive: true },
  });
  if (!supervisor) return { ok: false, status: 400, error: 'Supervisor not found' };
  return {
    ok: true,
    supervisor: {
      id: supervisor.id,
      fullName: supervisor.fullName,
      employeeCode: supervisor.employeeCode,
      badgeNumber: supervisor.badgeNumber,
    },
  };
}

async function loadProject(
  db: EmployeeManagementDb,
  projectId: string | null
): Promise<{ ok: true; project: PublicProject | null } | EmployeeWriteError> {
  if (!projectId) return { ok: true, project: null };
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, code: true },
  });
  if (!project) return { ok: false, status: 400, error: 'Project not found' };
  return { ok: true, project };
}

async function assertBnAvailable(
  db: EmployeeManagementDb,
  bn: string,
  exceptEmployeeId?: string
): Promise<EmployeeWriteError | { ok: true }> {
  const [byCode, byBadge, byUsername] = await Promise.all([
    db.employee.findFirst({ where: { employeeCode: bn } }),
    db.employee.findFirst({ where: { badgeNumber: bn } }),
    db.user.findUnique({ where: { username: bn } }),
  ]);
  if (byCode && byCode.id !== exceptEmployeeId) {
    return { ok: false, status: 409, error: 'An employee with this BN already exists' };
  }
  if (byBadge && byBadge.id !== exceptEmployeeId) {
    return { ok: false, status: 409, error: 'An employee with this BN already exists' };
  }
  if (byUsername && byUsername.employeeId !== exceptEmployeeId) {
    return { ok: false, status: 409, error: 'An employee with this BN already exists' };
  }
  return { ok: true };
}

export async function createManagedEmployee(input: {
  db: EmployeeManagementDb;
  actorId: string;
  data: EmployeeCreateInput;
  hashPassword?: (password: string) => Promise<string>;
}): Promise<{ ok: true; employee: PublicEmployee } | EmployeeWriteError> {
  const project = await loadProject(input.db, input.data.defaultProjectId);
  if (!project.ok) return project;
  const supervisor = await loadSupervisor(input.db, input.data.supervisorId);
  if (!supervisor.ok) return supervisor;
  const available = await assertBnAvailable(input.db, input.data.bn);
  if (!available.ok) return available;

  const hashPassword = input.hashPassword || ((password: string) => bcrypt.hash(password, 10));
  const passwordHash = await hashPassword(input.data.password);

  try {
    const created = await input.db.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          employeeCode: input.data.bn,
          badgeNumber: input.data.bn,
          fullName: input.data.fullName,
          mobile: input.data.mobile,
          position: input.data.position,
          department: input.data.department,
          company: 'Bin Quraya',
          defaultProjectId: input.data.defaultProjectId,
          supervisorId: input.data.supervisorId,
          isActive: input.data.isActive,
        },
      });
      const user = await tx.user.create({
        data: {
          username: input.data.bn,
          passwordHash,
          role: 'EMPLOYEE',
          employeeId: employee.id,
          isActive: input.data.isActive,
        },
      });
      await writeEmployeeManagementAudit(tx, {
        actorId: input.actorId,
        action: 'EMPLOYEE_CREATED',
        entityType: 'Employee',
        entityId: employee.id,
        employeeId: employee.id,
        newValue: {
          employeeId: employee.id,
          employeeCode: employee.employeeCode,
          employeeName: employee.fullName,
          passwordSet: true,
        },
      });
      return { employee, user };
    });

    const publicEmployee = toPublicEmployee({
      ...created.employee,
      defaultProject: project.project,
      supervisor: supervisor.supervisor,
      user: created.user,
      hasPhoto: false,
    });

    return { ok: true, employee: publicEmployee };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { ok: false, status: 409, error: 'An employee with this BN already exists' };
    }
    throw error;
  }
}

export async function updateManagedEmployee(input: {
  db: EmployeeManagementDb;
  actorId: string;
  employeeId: string;
  data: EmployeeUpdateInput;
}): Promise<{ ok: true; employee: PublicEmployee } | EmployeeWriteError> {
  const existing = await input.db.employee.findUnique({
    where: { id: input.employeeId },
    include: {
      user: true,
      defaultProject: { select: { id: true, name: true, code: true } },
      photo: { select: { updatedAt: true } },
    },
  });
  if (!existing) return { ok: false, status: 404, error: 'Employee not found' };
  const roleOk = assertManagedEmployeeRole(existing.user);
  if (!roleOk.ok) return roleOk;

  const project = await loadProject(input.db, input.data.defaultProjectId ?? null);
  if (!project.ok) return project;
  const supervisor = await loadSupervisor(input.db, input.data.supervisorId ?? null, existing.id);
  if (!supervisor.ok) return supervisor;

  const bnChanged = input.data.bn !== existing.employeeCode || input.data.bn !== existing.badgeNumber;
  if (bnChanged || input.data.bn !== existing.user.username) {
    const available = await assertBnAvailable(input.db, input.data.bn, existing.id);
    if (!available.ok) return available;
  }

  const previousHash = existing.user.passwordHash;
  const statusChanged = existing.isActive !== input.data.isActive;
  const previous = {
    employeeCode: existing.employeeCode,
    employeeName: existing.fullName,
    mobile: existing.mobile || null,
    position: existing.position || null,
    department: existing.department || null,
    defaultProjectId: existing.defaultProjectId || null,
    supervisorId: existing.supervisorId || null,
    isActive: existing.isActive,
  };

  try {
    const updated = await input.db.$transaction(async (tx) => {
      const employee = await tx.employee.update({
        where: { id: existing.id },
        data: {
          employeeCode: input.data.bn,
          badgeNumber: input.data.bn,
          fullName: input.data.fullName,
          mobile: input.data.mobile ?? null,
          position: input.data.position ?? null,
          department: input.data.department ?? null,
          defaultProjectId: input.data.defaultProjectId ?? null,
          supervisorId: input.data.supervisorId ?? null,
          isActive: input.data.isActive,
        },
      });
      const user = await tx.user.update({
        where: { id: existing.user.id },
        data: {
          username: input.data.bn,
          isActive: input.data.isActive,
        },
      });
      if (user.passwordHash !== previousHash) {
        throw new Error('Employee update must not change the password');
      }
      const changed: string[] = [];
      if (previous.employeeName !== input.data.fullName) changed.push('fullName');
      if (previous.employeeCode !== input.data.bn) changed.push('bn');
      if (previous.mobile !== (input.data.mobile ?? null)) changed.push('mobile');
      if (previous.position !== (input.data.position ?? null)) changed.push('position');
      if (previous.department !== (input.data.department ?? null)) changed.push('department');
      if (previous.defaultProjectId !== (input.data.defaultProjectId ?? null)) changed.push('defaultProjectId');
      if (previous.supervisorId !== (input.data.supervisorId ?? null)) changed.push('supervisorId');
      if (statusChanged) changed.push('isActive');
      await writeEmployeeManagementAudit(tx, {
        actorId: input.actorId,
        action: statusChanged ? 'EMPLOYEE_STATUS_CHANGED' : 'EMPLOYEE_UPDATED',
        entityType: 'Employee',
        entityId: existing.id,
        employeeId: existing.id,
        oldValue: {
          employeeCode: previous.employeeCode,
          employeeName: previous.employeeName,
          isActive: previous.isActive,
          defaultProjectId: previous.defaultProjectId,
          supervisorId: previous.supervisorId,
        },
        newValue: {
          employeeCode: employee.employeeCode,
          employeeName: employee.fullName,
          isActive: employee.isActive,
          defaultProjectId: employee.defaultProjectId,
          supervisorId: employee.supervisorId,
          changedFields: changed,
          ...(previous.employeeCode !== input.data.bn
            ? { oldBn: previous.employeeCode, newBn: input.data.bn }
            : {}),
        },
      });
      return { employee, user };
    });

    const publicEmployee = toPublicEmployee({
      ...updated.employee,
      defaultProject: project.project,
      supervisor: supervisor.supervisor,
      user: updated.user,
      photo: existing.photo,
    });

    return { ok: true, employee: publicEmployee };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { ok: false, status: 409, error: 'An employee with this BN already exists' };
    }
    throw error;
  }
}

export async function replaceManagedEmployeePhoto(input: {
  db: EmployeeManagementDb;
  actorId: string;
  employeeId: string;
  data: Uint8Array;
  mimeType: string;
}): Promise<{ ok: true; mimeType: string } | EmployeeWriteError> {
  const employee = await input.db.employee.findUnique({
    where: { id: input.employeeId },
    include: { user: { select: { role: true } } },
  });
  if (!employee) return { ok: false, status: 404, error: 'Employee not found' };
  const roleOk = assertManagedEmployeeRole(employee.user);
  if (!roleOk.ok) return roleOk;
  if (!input.db.employeePhoto) return { ok: false, status: 500, error: 'Photo storage is unavailable' };

  await input.db.$transaction(async (tx) => {
    await tx.employeePhoto.upsert({
      where: { employeeId: input.employeeId },
      create: { employeeId: input.employeeId, data: input.data, mimeType: input.mimeType },
      update: { data: input.data, mimeType: input.mimeType },
    });
    await writeEmployeeManagementAudit(tx, {
      actorId: input.actorId,
      action: 'EMPLOYEE_PHOTO_UPDATED',
      entityType: 'Employee',
      entityId: input.employeeId,
      employeeId: input.employeeId,
      newValue: {
        employeeId: input.employeeId,
        employeeCode: employee.employeeCode,
        employeeName: employee.fullName,
        mimeType: input.mimeType,
      },
    });
  });
  return { ok: true, mimeType: input.mimeType };
}

export async function removeManagedEmployeePhoto(input: {
  db: EmployeeManagementDb;
  actorId: string;
  employeeId: string;
}): Promise<{ ok: true } | EmployeeWriteError> {
  const employee = await input.db.employee.findUnique({
    where: { id: input.employeeId },
    include: { user: { select: { role: true } } },
  });
  if (!employee) return { ok: false, status: 404, error: 'Employee not found' };
  const roleOk = assertManagedEmployeeRole(employee.user);
  if (!roleOk.ok) return roleOk;
  if (!input.db.employeePhoto) return { ok: false, status: 500, error: 'Photo storage is unavailable' };

  await input.db.$transaction(async (tx) => {
    if (tx.employeePhoto.deleteMany) {
      await tx.employeePhoto.deleteMany({ where: { employeeId: input.employeeId } });
    } else {
      await tx.employeePhoto.delete({ where: { employeeId: input.employeeId } });
    }
    await writeEmployeeManagementAudit(tx, {
      actorId: input.actorId,
      action: 'EMPLOYEE_PHOTO_REMOVED',
      entityType: 'Employee',
      entityId: input.employeeId,
      employeeId: input.employeeId,
      newValue: {
        employeeId: input.employeeId,
        employeeCode: employee.employeeCode,
        employeeName: employee.fullName,
      },
    });
  });
  return { ok: true };
}

export async function attachSupervisors(
  db: EmployeeManagementDb,
  rows: Array<{ supervisorId?: string | null }>
): Promise<Map<string, PublicSupervisor>> {
  const ids = [...new Set(rows.map((row) => row.supervisorId).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const supervisors = await db.employee.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true, employeeCode: true, badgeNumber: true },
  });
  return new Map(
    supervisors.map((row) => [
      row.id,
      {
        id: row.id,
        fullName: row.fullName,
        employeeCode: row.employeeCode,
        badgeNumber: row.badgeNumber,
      },
    ])
  );
}

export function filterPeopleSearch(
  employees: PublicEmployee[],
  query: string,
  status: 'ALL' | 'ACTIVE' | 'INACTIVE' = 'ALL'
): PublicEmployee[] {
  const needle = query.trim().toLowerCase();
  return employees.filter((row) => {
    if (status === 'ACTIVE' && !row.isActive) return false;
    if (status === 'INACTIVE' && row.isActive) return false;
    if (!needle) return true;
    return [row.fullName, row.badgeNumber, row.employeeCode, row.position, row.department]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { listExportableEmployees } from './attendance-export';
import { employeeInitials } from './employee-identity';
import {
  PEOPLE_EMPLOYEE_WHERE,
  canManagePeople,
  canViewPeople,
  createManagedEmployee,
  employeeJsonHasSecrets,
  filterPeopleSearch,
  includePeopleEmployee,
  parseEmployeeCreate,
  parseEmployeeUpdate,
  toPublicEmployee,
  updateManagedEmployee,
  type EmployeeManagementDb,
} from './employee-management';
import {
  MAX_EMPLOYEE_PHOTO_BYTES,
  detectAllowedImageKind,
  normalizeEmployeePhoto,
  validateEmployeePhotoUpload,
} from './employee-photo';
import { SHIFT_SCHEDULE_EMPLOYEE_WHERE, isShiftScheduleEmployee } from './shift-catalog';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeDb() {
  const employees: any[] = [];
  const users: any[] = [];
  const projects: any[] = [
    { id: 'proj-1', name: 'Riyadh Night Site', code: 'HQ-01' },
  ];
  const photos: any[] = [];
  const attendance: any[] = [
    { id: 'att-1', employeeId: 'e-az', projectId: 'proj-old', workedMinutes: 720 },
  ];
  let attendanceWrites = 0;

  function uniqueOrThrow(check: boolean) {
    if (check) {
      const error = new Error('Unique constraint failed');
      (error as any).code = 'P2002';
      throw error;
    }
  }

  const api: EmployeeManagementDb & { attendanceWrites: () => number; seed: (row: any, user?: any) => void } = {
    attendanceWrites: () => attendanceWrites,
    seed(row, user) {
      employees.push(row);
      if (user) users.push(user);
    },
    async $transaction(fn) {
      const snap = {
        employees: clone(employees),
        users: clone(users),
        photos: clone(photos),
        attendance: clone(attendance),
      };
      try {
        return await fn(api);
      } catch (error) {
        employees.splice(0, employees.length, ...snap.employees);
        users.splice(0, users.length, ...snap.users);
        photos.splice(0, photos.length, ...snap.photos);
        attendance.splice(0, attendance.length, ...snap.attendance);
        throw error;
      }
    },
    employee: {
      async findUnique(args: any) {
        return employees.find((row) => row.id === args.where.id) || null;
      },
      async findFirst(args: any) {
        if (args.where.employeeCode) return employees.find((row) => row.employeeCode === args.where.employeeCode) || null;
        if (args.where.badgeNumber) return employees.find((row) => row.badgeNumber === args.where.badgeNumber) || null;
        return null;
      },
      async findMany(args: any = {}) {
        const ids = args.where?.id?.in;
        if (ids) return employees.filter((row) => ids.includes(row.id));
        return employees;
      },
      async create(args: any) {
        uniqueOrThrow(employees.some((row) => row.employeeCode === args.data.employeeCode || row.badgeNumber === args.data.badgeNumber));
        const row = { id: `e-${args.data.employeeCode}`, createdAt: new Date('2026-10-10T00:00:00.000Z'), company: 'Bin Quraya', ...args.data };
        employees.push(row);
        return row;
      },
      async update(args: any) {
        const row = employees.find((item) => item.id === args.where.id);
        if (!row) throw new Error('missing');
        uniqueOrThrow(
          employees.some(
            (item) =>
              item.id !== row.id &&
              (item.employeeCode === args.data.employeeCode || item.badgeNumber === args.data.badgeNumber)
          )
        );
        Object.assign(row, args.data);
        return row;
      },
    },
    user: {
      async findUnique(args: any) {
        if (args.where.username) return users.find((row) => row.username === args.where.username) || null;
        if (args.where.id) return users.find((row) => row.id === args.where.id) || null;
        return null;
      },
      async create(args: any) {
        uniqueOrThrow(users.some((row) => row.username === args.data.username));
        const row = { id: `u-${args.data.username}`, ...args.data };
        users.push(row);
        return row;
      },
      async update(args: any) {
        const row = users.find((item) => item.id === args.where.id);
        if (!row) throw new Error('missing user');
        uniqueOrThrow(users.some((item) => item.id !== row.id && item.username === args.data.username));
        Object.assign(row, args.data);
        return row;
      },
    },
    project: {
      async findUnique(args: any) {
        return projects.find((row) => row.id === args.where.id) || null;
      },
    },
    employeePhoto: {
      async findUnique(args: any) {
        return photos.find((row) => row.employeeId === args.where.employeeId) || null;
      },
      async upsert(args: any) {
        const existing = photos.find((row) => row.employeeId === args.where.employeeId);
        if (existing) Object.assign(existing, args.update, { updatedAt: new Date() });
        else photos.push({ ...args.create, updatedAt: new Date() });
        return photos.find((row) => row.employeeId === args.where.employeeId);
      },
      async delete(args: any) {
        const index = photos.findIndex((row) => row.employeeId === args.where.employeeId);
        if (index >= 0) photos.splice(index, 1);
      },
    },
    attendanceRecord: {
      async update() {
        attendanceWrites += 1;
      },
      async updateMany() {
        attendanceWrites += 1;
        return { count: 0 };
      },
    },
  };

  return { db: api, employees, users, photos, attendance };
}

const baseCreate = {
  fullName: 'New Night Employee',
  bn: '71400',
  mobile: '0500000000',
  position: 'Operator',
  department: 'Operations',
  defaultProjectId: 'proj-1',
  supervisorId: null,
  isActive: true,
  password: 'NightPass1',
  confirmPassword: 'NightPass1',
};

describe('people authorization', () => {
  it('ADMIN and HR can create/edit; SUPERVISOR is read-only', () => {
    assert.equal(canManagePeople('ADMIN'), true);
    assert.equal(canManagePeople('HR'), true);
    assert.equal(canManagePeople('SUPERVISOR'), false);
    assert.equal(canViewPeople('SUPERVISOR'), true);
    assert.equal(canViewPeople('EMPLOYEE'), false);
    assert.equal(canManagePeople(null), false);
  });

  it('unauthenticated create is rejected by missing session/role', () => {
    assert.equal(canManagePeople(undefined), false);
    assert.equal(canViewPeople(''), false);
  });
});

describe('employee create', () => {
  it('ADMIN can create an employee with linked EMPLOYEE user and BN identity', async () => {
    const { db, attendance } = makeDb();
    const audits: any[] = [];
    const result = await createManagedEmployee({
      db,
      actorId: 'admin-1',
      data: baseCreate,
      writeAudit: async (row) => {
        audits.push(row);
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.employee.employeeCode, '71400');
    assert.equal(result.employee.badgeNumber, '71400');
    assert.equal(result.employee.user?.username, '71400');
    assert.equal(result.employee.user?.role, 'EMPLOYEE');
    assert.equal(result.employee.hasPhoto, false);
    assert.equal(employeeJsonHasSecrets(result.employee), false);
    assert.equal(audits[0].action, 'EMPLOYEE_CREATED');
    assert.equal(audits[0].newValue.passwordSet, true);
    assert.equal(JSON.stringify(audits).includes('NightPass1'), false);
    assert.equal(JSON.stringify(audits[0]).includes('passwordHash'), false);
    assert.equal(attendance[0].projectId, 'proj-old');
  });

  it('HR can create; SUPERVISOR cannot manage', async () => {
    assert.equal(canManagePeople('HR'), true);
    assert.equal(canManagePeople('SUPERVISOR'), false);
    const { db } = makeDb();
    const result = await createManagedEmployee({
      db,
      actorId: 'hr-1',
      data: { ...baseCreate, bn: '71401', password: 'NightPass1', confirmPassword: 'NightPass1' },
      writeAudit: async () => undefined,
    });
    assert.equal(result.ok, true);
  });

  it('password is bcrypt-hashed and plaintext is not returned', async () => {
    const { db, users } = makeDb();
    const result = await createManagedEmployee({
      db,
      actorId: 'admin-1',
      data: baseCreate,
      writeAudit: async () => undefined,
    });
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes('NightPass1'), false);
    assert.equal(await bcrypt.compare('NightPass1', users[0].passwordHash), true);
    assert.notEqual(users[0].passwordHash, 'NightPass1');
  });

  it('duplicate BN is rejected with 409', async () => {
    const { db } = makeDb();
    await createManagedEmployee({ db, actorId: 'a', data: baseCreate, writeAudit: async () => undefined });
    const second = await createManagedEmployee({
      db,
      actorId: 'a',
      data: { ...baseCreate, fullName: 'Other' },
      writeAudit: async () => undefined,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.status, 409);
  });

  it('transaction prevents a leftover Employee when User creation fails', async () => {
    const { db, employees, users } = makeDb();
    const originalCreate = db.user.create;
    db.user.create = async () => {
      throw new Error('user failed');
    };
    await assert.rejects(() =>
      createManagedEmployee({ db, actorId: 'a', data: baseCreate, writeAudit: async () => undefined })
    );
    assert.equal(employees.length, 0);
    assert.equal(users.length, 0);
    db.user.create = originalCreate;
  });
});

describe('employee edit', () => {
  async function seeded() {
    const ctx = makeDb();
    const hash = await bcrypt.hash('KeepOldPass1', 10);
    ctx.db.seed(
      {
        id: 'e-az',
        employeeCode: '71326',
        badgeNumber: '71326',
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        company: 'Bin Quraya',
        defaultProjectId: 'proj-1',
        supervisorId: null,
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        user: { id: 'u-az', username: '71326', passwordHash: hash, role: 'EMPLOYEE', isActive: true, employeeId: 'e-az' },
      },
      { id: 'u-az', username: '71326', passwordHash: hash, role: 'EMPLOYEE', isActive: true, employeeId: 'e-az' }
    );
    ctx.employees[0].user = ctx.users[0];
    return ctx;
  }

  it('ADMIN/HR can edit and SUPERVISOR cannot', () => {
    assert.equal(canManagePeople('ADMIN'), true);
    assert.equal(canManagePeople('HR'), true);
    assert.equal(canManagePeople('SUPERVISOR'), false);
  });

  it('BN change synchronizes employeeCode, badgeNumber, and username', async () => {
    const { db, users, attendance } = await seeded();
    const result = await updateManagedEmployee({
      db,
      actorId: 'admin-1',
      employeeId: 'e-az',
      data: {
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        bn: '71399',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        defaultProjectId: 'proj-1',
        supervisorId: null,
        isActive: true,
      },
      writeAudit: async () => undefined,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.employee.employeeCode, '71399');
    assert.equal(result.employee.badgeNumber, '71399');
    assert.equal(result.employee.user?.username, '71399');
    assert.equal(users[0].username, '71399');
    assert.equal(await bcrypt.compare('KeepOldPass1', users[0].passwordHash), true);
    assert.equal(attendance[0].projectId, 'proj-old');
    assert.equal(db.attendanceWrites(), 0);
  });

  it('BN conflict rolls back and edit does not change password', async () => {
    const { db, users } = await seeded();
    db.seed(
      {
        id: 'e-other',
        employeeCode: '71343',
        badgeNumber: '71343',
        fullName: 'Other',
        isActive: true,
        createdAt: new Date(),
      },
      { id: 'u-other', username: '71343', passwordHash: 'x', role: 'EMPLOYEE', isActive: true, employeeId: 'e-other' }
    );
    const beforeHash = users[0].passwordHash;
    const result = await updateManagedEmployee({
      db,
      actorId: 'admin-1',
      employeeId: 'e-az',
      data: {
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        bn: '71343',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        defaultProjectId: 'proj-1',
        supervisorId: null,
        isActive: true,
      },
      writeAudit: async () => undefined,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
    assert.equal(users[0].username, '71326');
    assert.equal(users[0].passwordHash, beforeHash);
  });

  it('deactivate and reactivate synchronize Employee and User', async () => {
    const { db, employees, users } = await seeded();
    const off = await updateManagedEmployee({
      db,
      actorId: 'admin-1',
      employeeId: 'e-az',
      data: {
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        bn: '71326',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        defaultProjectId: 'proj-1',
        supervisorId: null,
        isActive: false,
      },
      writeAudit: async () => undefined,
    });
    assert.equal(off.ok, true);
    assert.equal(employees[0].isActive, false);
    assert.equal(users[0].isActive, false);
    const on = await updateManagedEmployee({
      db,
      actorId: 'admin-1',
      employeeId: 'e-az',
      data: {
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        bn: '71326',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        defaultProjectId: 'proj-1',
        supervisorId: null,
        isActive: true,
      },
      writeAudit: async () => undefined,
    });
    assert.equal(on.ok, true);
    assert.equal(employees[0].isActive, true);
    assert.equal(users[0].isActive, true);
  });

  it('rejects self-supervisor, invalid supervisor, and invalid project', async () => {
    const { db } = await seeded();
    const self = await updateManagedEmployee({
      db,
      actorId: 'a',
      employeeId: 'e-az',
      data: {
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        bn: '71326',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        defaultProjectId: 'proj-1',
        supervisorId: 'e-az',
        isActive: true,
      },
      writeAudit: async () => undefined,
    });
    assert.equal(self.ok, false);
    const badSup = await updateManagedEmployee({
      db,
      actorId: 'a',
      employeeId: 'e-az',
      data: {
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        bn: '71326',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        defaultProjectId: 'proj-1',
        supervisorId: 'missing',
        isActive: true,
      },
      writeAudit: async () => undefined,
    });
    assert.equal(badSup.ok, false);
    const badProj = await updateManagedEmployee({
      db,
      actorId: 'a',
      employeeId: 'e-az',
      data: {
        fullName: 'Abdulaziz Abdullah H AlZahrani',
        bn: '71326',
        mobile: null,
        position: 'Operator',
        department: 'Operations',
        defaultProjectId: 'no-project',
        supervisorId: null,
        isActive: true,
      },
      writeAudit: async () => undefined,
    });
    assert.equal(badProj.ok, false);
  });
});

describe('people list and compatibility', () => {
  it('People list can include inactive employees and export/schedule filters stay intact', () => {
    const inactive = toPublicEmployee({
      id: 'e-off',
      employeeCode: '71378',
      badgeNumber: '71378',
      fullName: 'Turki Daher M AlShammari',
      isActive: false,
      createdAt: new Date(),
      user: { username: '71378', role: 'EMPLOYEE', isActive: false },
    });
    const demo = {
      fullName: 'Demo Employee',
      employeeCode: 'EMP-0147',
      user: { role: 'EMPLOYEE' as const, isActive: true },
    };
    assert.equal(filterPeopleSearch([inactive], '', 'ALL').length, 1);
    assert.equal(filterPeopleSearch([inactive], '', 'INACTIVE').length, 1);
    assert.equal(includePeopleEmployee(demo), false);
    assert.equal(includePeopleEmployee({ fullName: 'Admin', employeeCode: 'ADMIN', user: { role: 'ADMIN' } }), false);
    assert.deepEqual(PEOPLE_EMPLOYEE_WHERE, { user: { role: 'EMPLOYEE' } });
    assert.equal(SHIFT_SCHEDULE_EMPLOYEE_WHERE.isActive, true);
    assert.equal(SHIFT_SCHEDULE_EMPLOYEE_WHERE.user.isActive, true);
    assert.equal(
      isShiftScheduleEmployee({ isActive: false, user: { role: 'EMPLOYEE', isActive: false } }),
      false
    );
    assert.equal(
      listExportableEmployees([
        { id: 'e-off', fullName: inactive.fullName, employeeCode: '71378', badgeNumber: '71378', isActive: false, user: { role: 'EMPLOYEE', isActive: false } },
        { id: 'demo', fullName: 'Demo Employee', employeeCode: 'EMP-0147', user: { role: 'EMPLOYEE', isActive: true } },
      ]).map((row) => row.employeeCode).join(','),
      '71378'
    );
    assert.equal(employeeInitials(inactive.fullName), 'TA');
  });

  it('public employee JSON never includes passwordHash or photo bytes', () => {
    const json = toPublicEmployee({
      id: 'e1',
      employeeCode: '71400',
      badgeNumber: '71400',
      fullName: 'New Night Employee',
      isActive: true,
      createdAt: new Date(),
      user: { username: '71400', role: 'EMPLOYEE', isActive: true, passwordHash: 'SECRET' },
      photo: { updatedAt: new Date() },
    });
    assert.equal(json.hasPhoto, true);
    assert.equal(employeeJsonHasSecrets(json), false);
    assert.equal(JSON.stringify(json).includes('SECRET'), false);
    assert.equal(JSON.stringify(json).includes('passwordHash'), false);
  });

  it('create validation requires matching 8+ character passwords and keeps BN zeros', () => {
    const short = parseEmployeeCreate({ ...baseCreate, password: 'short', confirmPassword: 'short' });
    assert.equal(short.ok, false);
    const mismatch = parseEmployeeCreate({ ...baseCreate, confirmPassword: 'other' });
    assert.equal(mismatch.ok, false);
    const zeros = parseEmployeeCreate({ ...baseCreate, bn: '071400', password: 'NightPass1', confirmPassword: 'NightPass1' });
    assert.equal(zeros.ok, true);
    if (zeros.ok) assert.equal(zeros.data.bn, '071400');
    const update = parseEmployeeUpdate({
      fullName: 'A',
      bn: '71326',
      isActive: true,
    });
    assert.equal(update.ok, true);
  });
});

describe('employee photo validation', () => {
  async function image(format: 'jpeg' | 'png' | 'webp', size = 40) {
    return sharp({ create: { width: size, height: size, channels: 3, background: '#c8102e' } })[format]().toBuffer();
  }

  it('accepts JPEG, PNG, and WebP and rejects SVG/non-image/oversize', async () => {
    const jpeg = await image('jpeg');
    const png = await image('png');
    const webp = await image('webp');
    assert.equal(validateEmployeePhotoUpload(jpeg).ok, true);
    assert.equal(validateEmployeePhotoUpload(png).ok, true);
    assert.equal(validateEmployeePhotoUpload(webp).ok, true);
    assert.equal(detectAllowedImageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(validateEmployeePhotoUpload(Buffer.from('<svg></svg>')).ok, false);
    assert.equal(validateEmployeePhotoUpload(Buffer.from('not-an-image')).ok, false);
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_EMPLOYEE_PHOTO_BYTES)]);
    assert.equal(validateEmployeePhotoUpload(huge).ok, false);
    assert.equal(canManagePeople('SUPERVISOR'), false);
  });

  it('normalizes photos to a small square WebP and replace/remove work', async () => {
    const original = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#111827' },
    })
      .jpeg()
      .toBuffer();
    const normalized = await normalizeEmployeePhoto(original);
    assert.equal(normalized.mimeType, 'image/webp');
    const info = await sharp(normalized.data).metadata();
    assert.equal(info.format, 'webp');
    assert.equal(info.width, 512);
    assert.equal(info.height, 512);
    assert.ok(normalized.data.length < original.length);

    const { db, photos } = makeDb();
    await db.employeePhoto!.upsert({
      where: { employeeId: 'e-az' },
      create: { employeeId: 'e-az', data: normalized.data, mimeType: normalized.mimeType },
      update: { data: normalized.data, mimeType: normalized.mimeType },
    });
    assert.equal((await db.employeePhoto!.findUnique({ where: { employeeId: 'e-az' } })).mimeType, 'image/webp');
    await db.employeePhoto!.upsert({
      where: { employeeId: 'e-az' },
      create: { employeeId: 'e-az', data: Buffer.from('x'), mimeType: 'image/webp' },
      update: { data: Buffer.from('replaced'), mimeType: 'image/webp' },
    });
    assert.equal(photos[0].data.toString(), 'replaced');
    await db.employeePhoto!.delete({ where: { employeeId: 'e-az' } });
    assert.equal(await db.employeePhoto!.findUnique({ where: { employeeId: 'e-az' } }), null);
    assert.equal(employeeInitials('Abdulaziz Abdullah H AlZahrani'), 'AA');
  });
});

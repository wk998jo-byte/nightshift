const DEMO_EMPLOYEE_CODES = new Set(['EMP-0147', 'EMP-0148', 'EMP-0201']);

export function isDemoEmployeeCode(code: string | null | undefined): boolean {
  return DEMO_EMPLOYEE_CODES.has((code || '').trim().toUpperCase());
}

export function isDemoEmployeeName(name: string | null | undefined): boolean {
  const n = (name || '').trim();
  return /^Demo Employee(\s|$)/i.test(n) || /^Demo Supervisor(\s|$)/i.test(n);
}

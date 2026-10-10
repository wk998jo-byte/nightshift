'use client';

import { BrandButton, EmployeeAvatar, StatusChip, Surface } from '@/components/ui';
import type { PublicEmployee } from '@/lib/employee-management';

function photoSrc(employee: PublicEmployee): string | null {
  if (!employee.hasPhoto) return null;
  return `/api/employees/${employee.id}/photo${employee.photoUpdatedAt ? `?t=${encodeURIComponent(employee.photoUpdatedAt)}` : ''}`;
}

export default function EmployeeDetailsDrawer({
  open,
  employee,
  onClose,
}: {
  open: boolean;
  employee: PublicEmployee | null;
  onClose: () => void;
}) {
  if (!open || !employee) return null;
  const created = employee.createdAt ? new Date(employee.createdAt).toLocaleDateString() : '—';

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center">
      <button className="absolute inset-0 cursor-default" aria-label="Close employee" onClick={onClose} />
      <Surface className="relative z-10 w-full max-w-md shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">People</p>
            <h3 className="text-lg font-bold text-slate-900">Employee</h3>
          </div>
          <BrandButton variant="ghost" className="!px-3 !py-2" onClick={onClose}>
            Close
          </BrandButton>
        </div>
        <div className="flex items-start gap-3">
          <EmployeeAvatar
            name={employee.fullName}
            badge={employee.badgeNumber || employee.employeeCode}
            size="lg"
            photoSrc={photoSrc(employee)}
          />
          <div className="min-w-0">
            <p className="font-bold text-slate-900">{employee.fullName}</p>
            <p className="text-sm font-semibold text-[#C8102E]">BN# {employee.badgeNumber}</p>
            <div className="mt-2">
              <StatusChip tone={employee.isActive ? 'ok' : 'danger'}>
                {employee.isActive ? 'Active' : 'Inactive'}
              </StatusChip>
            </div>
          </div>
        </div>
        <dl className="mt-4 space-y-2 text-sm">
          <Row label="Username" value={employee.user?.username || '—'} />
          <Row label="Mobile" value={employee.mobile || '—'} />
          <Row label="Position" value={employee.position || '—'} />
          <Row label="Department" value={employee.department || '—'} />
          <Row
            label="Default Project"
            value={
              employee.defaultProject
                ? `${employee.defaultProject.name} (${employee.defaultProject.code})`
                : '—'
            }
          />
          <Row label="Supervisor" value={employee.supervisor?.fullName || '—'} />
          <Row label="Status" value={employee.isActive ? 'Active' : 'Inactive'} />
          <Row label="Created" value={created} />
        </dl>
      </Surface>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-900">{value}</dd>
    </div>
  );
}

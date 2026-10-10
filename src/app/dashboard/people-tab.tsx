'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrandButton, EmployeeAvatar, StatusChip, Surface } from '@/components/ui';
import { canManagePeople, filterPeopleSearch, type PublicEmployee } from '@/lib/employee-management';
import EmployeeDetailsDrawer from './employee-details-drawer';
import EmployeeFormDrawer from './employee-form-drawer';

type ProjectOption = { id: string; name: string; code: string };

function photoSrc(employee: PublicEmployee): string | null {
  if (!employee.hasPhoto) return null;
  return `/api/employees/${employee.id}/photo${employee.photoUpdatedAt ? `?t=${encodeURIComponent(employee.photoUpdatedAt)}` : ''}`;
}

export default function PeopleTab({ role }: { role: string }) {
  const canManage = canManagePeople(role);
  const [employees, setEmployees] = useState<PublicEmployee[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<PublicEmployee | null>(null);
  const [editing, setEditing] = useState<PublicEmployee | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [peopleRes, projectRes] = await Promise.all([
        fetch('/api/employees?activeOnly=0', { credentials: 'include', cache: 'no-store' }),
        fetch('/api/projects', { credentials: 'include', cache: 'no-store' }),
      ]);
      const peopleJson = await peopleRes.json().catch(() => ({}));
      const projectJson = await projectRes.json().catch(() => ({}));
      if (!peopleRes.ok) {
        setError(peopleJson.error || 'Could not load employees');
        setEmployees([]);
        return;
      }
      setEmployees(peopleJson.employees || []);
      setProjects(
        (projectJson.projects || []).map((p: { id: string; name: string; code: string }) => ({
          id: p.id,
          name: p.name,
          code: p.code,
        }))
      );
    } catch {
      setError('Could not load employees');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => filterPeopleSearch(employees, query, status),
    [employees, query, status]
  );
  const supervisorOptions = useMemo(
    () => employees.filter((row) => row.isActive || (editing && row.id === editing.supervisorId)),
    [employees, editing]
  );

  return (
    <section className="space-y-4">
      <Surface>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">People</h2>
            <p className="mt-1 text-sm text-slate-500">Manage employee profiles and access.</p>
          </div>
          {canManage ? (
            <BrandButton className="!px-4 !py-2" onClick={() => setCreating(true)}>
              + Add Employee
            </BrandButton>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, BN, position, department"
            className="min-w-[240px] flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
          />
          <div className="flex rounded-xl bg-slate-100 p-1 text-sm font-semibold">
            {(['ALL', 'ACTIVE', 'INACTIVE'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatus(value)}
                className={`rounded-lg px-3 py-1.5 ${status === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
              >
                {value === 'ALL' ? 'All' : value === 'ACTIVE' ? 'Active' : 'Inactive'}
              </button>
            ))}
          </div>
        </div>
        {notice ? <p className="mt-3 text-sm text-emerald-700">{notice}</p> : null}
        {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
      </Surface>

      {loading ? <p className="text-sm text-slate-500">Loading employees…</p> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((employee) => (
          <div
            key={employee.id}
            className="flex h-full flex-col rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <EmployeeAvatar
                name={employee.fullName}
                badge={employee.badgeNumber || employee.employeeCode}
                size="lg"
                photoSrc={photoSrc(employee)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-slate-900">{employee.fullName}</p>
                    <p className="mt-0.5 text-sm font-semibold text-[#C8102E]">
                      BN# {employee.badgeNumber || employee.employeeCode}
                    </p>
                  </div>
                  <StatusChip tone={employee.isActive ? 'ok' : 'danger'}>
                    {employee.isActive ? 'Active' : 'Inactive'}
                  </StatusChip>
                </div>
              </div>
            </div>
            <div className="mt-3 grid flex-1 grid-cols-2 gap-2 text-sm">
              <div>
                <p className="text-xs text-slate-500">Position</p>
                <p className="font-medium text-slate-800">{employee.position || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Department</p>
                <p className="font-medium text-slate-800">{employee.department || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Project</p>
                <p className="font-medium text-slate-800">{employee.defaultProject?.name || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Mobile</p>
                <p className="font-medium text-slate-800">{employee.mobile || '—'}</p>
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <BrandButton variant="secondary" className="flex-1 !py-2" onClick={() => setViewing(employee)}>
                View
              </BrandButton>
              {canManage ? (
                <BrandButton variant="ghost" className="flex-1 !py-2" onClick={() => setEditing(employee)}>
                  Edit
                </BrandButton>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {!loading && visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No matching employees</p>
      ) : null}

      <EmployeeDetailsDrawer open={!!viewing} employee={viewing} onClose={() => setViewing(null)} />
      <EmployeeFormDrawer
        open={creating || !!editing}
        mode={creating ? 'create' : 'edit'}
        employee={editing}
        projects={projects}
        supervisors={supervisorOptions}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={() => {
          setNotice(creating ? 'Employee created.' : 'Employee updated.');
          void load();
        }}
      />
    </section>
  );
}

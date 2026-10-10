'use client';

import { useEffect, useState } from 'react';
import { BrandButton, EmployeeAvatar, Surface } from '@/components/ui';
import type { PublicEmployee } from '@/lib/employee-management';

type ProjectOption = { id: string; name: string; code: string };

export default function EmployeeFormDrawer({
  open,
  mode,
  employee,
  projects,
  supervisors,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  employee: PublicEmployee | null;
  projects: ProjectOption[];
  supervisors: PublicEmployee[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState('');
  const [bn, setBn] = useState('');
  const [mobile, setMobile] = useState('');
  const [position, setPosition] = useState('');
  const [department, setDepartment] = useState('');
  const [defaultProjectId, setDefaultProjectId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
    setPhotoFile(null);
    setRemovePhoto(false);
    setPassword('');
    setConfirmPassword('');
    if (mode === 'edit' && employee) {
      setFullName(employee.fullName);
      setBn(employee.badgeNumber || employee.employeeCode);
      setMobile(employee.mobile || '');
      setPosition(employee.position || '');
      setDepartment(employee.department || '');
      setDefaultProjectId(employee.defaultProjectId || '');
      setSupervisorId(employee.supervisorId || '');
      setIsActive(employee.isActive);
      setPhotoPreview(
        employee.hasPhoto
          ? `/api/employees/${employee.id}/photo${employee.photoUpdatedAt ? `?t=${encodeURIComponent(employee.photoUpdatedAt)}` : ''}`
          : null
      );
    } else {
      setFullName('');
      setBn('');
      setMobile('');
      setPosition('');
      setDepartment('');
      setDefaultProjectId('');
      setSupervisorId('');
      setIsActive(true);
      setPhotoPreview(null);
    }
  }, [open, mode, employee]);

  function onPickPhoto(file: File | null) {
    setPhotoFile(file);
    setRemovePhoto(false);
    if (!file) {
      setPhotoPreview(
        mode === 'edit' && employee?.hasPhoto
          ? `/api/employees/${employee.id}/photo`
          : null
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhotoPreview(String(reader.result || ''));
    reader.readAsDataURL(file);
  }

  async function save() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const payload = {
        fullName,
        bn,
        mobile,
        position,
        department,
        defaultProjectId: defaultProjectId || null,
        supervisorId: supervisorId || null,
        isActive,
        ...(mode === 'create' ? { password, confirmPassword } : {}),
      };
      const res = await fetch(mode === 'create' ? '/api/employees' : `/api/employees/${employee!.id}`, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || 'Could not save employee');
        return;
      }
      const id = json.employee?.id as string;
      if (photoFile && id) {
        const photoRes = await fetch(`/api/employees/${id}/photo`, {
          method: 'PUT',
          credentials: 'include',
          body: photoFile,
        });
        if (!photoRes.ok) {
          const photoJson = await photoRes.json().catch(() => ({}));
          setError(photoJson.error || 'Employee saved, but photo upload failed');
          onSaved();
          return;
        }
      } else if (mode === 'edit' && removePhoto && employee) {
        await fetch(`/api/employees/${employee.id}/photo`, {
          method: 'DELETE',
          credentials: 'include',
        });
      }
      setPassword('');
      setConfirmPassword('');
      onSaved();
      onClose();
    } catch {
      setError('Could not save employee');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center">
      <button className="absolute inset-0 cursor-default" aria-label="Close form" onClick={onClose} />
      <Surface className="relative z-10 max-h-[92vh] w-full max-w-lg overflow-y-auto shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">People</p>
            <h3 className="text-lg font-bold text-slate-900">
              {mode === 'create' ? 'Add Employee' : 'Edit Employee'}
            </h3>
          </div>
          <BrandButton variant="ghost" className="!px-3 !py-2" onClick={onClose}>
            Close
          </BrandButton>
        </div>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <EmployeeAvatar
              name={fullName || 'New Employee'}
              badge={bn || 'BN'}
              size="lg"
              photoSrc={removePhoto ? null : photoPreview}
            />
            <div className="flex flex-wrap gap-2">
              <label className="cursor-pointer rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                {photoPreview && !removePhoto ? 'Replace Photo' : 'Upload Photo'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => onPickPhoto(e.target.files?.[0] || null)}
                />
              </label>
              {photoPreview && !removePhoto ? (
                <BrandButton
                  variant="ghost"
                  className="!px-3 !py-2"
                  onClick={() => {
                    setPhotoFile(null);
                    setPhotoPreview(null);
                    setRemovePhoto(true);
                  }}
                >
                  Remove Photo
                </BrandButton>
              ) : null}
            </div>
          </div>
          <Field label="Full Name" value={fullName} onChange={setFullName} required />
          <Field label="BN" value={bn} onChange={setBn} required />
          <Field label="Mobile" value={mobile} onChange={setMobile} />
          <Field label="Position" value={position} onChange={setPosition} />
          <Field label="Department" value={department} onChange={setDepartment} />
          <label className="block text-sm font-medium text-slate-600">
            Default Project
            <select
              value={defaultProjectId}
              onChange={(e) => setDefaultProjectId(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
            >
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Supervisor
            <select
              value={supervisorId}
              onChange={(e) => setSupervisorId(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
            >
              <option value="">None</option>
              {supervisors
                .filter((row) => !employee || row.id !== employee.id)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.fullName} — {row.badgeNumber}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Status
            <select
              value={isActive ? 'active' : 'inactive'}
              onChange={(e) => setIsActive(e.target.value === 'active')}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          {mode === 'create' ? (
            <>
              <Field label="Initial Password" value={password} onChange={setPassword} type="password" required />
              <Field
                label="Confirm Password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                type="password"
                required
              />
            </>
          ) : (
            <p className="text-xs text-slate-500">Password is not changed from this form.</p>
          )}
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
          <BrandButton disabled={busy} className="w-full" onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </BrandButton>
        </div>
      </Surface>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-sm font-medium text-slate-600">
      {label}
      <input
        type={type}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
      />
    </label>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { BrandButton, Surface } from '@/components/ui';
import {
  exportDownloadUrl,
  exportEmployeeLabel,
  exportFilename,
  validateExportForm,
  type ExportEmployeeOption,
} from '@/lib/attendance-export';

export default function ExportAttendanceDrawer({
  open,
  defaultDate,
  onClose,
}: {
  open: boolean;
  defaultDate: string;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(defaultDate);
  const [to, setTo] = useState(defaultDate);
  const [employeeId, setEmployeeId] = useState('');
  const [employees, setEmployees] = useState<ExportEmployeeOption[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingEmployees, setLoadingEmployees] = useState(false);

  useEffect(() => {
    if (!open) return;
    const seed = defaultDate || '';
    setFrom(seed);
    setTo(seed);
    setEmployeeId('');
    setError('');
    setLoadingEmployees(true);
    fetch('/api/employees?scope=export', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Could not load employees');
        setEmployees(json.employees || []);
      })
      .catch(() => {
        setEmployees([]);
        setError('Could not load employees');
      })
      .finally(() => setLoadingEmployees(false));
  }, [open, defaultDate]);

  async function download() {
    setError('');
    const invalid = validateExportForm(from, to);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    try {
      const selected = employees.find((row) => row.id === employeeId) || null;
      const res = await fetch(exportDownloadUrl(from, to, { employeeId: employeeId || undefined }), {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || 'Export failed');
        return;
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = exportFilename(from, to, {
        employeeCode: selected ? selected.badgeNumber || selected.employeeCode : undefined,
      });
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      onClose();
    } catch {
      setError('Export failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center">
      <button className="absolute inset-0 cursor-default" aria-label="Close export" onClick={onClose} />
      <Surface className="relative z-10 w-full max-w-md shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">Attendance</p>
            <h3 className="text-lg font-bold text-slate-900">Attendance Export</h3>
            <p className="mt-1 text-sm text-slate-500">Exports detailed attendance and period totals.</p>
          </div>
          <BrandButton variant="ghost" className="!px-3 !py-2" onClick={onClose}>
            Close
          </BrandButton>
        </div>
        <div className="space-y-3">
          <label className="block text-sm font-medium text-slate-600">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
            />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
            />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Employee
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              disabled={loadingEmployees}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
            >
              <option value="">All Employees</option>
              {employees.map((row) => (
                <option key={row.id} value={row.id}>
                  {exportEmployeeLabel(row)}
                </option>
              ))}
            </select>
          </label>
          {loadingEmployees ? <p className="text-sm text-slate-500">Loading employees…</p> : null}
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
          <BrandButton disabled={busy || !from || !to} className="w-full" onClick={() => void download()}>
            {busy ? 'Preparing…' : 'Download CSV'}
          </BrandButton>
        </div>
      </Surface>
    </div>
  );
}

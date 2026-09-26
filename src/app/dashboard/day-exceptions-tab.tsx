'use client';

import { useCallback, useEffect, useState } from 'react';
import { BrandButton, Surface } from '@/components/ui';

type EmployeeRow = { id: string; fullName: string; employeeCode: string; badgeNumber?: string };
type ExceptionRow = {
  id: string;
  workDate: string;
  employeeId: string | null;
  type: string;
  reason: string | null;
  expectedStartTime: string | null;
  expectedEndTime: string | null;
  expectedWorkMinutes: number | null;
  employee?: { fullName: string; employeeCode: string } | null;
};

const EXCEPTION_TYPES = [
  ['HOLIDAY', 'Holiday'],
  ['ABSENT', 'Absent'],
  ['NEW', 'New'],
  ['SICK_LEAVE', 'Sick Leave'],
  ['UMRA_LEAVE', 'Umra Leave'],
  ['HALF_DAY', 'Half Day'],
  ['EMERGENCY_VACATION', 'Emergency Vacation'],
  ['VACATION', 'Vacation'],
  ['RELEASED', 'Released'],
] as const;

export default function DayExceptionsTab() {
  const today = new Date().toISOString().slice(0, 10);
  const [workDate, setWorkDate] = useState(today);
  const [scope, setScope] = useState<'HOLIDAY' | 'EMPLOYEE'>('HOLIDAY');
  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState('HOLIDAY');
  const [reason, setReason] = useState('');
  const [expectedStartTime, setExpectedStartTime] = useState('');
  const [expectedEndTime, setExpectedEndTime] = useState('');
  const [expectedWorkMinutes, setExpectedWorkMinutes] = useState('');
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const [corrEmployeeId, setCorrEmployeeId] = useState('');
  const [corrDate, setCorrDate] = useState(today);
  const [corrChoice, setCorrChoice] = useState('SHIFT_1');
  const [corrIn, setCorrIn] = useState('');
  const [corrOut, setCorrOut] = useState('');
  const [corrReason, setCorrReason] = useState('Punching Issue');

  const load = useCallback(async (date: string) => {
    const res = await fetch(`/api/day-exceptions?date=${encodeURIComponent(date)}`);
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error || 'Unable to load exceptions');
      return;
    }
    setEmployees(data.employees || []);
    setExceptions(data.exceptions || []);
  }, []);

  useEffect(() => {
    void load(workDate);
  }, [load, workDate]);

  async function saveException() {
    setBusy(true);
    setMsg('');
    const res = await fetch('/api/day-exceptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workDate,
        scope,
        type: scope === 'HOLIDAY' ? 'HOLIDAY' : type,
        employeeId: scope === 'EMPLOYEE' ? employeeId : null,
        reason,
        expectedStartTime: type === 'HALF_DAY' ? expectedStartTime : null,
        expectedEndTime: type === 'HALF_DAY' ? expectedEndTime : null,
        expectedWorkMinutes: type === 'HALF_DAY' && expectedWorkMinutes ? Number(expectedWorkMinutes) : null,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg(data.error || 'Save failed');
      return;
    }
    setMsg('Saved successfully.');
    setReason('');
    await load(workDate);
  }

  async function removeException(id: string) {
    if (!confirm('Remove this day exception?')) return;
    const res = await fetch(`/api/day-exceptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error || 'Remove failed');
      return;
    }
    setMsg('Exception removed.');
    await load(workDate);
  }

  async function saveCorrection() {
    setBusy(true);
    setMsg('');
    const res = await fetch('/api/attendance/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: corrEmployeeId,
        workDate: corrDate,
        choice: corrChoice,
        checkInAt: corrIn,
        checkOutAt: corrOut,
        reason: corrReason,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setMsg(data.error || 'Correction failed');
      return;
    }
    setMsg('Attendance correction saved.');
  }

  return (
    <div className="space-y-6">
      <Surface>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">Day Status / Exception</p>
        <h2 className="mb-4 text-lg font-bold text-slate-900">Approved leave and holidays</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm font-medium text-slate-600">
            Date
            <input
              type="date"
              value={workDate}
              onChange={(e) => setWorkDate(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-medium text-slate-600">
            Scope
            <select
              value={scope}
              onChange={(e) => {
                const next = e.target.value as 'HOLIDAY' | 'EMPLOYEE';
                setScope(next);
                if (next === 'HOLIDAY') setType('HOLIDAY');
              }}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="HOLIDAY">All employees / Holiday</option>
              <option value="EMPLOYEE">Specific Employee</option>
            </select>
          </label>
          {scope === 'EMPLOYEE' ? (
            <label className="text-sm font-medium text-slate-600">
              Employee
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="">Select employee</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName} · {emp.employeeCode}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {scope === 'EMPLOYEE' ? (
            <label className="text-sm font-medium text-slate-600">
              Type
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                {EXCEPTION_TYPES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="text-sm font-medium text-slate-600 md:col-span-2">
            Reason / Note
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              placeholder="Optional note"
            />
          </label>
          {scope === 'EMPLOYEE' && type === 'HALF_DAY' ? (
            <>
              <label className="text-sm font-medium text-slate-600">
                Expected start
                <input
                  type="time"
                  value={expectedStartTime}
                  onChange={(e) => setExpectedStartTime(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-sm font-medium text-slate-600">
                Expected end
                <input
                  type="time"
                  value={expectedEndTime}
                  onChange={(e) => setExpectedEndTime(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="text-sm font-medium text-slate-600 md:col-span-2">
                Expected working minutes
                <input
                  type="number"
                  min={1}
                  value={expectedWorkMinutes}
                  onChange={(e) => setExpectedWorkMinutes(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                  placeholder="Use if start/end are not set"
                />
              </label>
            </>
          ) : null}
        </div>
        <div className="mt-4">
          <BrandButton disabled={busy} onClick={() => void saveException()}>
            Save
          </BrandButton>
        </div>
        <div className="mt-5 overflow-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="pb-2">Date</th>
                <th className="pb-2">Scope</th>
                <th className="pb-2">Type</th>
                <th className="pb-2">Note</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((row) => (
                <tr key={row.id} className="border-b border-slate-50">
                  <td className="py-2">{row.workDate}</td>
                  <td className="py-2">
                    {row.employee ? `${row.employee.fullName} · ${row.employee.employeeCode}` : 'All employees'}
                  </td>
                  <td className="py-2 font-semibold">{row.type}</td>
                  <td className="py-2 text-slate-500">{row.reason || '—'}</td>
                  <td className="py-2 text-right">
                    <button className="text-xs font-semibold text-rose-600" onClick={() => void removeException(row.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>

      <Surface>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">
          Attendance Correction / Punching Issue
        </p>
        <h2 className="mb-4 text-lg font-bold text-slate-900">Correct missed IN/OUT</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm font-medium text-slate-600">
            Employee
            <select
              value={corrEmployeeId}
              onChange={(e) => setCorrEmployeeId(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Select employee</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.fullName} · {emp.employeeCode}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-600">
            Date
            <input
              type="date"
              value={corrDate}
              onChange={(e) => setCorrDate(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-medium text-slate-600">
            Shift
            <select
              value={corrChoice}
              onChange={(e) => setCorrChoice(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="SHIFT_1">Shift 1 · 15:30 → 03:30</option>
              <option value="SHIFT_2">Shift 2 · 19:30 → 07:30</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-600">
            Reason
            <input
              value={corrReason}
              onChange={(e) => setCorrReason(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-medium text-slate-600">
            IN
            <input
              type="datetime-local"
              value={corrIn}
              onChange={(e) => setCorrIn(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-medium text-slate-600">
            OUT
            <input
              type="datetime-local"
              value={corrOut}
              onChange={(e) => setCorrOut(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="mt-4">
          <BrandButton disabled={busy} onClick={() => void saveCorrection()}>
            Save correction
          </BrandButton>
        </div>
      </Surface>
      {msg ? <p className="text-sm font-medium text-slate-600">{msg}</p> : null}
    </div>
  );
}

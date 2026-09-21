'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BrandButton, EmployeeAvatar, Surface } from '@/components/ui';

type ShiftInfo = { id: string; name: string; startTime: string; endTime: string } | null;
type Choice = 'SHIFT_1' | 'SHIFT_2' | 'OFF' | '';
type Mode = 'today' | 'week' | 'month';

type EmployeeRow = {
  id: string;
  fullName: string;
  employeeCode: string;
  badgeNumber: string;
};

type AssignmentRow = {
  id: string;
  employeeId: string;
  workDate: string;
  choice: Choice;
  hasAttendance: boolean;
};

function addDays(iso: string, n: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function addMonths(iso: string, n: number) {
  const [y, m] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return dt.toISOString().slice(0, 10);
}

function choiceClass(choice: Choice) {
  if (choice === 'SHIFT_1') return 'bg-sky-50 text-sky-800 border-sky-200';
  if (choice === 'SHIFT_2') return 'bg-violet-50 text-violet-800 border-violet-200';
  if (choice === 'OFF') return 'bg-slate-100 text-slate-600 border-slate-200';
  return 'bg-white text-slate-500 border-slate-200';
}

function shiftLabel(shifts: { SHIFT_1: ShiftInfo; SHIFT_2: ShiftInfo }, choice: Choice) {
  if (choice === 'SHIFT_1' && shifts.SHIFT_1) {
    return `SHIFT 1 — ${shifts.SHIFT_1.startTime} → ${shifts.SHIFT_1.endTime}`;
  }
  if (choice === 'SHIFT_2' && shifts.SHIFT_2) {
    return `SHIFT 2 — ${shifts.SHIFT_2.startTime} → ${shifts.SHIFT_2.endTime}`;
  }
  if (choice === 'OFF') return 'OFF';
  return '—';
}

function formatError(
  err: { employeeId: string; workDate: string; error: string; employeeName?: string },
  employees: EmployeeRow[]
) {
  const name = err.employeeName || employees.find((e) => e.id === err.employeeId)?.fullName || err.employeeId;
  return `${name} · ${err.workDate}: ${err.error}`;
}

export default function ShiftScheduleTab() {
  const [mode, setMode] = useState<Mode>('today');
  const [today, setToday] = useState('');
  const [anchor, setAnchor] = useState('');
  const [dates, setDates] = useState<string[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [shifts, setShifts] = useState<{ SHIFT_1: ShiftInfo; SHIFT_2: ShiftInfo }>({
    SHIFT_1: null,
    SHIFT_2: null,
  });
  const [grid, setGrid] = useState<Record<string, Choice>>({});
  const [locked, setLocked] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const keyFor = (employeeId: string, workDate: string) => `${employeeId}:${workDate}`;

  const load = useCallback(async (start: string, end: string) => {
    const res = await fetch(`/api/schedule?start=${start}&end=${end}`, { credentials: 'include' });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error || 'Failed to load schedule');
      return data;
    }
    setToday(data.today);
    setEmployees(data.employees || []);
    setShifts(data.shifts);
    const nextGrid: Record<string, Choice> = {};
    const nextLocked: Record<string, boolean> = {};
    for (const a of (data.assignments || []) as AssignmentRow[]) {
      nextGrid[keyFor(a.employeeId, a.workDate)] = a.choice;
      nextLocked[keyFor(a.employeeId, a.workDate)] = a.hasAttendance;
    }
    setGrid(nextGrid);
    setLocked(nextLocked);
    return data;
  }, []);

  useEffect(() => {
    void fetch('/api/schedule', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => {
        setToday(data.today);
        setAnchor(data.today);
        void load(data.today, data.today);
      });
  }, [load]);

  useEffect(() => {
    if (!anchor) return;
    if (mode === 'today') {
      void load(anchor, anchor);
    } else if (mode === 'week') {
      void fetch(`/api/schedule?start=${anchor}&end=${anchor}`, { credentials: 'include' })
        .then((r) => r.json())
        .then(async (data) => {
          const start = data.weekStart;
          const end = data.weekDates[data.weekDates.length - 1];
          await load(start, end);
          setDates(data.weekDates);
        });
    } else {
      void fetch(`/api/schedule?start=${anchor}&end=${anchor}`, { credentials: 'include' })
        .then((r) => r.json())
        .then(async (data) => {
          await load(data.monthStart, data.monthEnd);
          setDates(data.monthDates);
        });
    }
  }, [mode, anchor, load]);

  function setChoice(employeeId: string, workDate: string, choice: Choice) {
    const key = keyFor(employeeId, workDate);
    if (locked[key]) {
      setMsg('Attendance already exists for this date. Use attendance adjustment workflow.');
      return;
    }
    setGrid((g) => ({ ...g, [key]: choice }));
  }

  async function save(workDates: string[]) {
    setBusy(true);
    setMsg('');
    const items = employees.flatMap((e) =>
      workDates
        .map((workDate) => ({
          employeeId: e.id,
          workDate,
          choice: grid[keyFor(e.id, workDate)],
        }))
        .filter((row) => row.choice && !locked[keyFor(row.employeeId, row.workDate)])
    );
    if (items.length === 0) {
      setBusy(false);
      setMsg('No editable days to save.');
      return;
    }
    const res = await fetch('/api/schedule', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok || data.errors?.length) {
      const err = data.errors?.[0];
      setMsg(err ? formatError(err, employees) : data.error || 'Save failed');
    } else {
      setMsg('Saved successfully.');
    }
    const start = workDates[0];
    const end = workDates[workDates.length - 1];
    await load(start, end);
    if (mode === 'week') {
      const week = await fetch(`/api/schedule?start=${start}&end=${end}`, { credentials: 'include' }).then((r) => r.json());
      if (week.weekDates) setDates(week.weekDates);
    }
  }

  async function runCopy(action: 'copy-previous-week' | 'repeat-week-to-month-end', overwriteExisting = false) {
    setBusy(true);
    setMsg('');
    const res = await fetch('/api/schedule', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        weekStart: mode === 'month' && action === 'repeat-week-to-month-end' ? today || anchor : anchor,
        overwriteExisting,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (data.needsConfirmation) {
      const ok = window.confirm(
        `${data.message}\n\nReplace ${data.wouldOverwrite} existing future day(s)? Attendance-locked days stay unchanged.`
      );
      if (ok) {
        await runCopy(action, true);
      }
      return;
    }
    if (!res.ok || data.errors?.length) {
      const err = data.errors?.[0];
      setMsg(err ? formatError(err, employees) : data.error || data.message || 'Copy failed');
    } else {
      setMsg(
        data.saved
          ? `Saved successfully. Copied ${data.saved} day(s).`
          : data.message || 'Saved successfully.'
      );
    }
    const start = visibleDates[0];
    const end = visibleDates[visibleDates.length - 1];
    if (start && end) await load(start, end);
  }

  const visibleDates = mode === 'today' ? [today || anchor] : dates;
  const options = useMemo(
    () =>
      [
        ['SHIFT_1', shiftLabel(shifts, 'SHIFT_1')],
        ['SHIFT_2', shiftLabel(shifts, 'SHIFT_2')],
        ['OFF', 'OFF'],
      ] as const,
    [shifts]
  );

  const monthWeeks = useMemo(() => {
    if (mode !== 'month' || dates.length === 0) return [];
    const first = dates[0];
    const [y, m, d] = first.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun
    const mondayIndex = weekday === 0 ? 6 : weekday - 1;
    const padded: Array<string | null> = [...Array(mondayIndex).fill(null), ...dates];
    while (padded.length % 7 !== 0) padded.push(null);
    const weeks: Array<Array<string | null>> = [];
    for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
    return weeks;
  }, [mode, dates]);

  return (
    <Surface>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">
            Shift Schedule
          </p>
          <h2 className="text-lg font-bold text-slate-900">Assign Shift 1 / Shift 2 / Off</h2>
          <p className="text-sm text-slate-500">
            Times in Asia/Riyadh · {today}
            {shifts.SHIFT_1 ? ` · Shift 1 ${shifts.SHIFT_1.startTime} → ${shifts.SHIFT_1.endTime}` : ''}
            {shifts.SHIFT_2 ? ` · Shift 2 ${shifts.SHIFT_2.startTime} → ${shifts.SHIFT_2.endTime}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {(['today', 'week', 'month'] as const).map((id) => (
            <button
              key={id}
              onClick={() => {
                setMode(id);
                if (id === 'today') setAnchor(today);
              }}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${
                mode === id ? 'bg-[#C8102E] text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'
              }`}
            >
              {id === 'today' ? 'Today' : id === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'week' ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <button className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium" onClick={() => setAnchor((d) => addDays(d, -7))}>
            Previous Week
          </button>
          <button className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium" onClick={() => setAnchor(today)}>
            Current Week
          </button>
          <button className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium" onClick={() => setAnchor((d) => addDays(d, 7))}>
            Next Week
          </button>
          <button
            className="rounded-xl bg-white px-3 py-2 text-sm font-semibold ring-1 ring-slate-200"
            disabled={busy}
            onClick={() => void runCopy('copy-previous-week')}
          >
            Copy Previous Week
          </button>
          <button
            className="rounded-xl bg-white px-3 py-2 text-sm font-semibold ring-1 ring-slate-200"
            disabled={busy}
            onClick={() => void runCopy('repeat-week-to-month-end')}
          >
            Repeat Current Week to End of Month
          </button>
        </div>
      ) : null}

      {mode === 'month' ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <button className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium" onClick={() => setAnchor((d) => addMonths(d, -1))}>
            Previous Month
          </button>
          <button className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium" onClick={() => setAnchor(today)}>
            Current Month
          </button>
          <button className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-medium" onClick={() => setAnchor((d) => addMonths(d, 1))}>
            Next Month
          </button>
          <button
            className="rounded-xl bg-white px-3 py-2 text-sm font-semibold ring-1 ring-slate-200"
            disabled={busy}
            onClick={() => void runCopy('repeat-week-to-month-end')}
          >
            Repeat Current Week to End of Month
          </button>
        </div>
      ) : null}

      {mode === 'today' ? (
        <div className="space-y-3">
          {employees.map((e) => {
            const workDate = visibleDates[0];
            const key = keyFor(e.id, workDate);
            const choice = grid[key] || '';
            return (
              <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3">
                <EmployeeAvatar name={e.fullName} badge={e.badgeNumber || e.employeeCode} size="sm" />
                <div className="min-w-[160px] flex-1">
                  <p className="font-semibold text-slate-900">{e.fullName}</p>
                  <p className="text-xs text-slate-500">BN# {e.badgeNumber || e.employeeCode}</p>
                </div>
                <select
                  disabled={!!locked[key]}
                  value={choice}
                  onChange={(ev) => setChoice(e.id, workDate, ev.target.value as Choice)}
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold ${choiceClass(choice)}`}
                >
                  <option value="">Select…</option>
                  {options.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
          <BrandButton disabled={busy} onClick={() => void save(visibleDates)}>
            Save
          </BrandButton>
        </div>
      ) : null}

      {mode === 'week' ? (
        <div className="overflow-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="pb-3 pr-2">Employee</th>
                {visibleDates.map((d) => (
                  <th key={d} className="pb-3 pr-2 font-semibold">
                    {d.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id} className="border-t border-slate-100">
                  <td className="py-2 pr-2">
                    <p className="font-semibold text-slate-900">{e.fullName}</p>
                    <p className="text-xs text-slate-500">BN# {e.badgeNumber || e.employeeCode}</p>
                  </td>
                  {visibleDates.map((d) => {
                    const key = keyFor(e.id, d);
                    const choice = grid[key] || '';
                    return (
                      <td key={d} className="py-2 pr-2">
                        <select
                          disabled={!!locked[key]}
                          value={choice}
                          onChange={(ev) => setChoice(e.id, d, ev.target.value as Choice)}
                          className={`w-full rounded-lg border px-2 py-1.5 text-xs font-semibold ${choiceClass(choice)}`}
                        >
                          <option value="">—</option>
                          <option value="SHIFT_1">Shift 1</option>
                          <option value="SHIFT_2">Shift 2</option>
                          <option value="OFF">Off</option>
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4">
            <BrandButton disabled={busy} onClick={() => void save(visibleDates)}>
              Save Week
            </BrandButton>
          </div>
        </div>
      ) : null}

      {mode === 'month' ? (
        <div className="space-y-4">
          {employees.map((e) => (
            <div key={e.id} className="rounded-2xl border border-slate-100 bg-white p-3">
              <div className="mb-3 flex items-center gap-3">
                <EmployeeAvatar name={e.fullName} badge={e.badgeNumber || e.employeeCode} size="sm" />
                <div>
                  <p className="font-semibold text-slate-900">{e.fullName}</p>
                  <p className="text-xs text-slate-500">BN# {e.badgeNumber || e.employeeCode}</p>
                </div>
              </div>
              <div className="overflow-auto">
                <div className="min-w-[640px]">
                  <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                      <div key={d}>{d}</div>
                    ))}
                  </div>
                  {monthWeeks.map((week, wi) => (
                    <div key={wi} className="mb-1 grid grid-cols-7 gap-1">
                      {week.map((d, di) => {
                        if (!d) return <div key={`${wi}-${di}`} />;
                        const key = keyFor(e.id, d);
                        const choice = grid[key] || '';
                        return (
                          <div key={d} className="rounded-lg border border-slate-100 p-1">
                            <p className="mb-1 text-center text-[11px] font-medium text-slate-500">{d.slice(8)}</p>
                            <select
                              disabled={!!locked[key]}
                              value={choice}
                              onChange={(ev) => setChoice(e.id, d, ev.target.value as Choice)}
                              className={`w-full rounded-md border px-1 py-1 text-[11px] font-semibold ${choiceClass(choice)}`}
                            >
                              <option value="">—</option>
                              <option value="SHIFT_1">S1</option>
                              <option value="SHIFT_2">S2</option>
                              <option value="OFF">Off</option>
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
          <BrandButton disabled={busy} onClick={() => void save(visibleDates)}>
            Save Month
          </BrandButton>
        </div>
      ) : null}

      {employees.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No active employees with role EMPLOYEE.</p>
      ) : null}
      {msg ? <p className="mt-3 text-sm text-slate-700">{msg}</p> : null}
    </Surface>
  );
}

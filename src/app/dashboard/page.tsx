'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { BrandButton, EmployeeAvatar, Logo, StatCard, StatusChip, Surface } from '@/components/ui';
import { shortName } from '@/lib/employee-identity';

type Summary = {
  scheduled: number;
  present: number;
  late: number;
  absent: number;
  overtime: number;
  missingCheckout: number;
  working: number;
};

type RecordRow = {
  id: string;
  employeeName: string;
  employeeCode: string;
  project: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number | null;
  lateMinutes: number;
  overtimeMinutes: number;
  statusPrimary: string;
};

type Emp = {
  id: string;
  fullName: string;
  employeeCode: string;
  badgeNumber: string;
  department: string | null;
  position: string | null;
  isActive: boolean;
  defaultProject: { name: string } | null;
  user: { role: string; username: string } | null;
};

type Proj = {
  id: string;
  name: string;
  code: string;
  locationLabel: string | null;
  radiusMeters: number;
  isActive: boolean;
  terminals: Array<{ slug: string; name: string; isActive: boolean }>;
  _count: { assignments: number; attendance: number };
};

type Audit = {
  id: string;
  action: string;
  createdAt: string;
  employeeId: string | null;
  actor: { username: string; role: string } | null;
  newValue: string | null;
};

function fmt(mins: number | null) {
  if (mins == null) return '—';
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function toneFor(status: string): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (status === 'ON_TIME' || status === 'PRESENT' || status === 'WORKING') return 'ok';
  if (status === 'LATE' || status === 'OVERTIME' || status === 'EARLY_DEPARTURE') return 'warn';
  if (status === 'ABSENT' || status === 'MISSING_CHECKOUT') return 'danger';
  return 'info';
}

export default function DashboardPage() {
  const router = useRouter();
  const [section, setSection] = useState<'tonight' | 'people' | 'projects' | 'audit'>('tonight');
  const [workDate, setWorkDate] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [working, setWorking] = useState<
    Array<{
      name: string;
      code: string;
      project: string;
      checkInAt: string;
      currentWorkedMinutes: number;
      lateMinutes: number;
    }>
  >([]);
  const [employees, setEmployees] = useState<Emp[]>([]);
  const [projects, setProjects] = useState<Proj[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [manualEmp, setManualEmp] = useState('EMP-0147');
  const [manualReason, setManualReason] = useState('Employee phone unavailable');
  const [msg, setMsg] = useState('');
  const [now, setNow] = useState(new Date());

  const loadTonight = useCallback(async () => {
    const data = await fetch('/api/dashboard/tonight').then((r) => r.json());
    setWorkDate(data.workDate);
    setSummary(data.summary);
    setRecords(data.records);
    setWorking(data.currentlyWorking);
  }, []);

  const boot = useCallback(async () => {
    const me = await fetch('/api/auth/me').then((r) => r.json());
    if (!me.user) {
      router.replace('/login');
      return;
    }
    if (me.user.role === 'EMPLOYEE') {
      router.replace('/app');
      return;
    }
    await loadTonight();
  }, [router, loadTonight]);

  useEffect(() => {
    void boot();
    const t = setInterval(() => void loadTonight(), 20000);
    const c = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [boot, loadTonight]);

  useEffect(() => {
    if (section === 'people') {
      fetch('/api/employees')
        .then((r) => r.json())
        .then((d) => setEmployees(d.employees || []));
    }
    if (section === 'projects') {
      fetch('/api/projects')
        .then((r) => r.json())
        .then((d) => setProjects(d.projects || []));
    }
    if (section === 'audit') {
      fetch('/api/audit-logs')
        .then((r) => r.json())
        .then((d) => setAudits(d.logs || []))
        .catch(() => setAudits([]));
    }
  }, [section]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  }

  async function manualCheckIn() {
    setMsg('');
    const lookup = await fetch(`/api/employees?code=${encodeURIComponent(manualEmp.trim())}`);
    const empJson = await lookup.json();
    if (!empJson.employee?.id) {
      setMsg('Employee not found');
      return;
    }
    const res = await fetch('/api/attendance/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'check-in',
        employeeId: empJson.employee.id,
        reason: manualReason,
      }),
    });
    const json = await res.json();
    if (!res.ok) setMsg(json.error || 'Failed');
    else {
      setMsg('Manual check-in saved');
      void loadTonight();
    }
  }

  async function manualCheckOutFor(code: string, attendanceId: string) {
    const lookup = await fetch(`/api/employees?code=${encodeURIComponent(code)}`);
    const empJson = await lookup.json();
    if (!empJson.employee?.id) return;
    const res = await fetch('/api/attendance/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'check-out',
        employeeId: empJson.employee.id,
        attendanceId,
        reason: 'Supervisor closed missing checkout',
      }),
    });
    if (res.ok) void loadTonight();
  }

  const filtered = records.filter((r) => {
    const matchQ =
      !q ||
      r.employeeName.toLowerCase().includes(q.toLowerCase()) ||
      r.employeeCode.toLowerCase().includes(q.toLowerCase());
    const matchS = statusFilter === 'ALL' || r.statusPrimary === statusFilter;
    return matchQ && matchS;
  });

  const nav = [
    ['tonight', "Tonight"],
    ['people', 'People'],
    ['projects', 'Projects'],
    ['audit', 'Audit'],
  ] as const;

  return (
    <main className="mesh-bg min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Logo width={130} height={42} />
            <div className="hidden sm:block">
              <h1 className="text-sm font-bold text-slate-900">Night Shift Attendance</h1>
              <p className="text-xs text-slate-500">
                Tonight · {workDate || '…'} ·{' '}
                {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              href="/terminal/bin-quraya-dhahran"
              className="rounded-xl bg-slate-100 px-3 py-2 font-medium text-slate-700 hover:bg-slate-200"
            >
              QR Terminal
            </Link>
            <a
              href={`/api/exports/attendance?date=${workDate}`}
              className="rounded-xl bg-slate-100 px-3 py-2 font-medium text-slate-700 hover:bg-slate-200"
            >
              Export CSV
            </a>
            <button onClick={logout} className="rounded-xl px-3 py-2 font-medium text-rose-600">
              Logout
            </button>
          </div>
        </div>
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-3">
          {nav.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={`rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap ${
                section === id
                  ? 'bg-[#C8102E] text-white'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        {section === 'tonight' ? (
          <>
            <section>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">
                Tonight&apos;s Shift
              </p>
              <h2 className="mb-3 text-xl font-bold text-slate-900">Live operations</h2>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
                <StatCard label="Scheduled" value={summary?.scheduled ?? '—'} tone="info" />
                <StatCard label="Present" value={summary?.present ?? '—'} tone="ok" />
                <StatCard label="Late" value={summary?.late ?? '—'} tone="warn" />
                <StatCard label="Absent" value={summary?.absent ?? '—'} tone="danger" />
                <StatCard label="Overtime" value={summary?.overtime ?? '—'} tone="brand" />
                <StatCard label="Missing out" value={summary?.missingCheckout ?? '—'} tone="danger" />
                <StatCard label="Working now" value={summary?.working ?? '—'} tone="info" />
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-3">
              <Surface className="lg:col-span-1">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="font-bold text-slate-900">Currently Working</h3>
                  <StatusChip tone="ok">{working.length} live</StatusChip>
                </div>
                <div className="max-h-[420px] space-y-3 overflow-auto pr-1">
                  {working.length === 0 ? (
                    <p className="py-8 text-center text-sm text-slate-500">No active check-ins</p>
                  ) : (
                working.map((w) => (
                  <div
                    key={w.code}
                    className="rounded-2xl border border-slate-100 bg-gradient-to-br from-slate-50 to-white p-3"
                  >
                    <div className="flex items-start gap-3">
                      <EmployeeAvatar name={w.name} badge={w.code} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-semibold text-slate-900">{shortName(w.name)}</p>
                            <p className="text-xs text-slate-500">
                              BN# {w.code} · {w.project}
                            </p>
                          </div>
                          {w.lateMinutes > 0 ? (
                            <StatusChip tone="warn">Late {w.lateMinutes}m</StatusChip>
                          ) : (
                            <StatusChip tone="ok">On time</StatusChip>
                          )}
                        </div>
                        <p className="mt-2 text-sm text-slate-600">
                          In {fmtTime(w.checkInAt)} ·{' '}
                          <span className="font-semibold text-slate-900">
                            {fmt(w.currentWorkedMinutes)}
                          </span>
                        </p>
                      </div>
                    </div>
                  </div>
                ))
                  )}
                </div>
              </Surface>

              <Surface className="lg:col-span-2 !p-4 md:!p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-bold text-slate-900">Attendance records</h3>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search name or ID"
                      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-rose-300"
                    />
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                    >
                      <option value="ALL">All statuses</option>
                      <option value="WORKING">Working</option>
                      <option value="LATE">Late</option>
                      <option value="ON_TIME">On time</option>
                      <option value="OVERTIME">Overtime</option>
                      <option value="MISSING_CHECKOUT">Missing checkout</option>
                    </select>
                  </div>
                </div>
                <div className="overflow-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                        <th className="pb-3 pr-2 font-semibold">Employee</th>
                        <th className="pb-3 pr-2 font-semibold">Project</th>
                        <th className="pb-3 pr-2 font-semibold">In</th>
                        <th className="pb-3 pr-2 font-semibold">Out</th>
                        <th className="pb-3 pr-2 font-semibold">Worked</th>
                        <th className="pb-3 pr-2 font-semibold">Late</th>
                        <th className="pb-3 pr-2 font-semibold">OT</th>
                        <th className="pb-3 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((r) => (
                        <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50/80">
                      <td className="py-3.5 pr-2">
                        <div className="flex items-center gap-3">
                          <EmployeeAvatar
                            name={r.employeeName}
                            badge={r.employeeCode}
                            size="sm"
                          />
                          <div>
                            <p className="font-semibold text-slate-900">
                              {shortName(r.employeeName)}
                            </p>
                            <p className="text-xs font-medium text-slate-500">
                              BN# {r.employeeCode}
                            </p>
                          </div>
                        </div>
                      </td>
                          <td className="py-3.5 pr-2 text-slate-600">{r.project}</td>
                          <td className="py-3.5 pr-2">{fmtTime(r.checkInAt)}</td>
                          <td className="py-3.5 pr-2">
                            {fmtTime(r.checkOutAt)}
                            {r.checkInAt && !r.checkOutAt ? (
                              <button
                                className="ml-2 text-xs font-semibold text-[#C8102E]"
                                onClick={() => void manualCheckOutFor(r.employeeCode, r.id)}
                              >
                                Close
                              </button>
                            ) : null}
                          </td>
                          <td className="py-3.5 pr-2 font-medium">{fmt(r.workedMinutes)}</td>
                          <td className="py-3.5 pr-2">{r.lateMinutes}m</td>
                          <td className="py-3.5 pr-2">{r.overtimeMinutes}m</td>
                          <td className="py-3.5">
                            <StatusChip tone={toneFor(r.statusPrimary)}>
                              {r.statusPrimary}
                            </StatusChip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length === 0 ? (
                    <p className="py-10 text-center text-sm text-slate-500">No matching records</p>
                  ) : null}
                </div>
              </Surface>
            </section>

            <Surface>
              <h3 className="font-bold text-slate-900">Manual attendance</h3>
              <p className="mt-1 text-sm text-slate-500">
                Exceptional cases only — reason stored in Audit Log.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <input
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
                  placeholder="Employee ID"
                  value={manualEmp}
                  onChange={(e) => setManualEmp(e.target.value)}
                />
                <input
                  className="min-w-[220px] flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
                  value={manualReason}
                  onChange={(e) => setManualReason(e.target.value)}
                />
                <BrandButton onClick={() => void manualCheckIn()}>Save manual check-in</BrandButton>
              </div>
              {msg ? <p className="mt-3 text-sm text-slate-700">{msg}</p> : null}
            </Surface>
          </>
        ) : null}

        {section === 'people' ? (
          <Surface>
            <h2 className="mb-4 text-lg font-bold text-slate-900">Employees</h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {employees.map((e) => (
                <div
                  key={e.id}
                  className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <EmployeeAvatar
                      name={e.fullName}
                      badge={e.badgeNumber || e.employeeCode}
                      size="lg"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-bold text-slate-900">{e.fullName}</p>
                          <p className="mt-0.5 text-sm font-semibold text-[#C8102E]">
                            BN# {e.badgeNumber || e.employeeCode}
                          </p>
                        </div>
                        <StatusChip tone={e.isActive ? 'ok' : 'danger'}>
                          {e.isActive ? 'Active' : 'Inactive'}
                        </StatusChip>
                      </div>
                      <p className="mt-2 text-sm text-slate-700">{e.position || '—'}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {e.department || '—'} · Login: {e.user?.username || '—'}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Surface>
        ) : null}

        {section === 'projects' ? (
          <div className="grid gap-4 md:grid-cols-2">
            {projects.map((p) => (
              <Surface key={p.id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-bold tracking-wide text-[#C8102E]">{p.code}</p>
                    <h3 className="text-lg font-bold text-slate-900">{p.name}</h3>
                    <p className="mt-1 text-sm text-slate-500">{p.locationLabel}</p>
                  </div>
                  <StatusChip tone={p.isActive ? 'ok' : 'danger'}>
                    {p.isActive ? 'Active' : 'Off'}
                  </StatusChip>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-slate-50 p-2">
                    <p className="text-lg font-bold text-slate-900">{p.radiusMeters}m</p>
                    <p className="text-[11px] text-slate-500">GPS radius</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2">
                    <p className="text-lg font-bold text-slate-900">{p._count.assignments}</p>
                    <p className="text-[11px] text-slate-500">Assignments</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2">
                    <p className="text-lg font-bold text-slate-900">{p._count.attendance}</p>
                    <p className="text-[11px] text-slate-500">Records</p>
                  </div>
                </div>
                {p.terminals[0] ? (
                  <Link
                    href={`/terminal/${p.terminals[0].slug}`}
                    className="mt-4 inline-flex text-sm font-semibold text-[#C8102E]"
                  >
                    Open QR Terminal →
                  </Link>
                ) : null}
              </Surface>
            ))}
          </div>
        ) : null}

        {section === 'audit' ? (
          <Surface>
            <h2 className="mb-2 text-lg font-bold text-slate-900">Audit log</h2>
            <p className="mb-4 text-sm text-slate-500">Read-only security trail — not deletable.</p>
            {audits.length === 0 ? (
              <p className="text-sm text-slate-500">
                No audit entries visible (Admin/HR only) or still empty.
              </p>
            ) : (
              <div className="space-y-2">
                {audits.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2.5 text-sm"
                  >
                    <div>
                      <p className="font-semibold text-slate-900">{a.action}</p>
                      <p className="text-xs text-slate-500">
                        {a.actor?.username || 'system'} · {a.actor?.role || '—'}
                      </p>
                    </div>
                    <p className="text-xs text-slate-500">
                      {new Date(a.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Surface>
        ) : null}
      </div>
    </main>
  );
}

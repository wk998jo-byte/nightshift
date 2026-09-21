'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BrandButton, EmployeeAvatar, Logo, StatusChip, Surface } from '@/components/ui';
import { lateMinutesAfterGrace } from '@/lib/attendance-calc';
import { startQrScanner, stopMediaStream, type BarcodeDetectorLike } from '@/lib/qr-scanner';

type Timing = {
  phase: 'early' | 'on_time' | 'late' | 'in_shift';
  minutesUntilStart: number;
  lateMinutes: number;
  earlyMinutes: number;
  labelAr: string;
  labelEn: string;
};

type Today = {
  employee: {
    fullName: string;
    employeeCode: string;
    badgeNumber: string;
    position?: string | null;
  };
  openShift: null | {
    id: string;
    project: { name: string };
    checkInAt: string;
    checkInLabel: string;
    lateMinutes: number;
    currentWorkedLabel: string;
    timing?: Timing | null;
  };
  schedule: null | {
    project: { name: string; locationLabel?: string | null };
    shift: {
      name: string;
      startTime: string;
      endTime: string;
      gracePeriodMinutes: number;
    };
    scheduledStart: string;
    scheduledEnd: string;
  };
  timing: Timing | null;
  scheduleState?: 'SCHEDULED' | 'OFF_DAY' | 'NO_SCHEDULE';
  scheduleMessage?: string | null;
  history: Array<{
    id: string;
    project: string;
    checkInAt: string | null;
    checkOutAt: string | null;
    workedMinutes: number | null;
    lateMinutes: number;
    overtimeMinutes: number;
    statusPrimary: string;
  }>;
};

function formatCountdown(totalMinutes: number) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m} دقيقة`;
  return `${h} ساعة و ${m} دقيقة`;
}

function getGps(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS not available on this device'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
      () => reject(new Error('Location permission required')),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

function fmt(mins: number | null) {
  if (mins == null) return '—';
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function EmployeeAppPage() {
  const router = useRouter();
  const [data, setData] = useState<Today | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [mode, setMode] = useState<'in' | 'out'>('in');
  const [manualToken, setManualToken] = useState('');
  const [now, setNow] = useState(new Date());
  const [tab, setTab] = useState<'home' | 'history'>('home');
  const [gpsHint, setGpsHint] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef<{ stop: () => void } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/me/today');
    if (res.status === 401) {
      router.replace('/login');
      return;
    }
    setData(await res.json());
  }, [router]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    const c = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [load]);

  useEffect(() => {
    return () => {
      scanRef.current?.stop();
      scanRef.current = null;
      stopMediaStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.replace('/login');
  }

  async function startCamera(nextMode: 'in' | 'out') {
    setMode(nextMode);
    setError('');
    setSuccess(null);
    setGpsHint('Preparing camera & location…');
    setScanning(true);
    scanRef.current?.stop();
    scanRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (!videoRef.current) {
        setError('Camera preview failed. Paste the QR token below.');
        setGpsHint('');
        return;
      }
      setGpsHint('Point at the gate QR code');
      const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorLike }).BarcodeDetector;
      const handle = await startQrScanner({
        video: videoRef.current,
        stream,
        barcodeDetector: BD ?? null,
        onDetect: (token) => {
          void submitToken(token, nextMode);
        },
        onEngineUnavailable: () => {
          setGpsHint('Camera is on, but QR scanning is unavailable. Paste the token below.');
          setError('QR scanner engine is unavailable on this browser. Paste the QR token below.');
        },
      });
      scanRef.current = handle;
    } catch {
      setError('Camera unavailable. Paste QR token below or allow camera.');
      setGpsHint('');
    }
  }

  function stopCamera() {
    scanRef.current?.stop();
    scanRef.current = null;
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setScanning(false);
    setGpsHint('');
  }

  async function submitToken(token: string, nextMode: 'in' | 'out') {
    setBusy(true);
    setError('');
    setGpsHint('Verifying GPS & QR on server…');
    try {
      const gps = await getGps();
      const endpoint =
        nextMode === 'in' ? '/api/attendance/check-in' : '/api/attendance/check-out';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, ...gps }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Attendance failed');
        setGpsHint('');
        return;
      }
      stopCamera();
      if (nextMode === 'in') {
        const a = json.attendance;
        setSuccess(
          `${json.message || 'تم تسجيل الحضور'}\n${a.employeeName} · BN# ${a.employeeCode}\n${a.project}\nCheck-in: ${new Date(a.checkInAt).toLocaleTimeString()}\n${a.timingLabel || ''}`
        );
      } else {
        const a = json.attendance;
        setSuccess(
          `تم إنهاء الشفت\nWorked ${Math.floor((a.workedMinutes || 0) / 60)}h ${String((a.workedMinutes || 0) % 60).padStart(2, '0')}m\nOT ${a.overtimeMinutes}m · Early leave ${a.earlyLeaveMinutes}m`
        );
      }
      await load();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.includes('fetch')
            ? 'Connection unavailable. Attendance has not been registered.'
            : e.message
          : 'Connection unavailable. Attendance has not been registered.'
      );
      setGpsHint('');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <main className="mesh-bg grid min-h-screen place-items-center text-slate-500">
        Loading…
      </main>
    );
  }

  const active = !!data.openShift;
  const timing = data.openShift?.timing || data.timing;
  const scheduled = data.scheduleState === 'SCHEDULED' && !!data.schedule;
  const offDay = data.scheduleState === 'OFF_DAY';
  const noSchedule = data.scheduleState === 'NO_SCHEDULE' || (!data.scheduleState && !data.schedule);

  let liveUntil = 0;
  let liveLate = 0;
  if (data.schedule?.scheduledStart) {
    const startMs = new Date(data.schedule.scheduledStart).getTime();
    const grace = data.schedule.shift.gracePeriodMinutes ?? 5;
    if (now.getTime() < startMs) {
      liveUntil = Math.max(0, Math.ceil((startMs - now.getTime()) / 60000));
    } else {
      const rawLate = Math.max(0, Math.floor((now.getTime() - startMs) / 60000));
      liveLate = lateMinutesAfterGrace(rawLate, grace);
    }
  } else if (timing) {
    liveUntil = timing.minutesUntilStart;
    liveLate = timing.lateMinutes;
  }

  const timingPhase =
    liveUntil > 0 ? 'early' : liveLate > 0 ? 'late' : timing?.phase || 'on_time';

  return (
    <main className="mesh-bg min-h-screen pb-24">
      <header className="relative overflow-hidden px-5 pb-8 pt-5">
        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-[#C8102E]/[0.07]" />
        <div className="absolute -left-8 top-24 h-28 w-28 rounded-full bg-slate-300/30" />

        <div className="relative flex items-start justify-between">
          <Logo width={140} height={48} />
          <button onClick={logout} className="text-sm font-medium text-rose-600">
            Logout
          </button>
        </div>

        <div className="relative mt-6 animate-fade-up">
          <div className="flex items-center gap-3">
            <EmployeeAvatar
              name={data.employee.fullName}
              badge={data.employee.badgeNumber || data.employee.employeeCode}
              size="lg"
            />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#C8102E]">
                Worker check-in
              </p>
              <h1 className="mt-1 text-xl font-bold text-slate-900">{data.employee.fullName}</h1>
              <p className="font-semibold text-[#C8102E]">
                BN# {data.employee.badgeNumber || data.employee.employeeCode}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusChip tone="brand">
              {data.openShift?.project.name || data.schedule?.project?.name || 'No project'}
            </StatusChip>
            <StatusChip tone={active ? 'ok' : offDay ? 'neutral' : noSchedule ? 'warn' : 'neutral'}>
              {active ? 'Shift active' : offDay ? 'Off today' : noSchedule ? 'No schedule' : 'Not started'}
            </StatusChip>
            {!active && timingPhase === 'early' ? (
              <StatusChip tone="info">مبكر</StatusChip>
            ) : null}
            {!active && timingPhase === 'late' ? (
              <StatusChip tone="warn">متأخر</StatusChip>
            ) : null}
          </div>
        </div>
      </header>

      <div className="relative z-10 -mt-2 px-4">
        <div className="mb-4 flex gap-2 rounded-2xl bg-white/90 p-1 shadow-sm ring-1 ring-slate-200">
          {(['home', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-xl py-2.5 text-sm font-semibold transition ${
                tab === t ? 'bg-[#C8102E] text-white' : 'text-slate-500'
              }`}
            >
              {t === 'home' ? 'Today' : 'History'}
            </button>
          ))}
        </div>

        {tab === 'home' ? (
          <div className="space-y-4 animate-fade-up">
            <Surface>
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500">الوقت الآن</p>
                  <p className="text-3xl font-bold tabular-nums text-slate-900">
                    {now.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </p>
                </div>
                <p className="text-right text-sm text-slate-500">
                  {scheduled
                    ? `${data.schedule!.shift.startTime} → ${data.schedule!.shift.endTime}`
                    : offDay
                      ? 'OFF'
                      : 'No shift scheduled for today.'}
                </p>
              </div>
              {data.employee.position ? (
                <p className="mt-2 text-sm font-medium text-slate-700">{data.employee.position}</p>
              ) : null}
              {data.schedule?.project?.locationLabel ? (
                <p className="mt-1 text-sm text-slate-500">{data.schedule.project.locationLabel}</p>
              ) : null}
            </Surface>

            {!active && scheduled ? (
              <Surface
                className={
                  timingPhase === 'late'
                    ? '!border-amber-200 !bg-amber-50/80'
                    : timingPhase === 'early'
                      ? '!border-sky-200 !bg-sky-50/80'
                      : ''
                }
              >
                {timingPhase === 'early' ? (
                  <div className="text-center">
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
                      الشفت لم يبدأ بعد
                    </p>
                    <p className="mt-2 text-3xl font-bold tabular-nums text-sky-900">
                      {formatCountdown(liveUntil)}
                    </p>
                    <p className="mt-1 text-sm text-sky-700">متبقي على بداية الشفت</p>
                    <p className="mt-3 text-xs text-slate-500">
                      تقدر تسوي Start Shift الحين · يُسجّل كحضور مبكر
                    </p>
                  </div>
                ) : timingPhase === 'late' ? (
                  <div className="text-center">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                      تأخر عن بداية الشفت
                    </p>
                    <p className="mt-2 text-3xl font-bold tabular-nums text-amber-800">
                      {liveLate} دقيقة
                    </p>
                    <p className="mt-1 text-sm text-amber-700">متأخر حتى الآن</p>
                    <p className="mt-3 text-xs text-slate-500">
                      ابدأ الشفت الحين عشان يتوقف حساب التأخير
                    </p>
                  </div>
                ) : (
                  <div className="text-center">
                    <p className="text-sm font-semibold text-emerald-700">
                      وقت الشفت الآن · ضمن السماح
                    </p>
                  </div>
                )}
              </Surface>
            ) : null}

            <Surface className="!p-6">
              {success ? (
                <pre className="mb-4 whitespace-pre-wrap rounded-2xl bg-emerald-50 p-4 text-sm leading-relaxed text-emerald-700">
                  {success}
                </pre>
              ) : null}
              {error ? (
                <p className="mb-4 rounded-2xl bg-rose-50 p-3 text-sm text-rose-600">{error}</p>
              ) : null}

              {!active && (offDay || noSchedule) ? (
                <div className="text-center">
                  <h2 className="mb-2 text-lg font-bold text-slate-900">
                    {offDay ? 'You are scheduled OFF today.' : 'No shift scheduled for today.'}
                  </h2>
                  <p className="text-sm text-slate-500">
                    {offDay
                      ? 'Regular check-in is not allowed.'
                      : 'Contact supervisor.'}
                  </p>
                </div>
              ) : !active ? (
                <>
                  <p className="mb-1 text-center text-sm text-slate-500">
                    امسح QR الموقع للبدء
                  </p>
                  <h2 className="mb-5 text-center text-lg font-bold text-slate-900">
                    {timingPhase === 'early'
                      ? 'بدء مبكر للشفت'
                      : timingPhase === 'late'
                        ? 'تسجيل حضور متأخر'
                        : 'جاهز لبدء الشفت'}
                  </h2>
                  <BrandButton
                    disabled={busy}
                    onClick={() => void startCamera('in')}
                    className="w-full !rounded-2xl !py-5 !text-lg"
                  >
                    START SHIFT
                  </BrandButton>
                </>
              ) : (
                <>
                  <div className="mb-5 text-center">
                    <span className="animate-pulse-soft inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-100">
                      ● SHIFT ACTIVE
                    </span>
                    <p className="mt-4 text-sm text-slate-500">
                      Started {data.openShift?.checkInLabel}
                    </p>
                    <p className="mt-1 text-4xl font-bold tracking-tight text-slate-900">
                      {data.openShift?.currentWorkedLabel}
                    </p>
                    <p className="text-sm text-slate-400">worked so far</p>
                    {data.openShift && data.openShift.lateMinutes > 0 ? (
                      <p className="mt-3 text-sm font-semibold text-amber-600">
                        سُجّل متأخراً بـ {data.openShift.lateMinutes} دقيقة
                      </p>
                    ) : (
                      <p className="mt-3 text-sm font-semibold text-emerald-600">
                        حضور في الوقت / مبكر
                      </p>
                    )}
                  </div>
                  <BrandButton
                    variant="danger"
                    disabled={busy}
                    onClick={() => void startCamera('out')}
                    className="w-full !rounded-2xl !py-5 !text-lg"
                  >
                    END SHIFT
                  </BrandButton>
                </>
              )}
            </Surface>

            {scanning ? (
              <Surface>
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-bold text-slate-900">Scan site QR</p>
                  <button onClick={stopCamera} className="text-sm text-slate-500">
                    Cancel
                  </button>
                </div>
                <div className="relative overflow-hidden rounded-2xl">
                  <video
                    ref={videoRef}
                    className="aspect-square w-full bg-slate-900 object-cover"
                    muted
                    playsInline
                  />
                  <div className="pointer-events-none absolute inset-8 rounded-xl border-2 border-white/80" />
                </div>
                {gpsHint ? (
                  <p className="mt-2 text-center text-xs font-medium text-[#C8102E]">{gpsHint}</p>
                ) : null}
                <p className="mt-1 text-center text-xs text-slate-500">
                  GPS only at punch time — no live tracking
                </p>
                <input
                  className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"
                  placeholder="Or paste QR token"
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                />
                <BrandButton
                  disabled={busy || !manualToken}
                  onClick={() => void submitToken(manualToken, mode)}
                  className="mt-2 w-full"
                >
                  Submit token
                </BrandButton>
              </Surface>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 animate-fade-up">
            {(data.history || []).length === 0 ? (
              <Surface>
                <p className="text-center text-slate-500">No attendance history yet</p>
              </Surface>
            ) : (
              data.history.map((h) => (
                <Surface key={h.id} className="!p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">{h.project}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {fmtTime(h.checkInAt)} → {fmtTime(h.checkOutAt)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Worked {fmt(h.workedMinutes)}
                        {h.lateMinutes > 0 ? ` · Late ${h.lateMinutes}m` : ''}
                        {h.overtimeMinutes > 0 ? ` · OT ${h.overtimeMinutes}m` : ''}
                      </p>
                    </div>
                    <StatusChip
                      tone={
                        h.statusPrimary === 'LATE'
                          ? 'warn'
                          : h.statusPrimary === 'ON_TIME' || h.statusPrimary === 'WORKING'
                            ? 'ok'
                            : h.statusPrimary.includes('MISSING')
                              ? 'danger'
                              : 'info'
                      }
                    >
                      {h.statusPrimary}
                    </StatusChip>
                  </div>
                </Surface>
              ))
            )}
          </div>
        )}
      </div>
    </main>
  );
}

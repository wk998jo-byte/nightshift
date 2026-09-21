'use client';

import { BrandButton, StatusChip, Surface } from '@/components/ui';

export type AttendanceDetailsPayload = {
  employeeName: string;
  employeeCode: string;
  project: string;
  projectLocation: string | null;
  shiftLabel: string;
  checkIn: PunchSide;
  checkOut: PunchSide;
  security: { status: string; labels: string[] };
};

type PunchSide = {
  at: string | null;
  method: string | null;
  gps: string;
  distanceLabel: string;
  radiusMeters: number;
  siteStatus: string;
  mapUrl: string | null;
  displayDeviceId: string;
  deviceType: string;
  ip: string;
};

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="max-w-[60%] text-right font-medium text-slate-900">{value || '—'}</span>
    </div>
  );
}

function PunchBlock({ title, punch }: { title: string; punch: PunchSide }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">{title}</p>
      <Row label="Time" value={fmtTime(punch.at)} />
      <Row label="Device" value={punch.deviceType} />
      <Row label="Device ID" value={punch.displayDeviceId} />
      <Row label="GPS coordinates" value={punch.gps} />
      <Row label="Distance from site" value={punch.distanceLabel} />
      <Row label="Allowed radius" value={punch.at ? `${punch.radiusMeters} m` : '—'} />
      <Row label="Status" value={punch.siteStatus} />
      <Row label="IP" value={punch.ip} />
      <Row label="Method" value={punch.method || '—'} />
      {punch.mapUrl ? (
        <a
          href={punch.mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex text-sm font-semibold text-[#C8102E]"
        >
          Open punch location →
        </a>
      ) : null}
    </div>
  );
}

export default function AttendanceDetailsDrawer({
  open,
  loading,
  error,
  details,
  onClose,
}: {
  open: boolean;
  loading: boolean;
  error: string;
  details: AttendanceDetailsPayload | null;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center">
      <button className="absolute inset-0 cursor-default" aria-label="Close details" onClick={onClose} />
      <Surface className="relative z-10 max-h-[90vh] w-full max-w-lg overflow-auto shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#C8102E]">Attendance</p>
            <h3 className="text-lg font-bold text-slate-900">Punch details</h3>
          </div>
          <BrandButton variant="ghost" className="!px-3 !py-2" onClick={onClose}>
            Close
          </BrandButton>
        </div>
        {loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        {details ? (
          <div className="space-y-4">
            <div>
              <p className="font-bold text-slate-900">{details.employeeName}</p>
              <p className="text-sm text-slate-500">BN# {details.employeeCode}</p>
              <p className="mt-1 text-sm text-slate-700">{details.shiftLabel}</p>
              <p className="text-sm text-slate-500">
                {details.project}
                {details.projectLocation ? ` · ${details.projectLocation}` : ''}
              </p>
            </div>
            <PunchBlock title="Check-in" punch={details.checkIn} />
            <PunchBlock title="Check-out" punch={details.checkOut} />
            <div className="rounded-2xl border border-slate-100 bg-white p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Security</p>
              <div className="flex flex-wrap gap-2">
                {details.security.labels.map((label) => (
                  <StatusChip
                    key={label}
                    tone={
                      label === 'Normal' ? 'ok' : label === 'New Device' ? 'warn' : 'danger'
                    }
                  >
                    {label}
                  </StatusChip>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </Surface>
    </div>
  );
}

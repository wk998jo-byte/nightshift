import { ReactNode } from 'react';
import { employeeColor, employeeInitials } from '@/lib/employee-identity';

export function StatusChip({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'brand';
  children: ReactNode;
}) {
  const map = {
    ok: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    warn: 'bg-amber-50 text-amber-700 ring-amber-100',
    danger: 'bg-rose-50 text-rose-700 ring-rose-100',
    info: 'bg-sky-50 text-sky-700 ring-sky-100',
    neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
    brand: 'bg-rose-50 text-[#C8102E] ring-rose-100',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${map[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'brand';
}) {
  const tones = {
    ok: 'from-emerald-50 to-white border-emerald-100',
    warn: 'from-amber-50 to-white border-amber-100',
    danger: 'from-rose-50 to-white border-rose-100',
    info: 'from-sky-50 to-white border-sky-100',
    neutral: 'from-slate-50 to-white border-slate-100',
    brand: 'from-rose-50 to-white border-rose-100',
  };
  const valueColor = {
    ok: 'text-emerald-700',
    warn: 'text-amber-700',
    danger: 'text-rose-700',
    info: 'text-sky-700',
    neutral: 'text-slate-800',
    brand: 'text-[#C8102E]',
  };
  return (
    <div
      className={`rounded-2xl border bg-gradient-to-b p-4 shadow-sm ${tones[tone]} animate-fade-up`}
    >
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-3xl font-bold tracking-tight ${valueColor[tone]}`}>{value}</p>
    </div>
  );
}

export function Surface({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`glass-card rounded-2xl p-5 ${className}`}>{children}</div>
  );
}

export function BrandButton({
  children,
  onClick,
  disabled,
  variant = 'primary',
  className = '',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  className?: string;
  type?: 'button' | 'submit';
}) {
  const styles = {
    primary:
      'bg-[#C8102E] text-white shadow-lg shadow-rose-200/50 hover:bg-[#b10e29]',
    secondary:
      'bg-white text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    ghost: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`btn-press rounded-2xl px-4 py-3 text-sm font-semibold transition disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Logo({
  width = 160,
  height = 52,
  className = '',
}: {
  width?: number;
  height?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/bin-quraya-logo-clear.png"
      alt="Bin Quraya"
      width={width}
      height={height}
      className={`object-contain ${className}`}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).src = '/bin-quraya-logo.png';
      }}
    />
  );
}

export function EmployeeAvatar({
  name,
  badge,
  size = 'md',
}: {
  name: string;
  badge: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const color = employeeColor(badge);
  const initials = employeeInitials(name);
  const sizes = {
    sm: 'h-9 w-9 text-xs',
    md: 'h-12 w-12 text-sm',
    lg: 'h-16 w-16 text-lg',
  };
  return (
    <div
      className={`inline-flex shrink-0 items-center justify-center rounded-2xl font-bold ring-2 ${sizes[size]}`}
      style={{
        backgroundColor: color.bg,
        color: color.fg,
        boxShadow: `0 0 0 1px ${color.ring}`,
      }}
      title={`${name} · BN# ${badge} · ${color.label}`}
    >
      {initials}
    </div>
  );
}


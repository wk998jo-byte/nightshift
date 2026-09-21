'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import QRCode from 'qrcode';
import { Logo } from '@/components/ui';

export default function TerminalPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const [meta, setMeta] = useState<{
    project: { name: string; code: string; locationLabel?: string | null };
    rotationSeconds: number;
  } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [token, setToken] = useState('');
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [now, setNow] = useState(new Date());
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    fetch(`/api/terminal/${slug}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setMeta(d);
      })
      .catch(() => setError('Failed to load terminal'));
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function rotate() {
      try {
        const res = await fetch(`/api/terminal/${slug}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Rotate failed');
          timer = setTimeout(rotate, 5000);
          return;
        }
        if (cancelled) return;
        setError('');
        const url = await QRCode.toDataURL(data.token, {
          width: 440,
          margin: 2,
          color: { dark: '#C8102E', light: '#FFFFFF' },
        });
        setQrDataUrl(url);
        setToken(data.token);
        setExpiresAt(new Date(data.expiresAt));
        setMeta((m) =>
          m
            ? { ...m, rotationSeconds: data.rotationSeconds, project: data.project }
            : { rotationSeconds: data.rotationSeconds, project: data.project }
        );
        const ms = Math.max(1000, new Date(data.expiresAt).getTime() - Date.now() - 500);
        timer = setTimeout(rotate, ms);
      } catch {
        setError('Connection issue — retrying…');
        timer = setTimeout(rotate, 5000);
      }
    }

    void rotate();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slug]);

  const secondsLeft = expiresAt
    ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000))
    : 0;
  const progress =
    meta?.rotationSeconds && expiresAt
      ? Math.min(100, (secondsLeft / meta.rotationSeconds) * 100)
      : 0;

  return (
    <main className="mesh-bg relative flex min-h-screen flex-col items-center justify-between overflow-hidden px-6 py-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-20 top-10 h-72 w-72 rounded-full bg-slate-300/25" />
        <div className="absolute -right-16 bottom-20 h-80 w-80 rounded-full bg-[#C8102E]/[0.07]" />
      </div>

      <div className="relative z-10 flex w-full max-w-4xl items-center justify-between">
        <Logo width={200} height={70} />
        <div className="rounded-2xl border border-slate-200 bg-white/95 px-5 py-3 text-right shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            Gate terminal
          </p>
          <p className="text-3xl font-bold tabular-nums text-slate-900">
            {now.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </p>
          <p className="text-sm text-slate-500">
            {now.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          </p>
        </div>
      </div>

      <div className="relative z-10 text-center">
        <p className="text-sm font-bold uppercase tracking-[0.25em] text-[#C8102E]">
          Night Shift Attendance
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-slate-900 md:text-5xl">
          {meta?.project.name || 'Loading…'}
        </h1>
        <p className="mt-2 text-lg text-slate-500">{meta?.project.locationLabel}</p>
        <p className="mt-5 text-xl font-medium text-slate-700">
          Scan with your phone to Check-in / Check-out
        </p>
      </div>

      <div className="relative z-10 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-200/70">
        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt="Attendance QR"
            className="h-[300px] w-[300px] md:h-[340px] md:w-[340px]"
          />
        ) : (
          <div className="grid h-[300px] w-[300px] place-items-center text-slate-400 md:h-[340px] md:w-[340px]">
            Generating QR…
          </div>
        )}
      </div>

      <div className="relative z-10 w-full max-w-md text-center">
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-[#C8102E] transition-all duration-1000 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-lg text-slate-700">
          New QR in <span className="font-bold text-amber-600">{secondsLeft}</span> seconds
        </p>
        {token ? (
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(token);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                setError('Could not copy token');
              }
            }}
            className="mt-3 rounded-xl bg-[#C8102E] px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
          >
            {copied ? 'Copied ✓' : 'Copy QR Token (for testing)'}
          </button>
        ) : null}
        {error ? <p className="mt-2 text-rose-600">{error}</p> : null}
        <p className="mt-4 text-sm text-slate-400">Safer workplaces. Brighter tomorrows.</p>
      </div>
    </main>
  );
}

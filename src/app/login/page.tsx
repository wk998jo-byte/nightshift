'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BrandButton, Logo } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (!d.user) return;
        if (d.user.role === 'EMPLOYEE') router.replace('/app');
        else router.replace('/dashboard');
      })
      .catch(() => undefined);
  }, [router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }
      if (data.role === 'EMPLOYEE') router.push('/app');
      else router.push('/dashboard');
    } catch {
      setError('Connection unavailable. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mesh-bg flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md animate-fade-up">
        <div className="mb-6 flex justify-center">
          <Logo width={280} height={100} />
        </div>

        <div className="glass-card rounded-3xl p-7">
          <div className="mb-6 text-center">
            <p className="text-[11px] font-bold tracking-[0.28em] text-[#C8102E]">WORKFORCE</p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">
              نظام حضور الشفت الليلي
            </h1>
            <p className="mt-2 text-sm text-slate-500">Night Shift Attendance</p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-600">
                Employee ID
              </label>
              <input
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3.5 text-slate-900 outline-none transition focus:border-[#C8102E] focus:bg-white focus:ring-4 focus:ring-rose-100"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-600">
                Password / PIN
              </label>
              <input
                type="password"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3.5 text-slate-900 outline-none transition focus:border-[#C8102E] focus:bg-white focus:ring-4 focus:ring-rose-100"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error ? (
              <p className="rounded-xl bg-rose-50 px-3 py-2 text-center text-sm text-rose-600">
                {error}
              </p>
            ) : null}
            <BrandButton type="submit" disabled={loading} className="w-full !py-3.5 !text-[15px]">
              {loading ? 'Signing in…' : 'Sign in'}
            </BrandButton>
          </form>
        </div>
      </div>
    </main>
  );
}

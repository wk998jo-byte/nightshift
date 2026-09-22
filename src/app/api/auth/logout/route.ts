import { NextRequest, NextResponse } from 'next/server';
import { sessionCookieOptions } from '@/lib/auth';
import { authNoStoreHeaders, clearSessionCookie } from '@/lib/session-policy';

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true }, { headers: authNoStoreHeaders() });
  const jar = res.cookies;
  clearSessionCookie(
    {
      set: (name, value, options) => jar.set(name, value, options),
      delete: (input) => jar.delete(input as { name: string; path: string }),
    },
    sessionCookieOptions(req)
  );
  return res;
}

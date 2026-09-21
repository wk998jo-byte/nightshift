# Night Shift Attendance System — Bin Quraya

PWA + rotating QR + mandatory GPS for night-shift sites.

## Local run

```bash
cp .env.example .env
cp .env.example .env.local
# Replace AUTH_SECRET and QR_SECRET with long random values
npm install
npm run db:prepare
npm run dev
```

On Windows PowerShell, copy `.env.example` to `.env` and `.env.local`, then replace the placeholder secrets before `db:prepare`.

## Replit

See **[REPLIT.md](./REPLIT.md)**. Set `AUTH_SECRET` and `QR_SECRET` in Replit Secrets — do not put real secrets in source files.

## Demo accounts

Development seed only. Not real employees.

| Role | Username | Password |
|------|----------|----------|
| Admin | admin | admin123 |
| Supervisor | EMP-0201 | 1234 |
| Employee | EMP-0147 | 1234 |
| Employee | EMP-0148 | 1234 |

- App: `/app`
- Dashboard: `/dashboard`
- QR Terminal: `/terminal/bin-quraya-dhahran`

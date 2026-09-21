# Replit setup for Night Shift Attendance (Bin Quraya)

## رفع المشروع على Replit

### الطريقة الأسهل
1. اضغط **Create Repl** → **Import from GitHub** (إذا رفعت المشروع على GitHub)
   أو **Upload folder / zip** للمجلد `night-shift-attendance`
2. اختر قالب **Node.js**
3. في **Secrets** أضف:
   - `DATABASE_URL` = `file:./dev.db`
   - `AUTH_SECRET` = أي نص طويل عشوائي
   - `QR_SECRET` = نص طويل عشوائي آخر
4. اضغط **Run**

الأمر الافتراضي يشغّل: تجهيز قاعدة البيانات + السيرفر على منفذ Replit.

حسابات التجربة (Demo فقط):

- Admin: `admin` / `admin123`
- Supervisor: `EMP-0201` / `1234`
- Employee: `EMP-0147` / `1234`

- تطبيق الموظف: `/app`
- لوحة الإدارة: `/dashboard`
- شاشة QR: `/terminal/bin-quraya-dhahran`

دخول الموظفين برقم البادج + PIN. دخول الإدارة بالحساب التجريبي أعلاه.

### أوامر مفيدة في Shell على Replit
```bash
npm install
npm run replit
# إعادة تعبئة البيانات التجريبية محلياً فقط (تمسح الصفوف الحالية):
RESET_DEMO=1 npx tsx prisma/seed.ts
```

### ملاحظات
- لا ترفع مجلدات `node_modules` أو `.next` أو ملفات `.env`
- لا تضع `AUTH_SECRET` أو `QR_SECRET` داخل ملفات المشروع
- SQLite كافية للتجربة على Replit
- للإنتاج لاحقاً يمكن تحويل `DATABASE_URL` إلى PostgreSQL

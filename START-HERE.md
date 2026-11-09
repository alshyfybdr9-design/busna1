# ابدأ من هنا — تشغيل باصنا خطوة بخطوة

هذا الدليل لمن يريد **رؤية النسخة الحالية وتجربتها** بأقل جهد. لا تحتاج خبرة برمجية للخطوات 1–3.

---

## الخطوة 1: ثبّت البرامج (مرة واحدة)

| البرنامج | الرابط | ملاحظة |
|---|---|---|
| Docker Desktop | https://www.docker.com/products/docker-desktop/ | يشغّل قاعدة البيانات والخادم والويب تلقائيًا. بعد التثبيت افتحه وانتظر حتى يظهر "Engine running" |
| Git | https://git-scm.com/downloads | لتنزيل المشروع |

> على ويندوز: إذا طلب Docker تفعيل WSL 2 وافق وأعد تشغيل الجهاز.

## الخطوة 2: نزّل المشروع

افتح Terminal (ماك) أو PowerShell (ويندوز) واكتب:

```bash
git clone -b busna-v2 https://github.com/alshyfybdr9-design/busna1.git busna
```

(النسخة الجديدة في الفرع `busna-v2`. الفرع `main` يحتوي النسخة السابقة كما هي.)

```bash
cd busna
```

## الخطوة 3: شغّل كل شيء بأمر واحد

```bash
docker compose up --build
```

أول تشغيل يأخذ 3–5 دقائق. عندما تظهر السطور:

```
api-1  | Seeded demo tenant DEMO01 ...
api-1  | [busna] starting API on port 4000
```

افتح المتصفح على: **http://localhost:5173**

### جرّب
1. في الصفحة الأولى اكتب رمز الجهة **`DEMO01`** ثم «متابعة».
2. ادخل بحساب مدير الجهة:
   - البريد: `admin@demo.busna.local`
   - كلمة المرور: `Demo-pass-2026`
3. جرّب: الطلاب ← إضافة طالب، المسارات ← تعيين الطالب لنقطة توقف، الرحلات ← إنشاء رحلة، لوحة التشغيل.

حسابات أخرى (نفس كلمة المرور):

| الحساب | الدور |
|---|---|
| `supervisor@demo.busna.local` | مشرف النقل (ويب) |
| `platform@demo.busna.local` | مدير المنصة (ويب) |
| `driver1@demo.busna.local` | سائق (تطبيق الجوال) |
| `parent1@demo.busna.local` | ولي أمر لطفلين (تطبيق الجوال) |

> كل هذه البيانات **مصطنعة** وموسومة «[تجريبي]». الخريطة تستخدم خوادم OpenStreetMap العامة (مناسبة للتجربة فقط).

### إيقاف وتشغيل لاحقًا
- إيقاف: اضغط `Ctrl+C` في نفس النافذة، أو:

```bash
docker compose down
```

- البدء من جديد بقاعدة بيانات فارغة (يحذف كل البيانات المحلية):

```bash
docker compose down -v
```

---

## الخطوة 4 (اختيارية): تجربة تطبيق الجوال

تطبيق السائق يحتاج **نسخة مبنية** (لا يعمل تتبع الخلفية في تطبيق Expo Go). أسهل طريق: محاكي أندرويد.

1. ثبّت **Node.js 22**: https://nodejs.org
2. ثبّت **Android Studio**: https://developer.android.com/studio — ثم من Device Manager أنشئ جهازًا افتراضيًا (مثل Pixel) وشغّله.
3. اترك `docker compose up` يعمل، وفي نافذة جديدة:

```bash
cd busna/apps/mobile
```

```bash
npm install
```

```bash
cp .env.example .env
```

(القيمة الافتراضية `http://10.0.2.2:4000` تجعل محاكي أندرويد يصل لخادمك المحلي.)

```bash
npx expo run:android
```

4. في التطبيق: اكتب `DEMO01` ← ادخل بـ `driver1@demo.busna.local` ← ابدأ الرحلة ← وافق على إذن الموقع «السماح دائمًا».
5. في المحاكي يمكنك تحريك الموقع من: ⋮ (Extended controls) ← Location.
6. سجّل خروجًا وادخل بـ `parent1@demo.busna.local` لترى حالة الطفل وآخر تحديث للموقع.

**على جوال حقيقي**: ضع في `apps/mobile/.env` عنوان IP لحاسوبك بدل `10.0.2.2` (مثل `http://192.168.1.20:4000`) وتأكد أن الجوال على نفس شبكة الواي فاي، ثم وصّل الجوال بكابل USB مع تفعيل «تصحيح USB» وشغّل نفس الأمر.

**iPhone** يحتاج جهاز ماك مع Xcode:

```bash
npx expo run:ios
```

---

## الخطوة 5 (لاحقًا): ديمو على الإنترنت برابط تشاركه

يحتاج حسابات باسمك — لا أستطيع إنشاؤها نيابة عنك:

| ماذا | أمثلة | لماذا |
|---|---|---|
| قاعدة بيانات PostgreSQL مُدارة | Neon، Supabase (كقاعدة فقط)، Render، AWS RDS | تخزين البيانات + نسخ احتياطي |
| استضافة للخادم (Docker) | Render، Railway، Fly.io | تشغيل `apps/api` |
| استضافة للويب | نفس المنصة أو Vercel/Netlify | تشغيل `apps/web` |
| نطاق (دومين) | أي مسجل نطاقات | روابط الدعوة وفتح التطبيق |
| حساب Expo + Apple Developer + Google Play | — | بناء التطبيق ونشره وإشعارات الجوال |

بعد إنشاء الحسابات: أعطني أسماء المنصات التي اخترتها وسأجهز ملفات النشر وإعداداتها.

---

## تحديث نسختك بعد أي تعديل جديد

1. أوقف المشروع: اضغط `Ctrl+C` في نافذة `docker compose`.
2. في PowerShell الصق هذا الأمر (ينزّل آخر نسخة ويستخرجها فوق القديمة ثم يشغّلها؛ بياناتك التجريبية تبقى):

```powershell
$dir = [Environment]::GetFolderPath('Desktop'); $zip = Join-Path $dir 'busna-update.zip'; Invoke-WebRequest https://github.com/alshyfybdr9-design/busna1/archive/refs/heads/busna-v2.zip -OutFile $zip; Expand-Archive $zip -DestinationPath $dir -Force; Set-Location (Join-Path $dir 'busna1-busna-v2'); docker compose up --build
```

3. لتطبيق الجوال (في نافذة أخرى) أعد تنزيل المكتبات ثم شغّل:

```powershell
cd $HOME\Desktop\busna1-busna-v2\apps\mobile
```

```powershell
npm.cmd install
```

```powershell
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL|Docker' -and $_.IPAddress -notmatch '^(169\.|127\.|172\.)' } | Select-Object -First 1).IPAddress; $env:REACT_NATIVE_PACKAGER_HOSTNAME = $ip; npx.cmd expo start --clear
```

---

## تفعيل «مساعد باصنا» (اختياري — يحتاج مفتاحًا)

بدون مفتاح يعمل كل شيء: قاعدة المعرفة، التذاكر، والطوارئ؛ والمساعد يوضح أنه غير مفعّل ولا يخمّن.

1. أنشئ حسابًا في https://console.anthropic.com وأنشئ **API Key** (الاستخدام مدفوع حسب الاستهلاك).
2. في مجلد المشروع `busna1-busna-v2` أنشئ ملفًا اسمه `.env` (بدون اسم قبل النقطة) يحتوي:

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=ضع_المفتاح_هنا
```

3. أعد التشغيل: `Ctrl+C` ثم `docker compose up --build`.

> المفتاح يبقى في الخادم فقط ولا يصل للتطبيق أو المتصفح. لا ترسله في المحادثة ولا ترفعه إلى GitHub (الملف `.env` مستثنى من الرفع).
> حدود الاستخدام اليومية لكل مستخدم وللجهة قابلة للضبط من: لوحة الويب ← الإعدادات ← مساعد باصنا.

---

## مشاكل شائعة

| المشكلة | الحل |
|---|---|
| `port is already allocated` | برنامج آخر يستخدم 5173 أو 4000 أو 5432 — أغلقه أو غيّر المنفذ في `docker-compose.yml` |
| الصفحة لا تفتح | تأكد أن السطر `starting API on port 4000` ظهر، ثم حدّث الصفحة |
| `429 Too Many Requests` عند تنزيل الصور | انتظر قليلًا أو سجّل الدخول: `docker login` |
| التطبيق يقول «لا يوجد اتصال بالخادم» | تحقق من `EXPO_PUBLIC_API_URL` في `apps/mobile/.env` ثم أعد البناء |

# دليل الاتصال — SRU Contact Directory · v2.0

**رابط التطبيق / Web app:** https://script.google.com/macros/s/AKfycbwVgb1FJNwUJWMBuBVUuYjV-SQsszRKRm_k9uVcAi89hGUbPRg6PwwDFXKQIQZWuNdp/exec

دليل منسوبي جامعة سليمان الراجحي مرتبط مباشرة بدليل Google Workspace للنطاق `sr.edu.sa`.
Sulaiman Al Rajhi University staff directory, read live from the `sr.edu.sa` Google Workspace directory.

| البيان | المصدر في Google Workspace |
|---|---|
| الاسم | Name |
| البريد الإلكتروني | Primary email |
| الجوال | Phone — type **Mobile** (أو أي رقم سعودي يبدأ بـ 05) |
| الهاتف الداخلي | Phone — type **Work** بأرقام ≤ 5 خانات، أو صيغة `ext 1234` |
| الإدارة / المسمى | Employee information → Department / Job title |

## هيكل المستودع / Repo structure
```
ContactDirectory-v2.0/
├── index.html            ← شاشة دخول ITOC (GitHub Pages) ← توجه إلى تطبيق Apps Script
├── apps-script/
│   ├── Code.gs           ← الخادم: قراءة الدليل، الذاكرة المؤقتة، السجل، الاستثناءات
│   ├── Index.html        ← واجهة الدليل والبحث
│   ├── Denied.html       ← رسالة الحسابات غير الجامعية
│   └── appsscript.json   ← الإعدادات + People API + صلاحيات النشر
├── README.md
└── CHANGELOG.md
```

## خطوات النشر / Deployment (≈ 15 دقيقة)
1. **script.google.com** ← مشروع جديد باسم `SRU Contact Directory` (بحساب مسؤول ICTD).
2. Project Settings ← فعّل *Show "appsscript.json"* ← الصق محتوى `appsscript.json`.
3. أنشئ الملفات `Code.gs` و `Index` و `Denied` والصق محتواها.
4. Services ← تأكد من إضافة **People API** (يُضاف تلقائياً من appsscript.json).
5. اختر الدالة `setup` ← Run ← وافق على الصلاحيات.
   سيُنشئ: Google Sheet بورقتي `SignInLog` و `Overrides`، ومشغّل تحديث كل ساعة، وأول نسخة من الدليل.
6. Deploy ← New deployment ← Web app:
   - Execute as: **Me**
   - Who has access: **Anyone within Sulaiman Al Rajhi University**
7. انسخ رابط `/exec` وضعه مكان `WEB_APP_URL` في `index.html`، ثم ارفع المجلد إلى GitHub (مثل `ICTSRU/Directory`) وفعّل GitHub Pages.
8. أضف رابط الصفحة إلى بوابة ITOC: `https://ictsru.github.io/ITOC/#forms`.

## متطلبات Google Admin (مرة واحدة)
- Admin console ← Directory ← **Directory settings** ← *Contact sharing*: مفعّل للنطاق.
- لظهور أرقام الجوال: Directory ← *Profile visibility* — تأكد أن حقل الهاتف مسموح بمشاركته داخل النطاق.
- أرقام الجوال والتحويلات تُدخل في ملف المستخدم (User ← User information ← Contact information ← Phone).

## الإعدادات (أعلى `Code.gs`)
| المفتاح | الوظيفة |
|---|---|
| `SHOW_MOBILE` | إظهار/إخفاء الجوال للجميع |
| `ADMINS` | مشرفو التصدير والتحديث الفوري |
| `EXTENSION_MAX_DIGITS` | الحد الأقصى لخانات التحويلة |
| `LOGOS` | المصدر الموحد لشعارات SRU / ICTD / ITOC |

## مصدر بديل: ورقة `Directory` (v2.0)
إذا تعذّر استخدام People API (سياسة Google Workspace مثلاً)، يقرأ النظام تلقائياً من ورقة `Directory` في ورقة الخلفية:
- Google Admin ← Users ← **Download users** ← CSV ← الصق المحتوى كما هو في ورقة `Directory`، أو
- أدخل الأعمدة يدوياً: الاسم، البريد، الجوال، التحويلة، الإدارة، المسمى.

تُطابَق الأعمدة بالاسم (عربي أو إنجليزي)، ولا يلزم ترتيب معيّن. لتعطيل People API نهائياً: `USE_PEOPLE_API: false`.

## ورقة الاستثناءات `Overrides`
لإضافة تحويلة غير موجودة في Workspace أو تصحيحها أو إخفاء حساب (مثل الحسابات الخدمية):

| Email | NameAr | Extension | Mobile | Department | Title | Hidden |
|---|---|---|---|---|---|---|
| it.helpdesk@sr.edu.sa | | | | | | نعم |
| user@sr.edu.sa | الاسم بالعربي | 2145 | | | | |

تظهر التعديلات بعد التحديث التالي (كل ساعة) أو فوراً بزر **تحديث** للمشرفين.

---
الإدارة التنفيذية للاتصالات وتقنية المعلومات · IT Operations Center (ITOC) · الإصدار 2.0

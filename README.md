# Hermes Persian UI

یک رابط وب فارسی‌محور، محلی و تک‌کاربره برای
[Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) است.
برنامه به gateway واقعی Hermes متصل می‌شود، پاسخ را به‌صورت streaming نمایش
می‌دهد و session، tool activity، approval و سایر کنترل‌ها را فقط وقتی backend
واقعاً آن‌ها را اعلام کند در دسترس می‌گذارد. رابط انگلیسی نیز در `/en` موجود
است، اما مسیر پیش‌فرض `/fa` و جهت shell در آن RTL است.

> این UI برای bind روی loopback طراحی شده است. آن را مستقیماً روی LAN یا
> اینترنت منتشر نکنید.

## نیازمندی‌ها

- Node.js `22.22.3` (در `.nvmrc` تثبیت شده است)
- pnpm `10.33.3` از طریق Corepack
- Hermes Agent `v0.18.2` برای اتصال زنده
- یک provider معتبر در Hermes؛ UI credential مدل را دریافت یا ذخیره نمی‌کند

وضعیت محلی Hermes را پیش از نصب UI بررسی کنید:

```sh
hermes --version
hermes status
```

این پروژه تنظیمات `~/.hermes` یا provider پیش‌فرض را تغییر نمی‌دهد. تغییر مدل
از model picker فقط به session فعال تعلق دارد. به‌ویژه مسیر
`gpt-5.6-sol`/OpenAI Codex باید در خود Hermes مدیریت شود، نه در این UI.

## نصب و اجرا

```sh
nvm use
corepack enable
corepack prepare pnpm@10.33.3 --activate
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

سپس [http://127.0.0.1:3000/fa](http://127.0.0.1:3000/fa) را باز کنید.
`pnpm dev` یک custom Node server را اجرا می‌کند؛ اجرای مستقیم `next dev` مسیر
WebSocket relay و مدیریت lifecycle Hermes را دور می‌زند و پشتیبانی نمی‌شود.

برای build تولیدی:

```sh
pnpm build
pnpm start
```

### حالت managed (پیش‌فرض)

با `HERMES_BACKEND_MODE=managed`، server برنامه فرمان زیر را به‌صورت child
process و فقط روی loopback اجرا می‌کند، port اختصاص‌یافته را از پیام readiness
می‌خواند و WebSocket را در `/api/hermes/ws` relay می‌کند:

```sh
hermes serve --host 127.0.0.1 --port 0
```

توکن تصادفی بالادستی فقط در حافظهٔ server می‌ماند. هنگام shutdown فقط همان
process که این برنامه ساخته متوقف می‌شود؛ daemon یا sessionهای مستقل Hermes
دست‌کاری نمی‌شوند.

### حالت external

اگر gateway از قبل اجراست، `.env.local` را به شکل زیر تنظیم کنید:

```dotenv
HERMES_BACKEND_MODE=external
HERMES_WS_URL=ws://127.0.0.1:9119/api/ws
HERMES_WS_TOKEN=
HERMES_BASE_URL=http://127.0.0.1:9119
HERMES_API_KEY=
```

gateway راه‌دور را با tunnel به loopback محلی بیاورید؛ برای نمونه:

```sh
ssh -N -L 9119:127.0.0.1:9119 user@example-host
```

سپس `HERMES_WS_URL` را همان `ws://127.0.0.1:9119/api/ws` نگه دارید. از
`ws://public-host` یا bind عمومی UI استفاده نکنید. TLS termination و احراز
هویت remote endpoint مسئولیت اپراتور است.

## متغیرهای محیطی

| متغیر | پیش‌فرض/نمونه | کاربرد |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | bind UI؛ مقدار غیر-loopback عمداً رد می‌شود |
| `PORT` | `3000` | port UI |
| `HERMES_BACKEND_MODE` | `managed` | `managed` یا `external` |
| `HERMES_COMMAND` | `hermes` | executable مورد اعتماد در managed mode |
| `HERMES_WS_URL` | `ws://127.0.0.1:9119/api/ws` | gateway در external mode |
| `HERMES_WS_TOKEN` | خالی | credential سمت server برای WebSocket خارجی |
| `HERMES_BASE_URL` | `http://127.0.0.1:9119` | ریشهٔ HTTP fallback خارجی |
| `HERMES_API_KEY` | خالی | API key سمت server برای HTTP خارجی |
| `HERMES_PROFILE` | خالی | profile اولیه؛ خالی یعنی default Hermes |

مقادیر secret را فقط در `.env.local` نگه دارید. متغیرهای بالا نباید پیشوند
`NEXT_PUBLIC_` بگیرند و هرگز نباید در localStorage، URL یا log نوشته شوند.

## معماری اتصال

مرز `HermesTransport`، React را از شکل wire جدا می‌کند. transport اصلی،
JSON-RPC 2.0 روی WebSocket و حداقل desktop contract `v2` است. contractهای
monotonic جدیدتر Hermes (از جمله `v3` در patch فعلی `v0.18.2`) به‌عنوان superset
پذیرفته می‌شوند؛ contract مستقل bootstrap/BFF همچنان `v2` است. پیام‌های ورودی
با schemaهای runtime اعتبارسنجی و سپس به event model مشترک تبدیل می‌شوند. شناسهٔ ذخیره‌شدهٔ
session در URL پایدار است؛ شناسهٔ runtime بعد از reconnect می‌تواند عوض شود.

در external mode ترتیب negotiation چنین است:

1. TUI Gateway WebSocket
2. `/v1/capabilities` و Runs/SSE، اگر backend آن را advertise کند
3. Responses API با SSE
4. Chat Completions با SSE به‌عنوان compatibility fallback

وجود endpoint حدس زده نمی‌شود. خطای JSON-RPC `method not found` نیز capability
مربوط را غیرفعال می‌کند. کنترل unsupported پنهان یا با دلیل روشن disabled
می‌شود؛ دکمهٔ نمایشی که endpoint واقعی ندارد در مسیر production وجود ندارد.
SSE بدون buffer اضافی از BFF عبور می‌کند و cancellation از `AbortController`
استفاده می‌کند. ID رویداد، request، tool و connection epoch از تکرار delta پس
از reconnect جلوگیری می‌کنند؛ prompt قبلی خودکار دوباره submit نمی‌شود.

در حالت HTTP-only، UI یک conversation موقت و page-local برای نگهداری context
می‌سازد و Runs را با `POST /v1/runs`، stream را با
`GET /v1/runs/:id/events` و توقف را با `POST /v1/runs/:id/stop` اجرا می‌کند.
این conversation بعد از refresh قابل resume نیست و session CRUD، tool prompt،
approval، attachment و سایر کنترل‌هایی که HTTP fallback ایمن ارائه نمی‌کند
عمداً غیرفعال می‌مانند. Responses و Chat Completions نیز فقط streaming متن و
cancellation همان request را فراهم می‌کنند.

مسیرهای عمومی برنامه:

- `/fa` و `/en`: خانهٔ chat با locale و direction واقعی
- `/fa/c/:storedSessionId` و `/en/c/:storedSessionId`: session پایدار
- `/fa/settings` و `/en/settings`: تنظیمات غیرحساس UI
- `/api/hermes/bootstrap`: health/capability bootstrap بدون افشای credential
- `/api/hermes/ws`: relay هم‌مبدأ به gateway
- `/api/hermes/sessions?profile=…`: فهرست read-only همان profile از
  `/api/profiles/sessions`؛ مقدار `all`، profile تکراری و ردیف بدون برچسب profile
  رد می‌شوند

فهرست تاریخی sessionها عمداً از RPC `session.list` خوانده نمی‌شود، چون آن
متد به profile همان gateway محدود است و روی هر ردیف مالکیت profile را تضمین
نمی‌کند. BFF فقط یک نام profile معتبر را به Hermes می‌فرستد، filterهای تجمیعی
مرورگر را حذف می‌کند و transport در صورت خطای خواندن `state.db` یا دریافت حتی
یک ردیف از profile دیگر، کل پاسخ را fail-closed رد می‌کند. با تعویض profile،
query cache، session فعال و transcript قبلی نیز از UI جدا می‌شوند. draft،
صف ارسال، attachment، model override و artifact با کلید ترکیبی profile و
`storedSessionId` در حافظه namespace می‌شوند؛ این namespace شناسهٔ URL یا
شناسه‌ای که برای Hermes فرستاده می‌شود را تغییر نمی‌دهد.

rename و delete تاریخی نیز از BFF به REST واقعی Hermes فرستاده می‌شوند:
`PATCH /api/sessions/:id` با profile در body و
`DELETE /api/sessions/:id?profile=…`. برای جلوگیری از حذف DB زیر runtime دیگر،
delete روی ردیف active غیرجاری نمایش داده نمی‌شود؛ runtime جاری ابتدا close و
سپس از همان profile حذف می‌شود.

## راهبرد فارسی و BiDi

جهت shell از locale می‌آید، اما جهت هر paragraph، heading، list item، quote و
table cell مستقل و با `dir="auto"` تعیین می‌شود. `unicode-bidi: plaintext` و
`text-align: start` اجازه می‌دهد اولین نویسهٔ قوی مبنای همان block باشد.
URL، path، model ID، acronym و inline code با isolation معنایی رندر می‌شوند؛
هیچ LRM/RLM یا embedding پنهانی به متن اصلی اضافه نمی‌شود.

code، terminal، JSON/YAML، diff، stack trace و URL فنی همیشه LTR هستند. Copy از
raw source ذخیره‌شده انجام می‌شود، نه `textContent` تزئین‌شدهٔ DOM؛ در نتیجه
clipboard دقیقاً با ورودی منطقی برابر است. corpus ثابت ده‌گانه در
`tests/fixtures/bidi.ts` punctuation، slash، colon، percent، currency، path،
paragraph مستقل، link و code میان دو paragraph RTL را پوشش می‌دهد.

فونت‌ها self-hosted هستند: Vazirmatn Variable برای فارسی، Inter Variable برای
لاتین و JetBrains Mono Variable برای محتوای فنی. محتوای code، path و URL هرگز
localize یا به ارقام فارسی تبدیل نمی‌شود.

## امنیت

- server فقط hostهای loopback و Origin هم‌مبدأ را برای HTTP/WS می‌پذیرد.
- credentialهای Hermes فقط سمت server هستند و به bootstrap response یا bundle
  مرورگر نمی‌رسند.
- بدنهٔ secret request، password sudo و tokenها log یا persist نمی‌شوند.
- Markdown sanitize می‌شود؛ link خارجی `noopener noreferrer` دارد.
- HTML ناشناس فقط در iframe بدون `allow-scripts` و `allow-same-origin` نمایش
  داده می‌شود. PDF خام preview ساختگی ندارد.
- CSP، security header، محدودیت frame/upload و redaction روی BFF اعمال می‌شود.
- سقف frame در relay برابر 70 MiB است تا PDF خام 50 MiB پس از base64 و سربار
  JSON-RPC جا شود؛ این مقدار همچنان hard cap است. recording خام در UI حداکثر
  25 MiB و بدنهٔ JSON transcription حداکثر 35 MiB است تا expansion پایهٔ 64
  بدون افزایش حد فایل خام پشتیبانی شود.
- `HERMES_TEST_MODE=1` در `NODE_ENV=production` پیش از startup با خطا رد می‌شود.
- YOLO پیش‌فرض خاموش است و فقط در صورت وجود command واقعی و پس از هشدار فعال
  می‌شود.

برای بررسی bundle، هر تغییر که secret یا `NEXT_PUBLIC_HERMES_*` اضافه می‌کند
را blocker امنیتی در نظر بگیرید.

## آزمون‌ها

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:visual
pnpm build
pnpm smoke:hermes
```

`pnpm test:e2e` با `HERMES_TEST_MODE=1` backend قطعی و فقط مخصوص test را اجرا
می‌کند؛ mock وارد production bundle نمی‌شود. visual baselineها باید هنگام
تغییر عمدی UI با دستور مستند در [`docs/testing.md`](docs/testing.md) بازبینی
شوند. smoke زنده در حالت پیش‌فرض فقط اتصال، کشف route، ساخت session موقت و
cleanup آن را بررسی می‌کند و هیچ promptی نمی‌فرستد. اجرای یک turn کم‌هزینه و
احتمالاً billable فقط با opt-in صریح زیر انجام می‌شود:

```sh
HERMES_SMOKE_ALLOW_BILLING=1 pnpm smoke:hermes
```

جزئیات cleanup و معیار قبولی در همان سند آمده است.

## رفع اشکال

### صفحه روی «در حال اتصال» می‌ماند

```sh
hermes --version
hermes serve --status
hermes status
```

در managed mode بررسی کنید `HERMES_COMMAND` از محیطی که `pnpm dev` را اجرا
کرده‌اید قابل دسترس باشد. در external mode URL، tunnel و token را بررسی کنید.
خطای protocol incompatible معمولاً یعنی Hermes نصب‌شده desktop contract کمتر
از `v2` یا بدون contract ارائه می‌کند؛ UI payload ناشناخته را به‌اجبار تفسیر
نمی‌کند.

### خطای authentication

credential را در `.env.local` اصلاح و server را restart کنید. token را در
DevTools یا localStorage وارد نکنید. login provider مدل با خود Hermes انجام
می‌شود، برای مثال وضعیت OpenAI Codex باید در `hermes status` معتبر باشد.

### HTTP fallback یا voice دیده نمی‌شود

این قابلیت‌ها capability-gated هستند. API Server یا provider صوتی غیرفعال،
خرابی chat اصلی محسوب نمی‌شود؛ gateway WebSocket همچنان مسیر اصلی است.

### attachment رد می‌شود

نوع و اندازهٔ فایل را بررسی کنید. backend ممکن است فقط image را پشتیبانی کند؛
UI در این حالت فایل عمومی یا PDF را attached وانمود نمی‌کند.

### build درست است اما WebSocket در production قطع می‌شود

برنامه را با `pnpm start` اجرا کنید، نه `next start`. reverse proxy محلی نیز
باید WebSocket upgrade را برای `/api/hermes/ws` عبور دهد و Origin را تغییر
ندهد.

## محدودیت‌های شناخته‌شده

- انتشار چندکاربره، login UI و bind مستقیم روی شبکه در این نسخه نیست.
- pin/archive، pagination، arbitrary file upload، voice، reasoning option و
  HTTP fallback فقط وقتی backend نصب‌شده advertise کند ظاهر می‌شوند.
- PDF بدون viewer امن داخلی attach می‌شود اما preview درون‌برنامه‌ای ندارد.
- برنامه config سراسری Hermes، provider route، cron، MCP یا pluginها را مدیریت
  نمی‌کند.
- نبود capability اختیاری با UI ساختگی جبران نمی‌شود و در connection/settings
  report قابل مشاهده می‌ماند.

## مجوزها و داده‌ها

کد این پروژه تحت [MIT License](LICENSE) منتشر شده است. Fontsource بسته‌های
Vazirmatn، Inter و JetBrains Mono را همراه license upstream
نصب می‌کند. transcript و artifact از Hermes می‌آیند؛ UI فقط preferenceهای
غیرحساس مانند theme و locale را در مرورگر نگه می‌دارد.

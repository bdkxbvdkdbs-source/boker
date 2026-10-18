# Bokerr Backend

Cloudflare Worker للـBokerr guest sessions والطاولات المباشرة، مع محرك Texas Hold'em وOmaha مبني على `boardgame.io`.

## معمارية اللعب

- `src/poker.ts` يعرّف قواعد اللعبة كـboardgame.io Game: المقاعد، ترتيب الأدوار، الرهانات، call/check/fold/bet/raise/all-in، كشف البطاقات، تقييم الأيدي، side pots وتوزيع الرصيد الافتراضي.
- `PokerTable` Durable Object هو المسؤول السلطوي الوحيد عن حالة كل طاولة واتصالات WebSocket الخاصة بها.
- `src/boardgame-storage.ts` يوفّر `boardgame.io` StorageAPI غير متزامن فوق Durable Object storage، ليُحفظ `G` و`ctx` وسجل الحركات عند إعادة تشغيل Worker.
- يستخدم Worker `boardgame.io` Master ويدير WebSocket transport مخصصاً متوافقاً مع واجهة Bokerr؛ لا يُشغّل خادم Node أو Socket.IO داخل Cloudflare.
- `SESSION_KV` يحفظ بيانات الجلسة فقط؛ لا تُخزّن حالة الدور الحي في KV. رمز الجلسة عشوائي، ويُخزّن في KV باستخدام SHA-256 وينتهي بعد 30 يوماً.
- أوراق اللاعب الخاصة تُعاد لصاحبها وحده، كما يحذف `playerView` سجل undo/redo من الرسائل الخارجة. الرصيد في الطاولات رصيد لعبة افتراضي، وليس مدفوعات أو محفظة مالية.

## واجهات HTTP وWebSocket

- `GET /health`
- `GET /api/tables`
- `POST /api/session` ينشئ جلسة ضيف ويرجع `{ token, session }`؛ استخدم `Authorization: Bearer <token>` مع `GET`, `PUT`, `DELETE /api/session`.
- `wss://<worker>/ws/berlin-9max` لطاولة Texas و`wss://<worker>/ws/london-5max` لطاولة Omaha. يستخدم الاتصال البروتوكولين `bokerr-v1` ورمز الجلسة؛ لا يُوضع الرمز في URL.
- رسائل الحركة هي JSON: `{ type, actionId, stateID, amount? }` حيث `stateID` رقم الحالة الحالي، و`actionId` UUID فريد لمنع إعادة الطلب. الأنواع: `start`, `startNextHand`, `fold`, `check`, `call`, `bet`, `raise`, `allIn`.
- `bet.amount` هو قيمة الرهان على الجولة؛ `raise.amount` هو إجمالي رهان اللاعب المستهدف على الجولة. يرفض Worker الدور الخطأ والحالة القديمة والمبلغ غير الصحيح.
- رسائل الخادم تشمل `ready`, `presence`, `state`, `round_started`, `action`, `showdown`, `error`. تتضمن `state` رقم الحالة، البطاقات المجتمعية، بطاقات اللاعب الخاصّة، مقدار النداء والرفع الأدنى والمقاعد والرصيد الافتراضي.

## الجلسات وواجهة العميل

- واجهة React في مستودع `bokerr` تستخدم `VITE_BOKERR_API_BASE_URL`، والافتراضي `https://bokerr-api.bdkxbvdkdbs.workers.dev`.
- Android WebView يستخدم API ذاته ويخزن رمز الجلسة في تفضيلات التطبيق الخاصة، لا في URL.
- يُسمح في CORS بـAndroid WebView (`https://appassets.androidplatform.net`) وGitHub Pages الخاص بالمستودع وأصول التطوير المحلية؛ حدّث `ALLOWED_ORIGINS` في `wrangler.toml` إذا تغيّر عنوان الواجهة.
- لا تضع `ADMIN_TOKEN` أو `CLOUDFLARE_API_TOKEN` داخل التطبيق أو المستودع. سير نشر GitHub Actions يحتاج Secret باسم `CLOUDFLARE_API_TOKEN`.

## التطوير والفحوص والنشر

```bash
npm ci
npm run typecheck
npm test
npx wrangler dev
npm run deploy
```

يبدأ سير العمل `.github/workflows/deploy.yml` عند push إلى `main`؛ يجري typecheck والاختبارات ثم ينشر Worker. تحتفظ إعدادات Wrangler بربط D1 و`SESSION_KV` وDurable Object الحالي؛ لا يتطلب هذا التغيير إسقاط بيانات D1 أو حذف namespace قائم.

## وظائف أقدم محفوظة

تظل جداول D1 التاريخية ولوحات الإدارة الحالية كما هي. لا يضيف Worker هذا مسارات إيداع أو سحب أو SMS؛ هذه اللعبة لا تنفذ مدفوعات حقيقية.

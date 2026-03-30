require("dotenv").config();
const keepAlive = require("./keep_alive");
const { Telegraf, Markup } = require("telegraf");
const fs   = require("fs");
const path = require("path");
const {
    registerQuizHandlers,
    getGlobalLeaderboard,
    setGlobalLeaderboard,
} = require("./quiz");

// ══════════════════════════════════════════════════════════════════════════════
//  КОНФИГУРАЦИЯ
// ══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    BOT_TOKEN:    process.env.BOT_TOKEN,
    ADMIN_ID:     Number(process.env.ADMIN_ID),
    CHANNEL:      "@vortas_store",
    SUPPORT:      "@vortashelp",
    DESIGNER:     "@vortasdesign",
    WEBSITE:      "https://vortas.store",
    DATA_FILE:    path.join(__dirname, "data.json"),
    IMAGES_PATH:  path.join(__dirname, "images"),
    MINI_APP_URL: process.env.MINI_APP_URL || "https://vortas.store/order.html",
};

if (!CONFIG.BOT_TOKEN)  { console.error("❌ BOT_TOKEN не найден");  process.exit(1); }
if (!CONFIG.ADMIN_ID)   { console.error("❌ ADMIN_ID не найден");   process.exit(1); }

const bot = new Telegraf(CONFIG.BOT_TOKEN, {
    handlerTimeout: 30_000,
    telegram: { webhookReply: false },
});

// ══════════════════════════════════════════════════════════════════════════════
//  ХРАНИЛИЩЕ
// ══════════════════════════════════════════════════════════════════════════════
let store = {
    orders:      [],
    users:       new Map(),
    orderStates: new Map(),
};

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
function loadData() {
    try {
        if (fs.existsSync(CONFIG.DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, "utf8"));
            store.orders = data.orders || [];
            store.users  = new Map(Array.isArray(data.users) ? data.users : []);
            // Восстанавливаем лидерборд викторины
            setGlobalLeaderboard(data.quizLeaderboard || {});
            console.log(
                `✅ Данные загружены: ${store.orders.length} заказов, ` +
                `${store.users.size} польз., ` +
                `${Object.keys(getGlobalLeaderboard()).length} quiz-игроков`,
            );
        }
    } catch (e) {
        console.error("⚠️ Ошибка загрузки:", e.message);
    }
}

function saveData() {
    try {
        fs.writeFileSync(
            CONFIG.DATA_FILE,
            JSON.stringify(
                {
                    orders:          store.orders,
                    users:           Array.from(store.users.entries()),
                    quizLeaderboard: getGlobalLeaderboard(),
                },
                null,
                2,
            ),
        );
    } catch (e) {
        console.error("⚠️ Ошибка сохранения:", e.message);
    }
}

loadData();
setInterval(saveData, 60_000);

// ══════════════════════════════════════════════════════════════════════════════
//  УТИЛИТЫ
// ══════════════════════════════════════════════════════════════════════════════
const esc = (t) =>
    String(t || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const fmtDate = (ts) =>
    new Date(ts).toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
    });

const genOrderId   = () =>
    `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

const genTrackCode = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code, exists = true;
    while (exists) {
        code   = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
        exists = store.orders.some((o) => o.trackCode === code);
    }
    return code;
};

const STATUS_MAP = {
    pending:    { text: "Ожидает подтверждения", emoji: "⏳" },
    accepted:   { text: "Подтверждён",           emoji: "✅" },
    confirmed:  { text: "Подтверждён",           emoji: "✅" },
    processing: { text: "В процессе выполнения", emoji: "⚙️" },
    completed:  { text: "Выполнен",              emoji: "🎉" },
    rejected:   { text: "Отклонён",              emoji: "❌" },
    cancelled:  { text: "Отменён",               emoji: "🚫" },
};
const getStatus = (s) => STATUS_MAP[s] || { text: s, emoji: "❓" };

function saveUser(ctx) {
    const { id, first_name, username } = ctx.from;
    if (!store.users.has(id)) {
        store.users.set(id, { id, firstName: first_name, username, joinedAt: Date.now(), ordersCount: 0 });
    }
    const u = store.users.get(id);
    u.ordersCount = store.orders.filter((o) => o.userId === id).length;
}

function clearState(uid) { store.orderStates.delete(uid); }

function getStats() {
    const now = Date.now();
    return {
        totalOrders:      store.orders.length,
        totalUsers:       store.users.size,
        pendingOrders:    store.orders.filter((o) => o.status === "pending").length,
        processingOrders: store.orders.filter((o) => o.status === "processing").length,
        completedOrders:  store.orders.filter((o) => o.status === "completed").length,
        rejectedOrders:   store.orders.filter((o) => ["rejected", "cancelled"].includes(o.status)).length,
        todayOrders:      store.orders.filter((o) => now - o.createdAt < 86_400_000).length,
        quizPlayers:      Object.keys(getGlobalLeaderboard()).length,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
//  СОЗДАНИЕ ЗАКАЗА
// ══════════════════════════════════════════════════════════════════════════════
async function createOrder(userId, orderData, source = "bot") {
    const orderId   = genOrderId();
    const trackCode = genTrackCode();
    const order = {
        id:           orderId,
        trackCode,
        userId,
        clientName:   orderData.clientName   || "Неизвестно",
        username:     orderData.username      || "",
        contactType:  orderData.contactType   || "Telegram",
        contactField: orderData.contactField  || "",
        product:      orderData.product       || "Не указано",
        payment:      orderData.payment       || "Не указано",
        urgency:      orderData.urgency       || "Стандарт",
        comment:      orderData.comment       || "",
        status:       "pending",
        createdAt:    Date.now(),
        source,
        history: [{ status: "pending", timestamp: Date.now() }],
    };
    store.orders.push(order);
    saveData();

    try {
        await bot.telegram.sendMessage(CONFIG.ADMIN_ID, MSG.newOrder(order), {
            parse_mode: "HTML",
            ...KB.adminOrderActions(orderId),
        });
    } catch (e) {
        console.error("Ошибка уведомления админа:", e.message);
    }

    return { orderId, trackCode, order };
}

// ══════════════════════════════════════════════════════════════════════════════
//  КЛАВИАТУРЫ
// ══════════════════════════════════════════════════════════════════════════════
const KB = {
    main: () =>
        Markup.keyboard([
            ["📦 Каталог", Markup.button.webApp("🛒 Оформить заказ", CONFIG.MINI_APP_URL)],
            ["🔍 Отследить заказ", "💳 Оплата"],
            ["❓ Помощь", "📞 Контакты"],
        ]).resize(),

    adminInline: () =>
        Markup.inlineKeyboard([
            [
                Markup.button.callback("📊 Статистика",   "admin_stats"),
                Markup.button.callback("📋 Заказы",       "admin_orders_view"),
            ],
            [
                Markup.button.callback("👥 Пользователи", "admin_users"),
                Markup.button.callback("📢 Рассылка",     "admin_broadcast"),
            ],
            [
                Markup.button.callback("➕ Создать заказ", "admin_create_order"),
                Markup.button.callback("🎮 Quiz-рейтинг", "admin_quiz_scores"),
            ],
            [Markup.button.callback("🔒 Закрыть панель", "back_main")],
        ]),

    mainInline: () =>
        Markup.inlineKeyboard([
            [
                Markup.button.callback("📦 Каталог",   "cat_menu"),
                Markup.button.callback("🔍 Отследить", "track_menu"),
            ],
            [
                Markup.button.callback("💳 Оплата",   "payment_menu"),
                Markup.button.callback("❓ Помощь",   "help_menu"),
            ],
            [Markup.button.callback("📞 Контакты",    "contacts_menu")],
        ]),

    adminOrderSingle: (orderIndex, totalOrders, orderId) => {
        const nav = [];
        if (orderIndex > 0)
            nav.push(Markup.button.callback("◀️ Назад", `ao_${orderIndex - 1}`));
        nav.push(Markup.button.callback(`${orderIndex + 1} / ${totalOrders}`, "noop"));
        if (orderIndex < totalOrders - 1)
            nav.push(Markup.button.callback("Далее ▶️", `ao_${orderIndex + 1}`));
        return Markup.inlineKeyboard([
            nav,
            [
                Markup.button.callback("✅ Принят",    `adm_a_${orderId}`),
                Markup.button.callback("⚙️ В работе",  `adm_p_${orderId}`),
            ],
            [
                Markup.button.callback("🎉 Готов",    `adm_c_${orderId}`),
                Markup.button.callback("❌ Отклонён", `adm_r_${orderId}`),
            ],
            [
                Markup.button.callback("💬 Клиенту",  `adm_msg_${orderId}`),
                Markup.button.callback("🗑 Удалить",   `adm_del_${orderId}`),
            ],
            [Markup.button.callback("◀️ Админка", "back_admin")],
        ]);
    },

    adminOrderActions: (orderId) =>
        Markup.inlineKeyboard([
            [
                Markup.button.callback("✅ Принят",    `adm_a_${orderId}`),
                Markup.button.callback("⚙️ В работе",  `adm_p_${orderId}`),
            ],
            [
                Markup.button.callback("🎉 Готов",    `adm_c_${orderId}`),
                Markup.button.callback("❌ Отклонён", `adm_r_${orderId}`),
            ],
            [
                Markup.button.callback("💬 Написать клиенту", `adm_msg_${orderId}`),
                Markup.button.callback("🗑 Удалить",           `adm_del_${orderId}`),
            ],
            [Markup.button.callback("📋 Все заказы", "admin_orders_view")],
        ]),

    adminSelectProduct: () =>
        Markup.inlineKeyboard([
            [Markup.button.callback("🎨 VEXILLUM",          "mp_vexillum")],
            [Markup.button.callback("🖼 EFFIGY",             "mp_effigy")],
            [Markup.button.callback("📸 TENEBRATION",        "mp_tenebration")],
            [Markup.button.callback("🎭 PACTLINGS",          "mp_pactlings")],
            [Markup.button.callback("◀️ В админку",          "back_admin")],
        ]),

    adminSelectPayment: () =>
        Markup.inlineKeyboard([
            [
                Markup.button.callback("🇷🇺 Рубли",   "mpay_rub"),
                Markup.button.callback("🇺🇸 Доллары", "mpay_usd"),
            ],
            [Markup.button.callback("◀️ В админку", "back_admin")],
        ]),

    adminSelectUrgency: () =>
        Markup.inlineKeyboard([
            [Markup.button.callback("📅 Стандарт (3-13 дней)",  "murg_standard")],
            [Markup.button.callback("🕐 Срочно (1-6 дней)",      "murg_fast")],
            [Markup.button.callback("⚡ Очень срочно (1-3 дня)", "murg_veryfast")],
            [Markup.button.callback("🔥 Сверхсрочно (24 часа)", "murg_superfast")],
            [Markup.button.callback("◀️ В админку",              "back_admin")],
        ]),

    adminBack: () =>
        Markup.inlineKeyboard([[Markup.button.callback("◀️ В админку", "back_admin")]]),

    catalog: () =>
        Markup.inlineKeyboard([
            [Markup.button.callback("🎨 VEXILLUM — Графика",       "cat_vexillum")],
            [Markup.button.callback("🖼 EFFIGY — Постеры",          "cat_effigy")],
            [Markup.button.callback("📸 TENEBRATION — Фото",        "cat_tenebration")],
            [Markup.button.callback("🎭 PACTLINGS — Персонажи",     "cat_pactlings")],
            [Markup.button.callback("◀️ Главное меню",              "back_main")],
        ]),

    product: () =>
        Markup.inlineKeyboard([
            [
                Markup.button.callback("◀️ Каталог", "back_catalog"),
                Markup.button.callback("🏠 Меню",    "back_main"),
            ],
        ]),

    orderStatus: () =>
        Markup.inlineKeyboard([[Markup.button.callback("🏠 Главное меню", "back_main")]]),

    broadcastConfirm: () =>
        Markup.inlineKeyboard([
            [
                Markup.button.callback("✅ Отправить", "broadcast_confirm"),
                Markup.button.callback("❌ Отмена",    "broadcast_cancel"),
            ],
        ]),

    backMain: () =>
        Markup.inlineKeyboard([[Markup.button.callback("🏠 Главное меню", "back_main")]]),

    trackInput: () =>
        Markup.inlineKeyboard([[Markup.button.callback("🏠 Главное меню", "back_main")]]),
};

// ══════════════════════════════════════════════════════════════════════════════
//  СООБЩЕНИЯ
// ══════════════════════════════════════════════════════════════════════════════
const MSG = {
    start: (name) => `
<b>VORTAS STORE</b>
<i>Тишина, обретшая форму.</i>

Привет, <b>${esc(name)}</b> 👋

Мы создаём уникальные визуальные решения для вашего бренда — от графики до персонажей.

Выбери раздел 👇
    `.trim(),

    catalog: `
<b>Каталог услуг</b>

Выбери категорию, чтобы узнать подробнее:
    `.trim(),

    vexillum: `
<b>VEXILLUM</b>

Графика для привлечения внимания на сайте, в соцсетях и рекламе. Помогает быстро донести суть предложения и побудить к действию — переходу, заказу или звонку. Делаем под нужный размер и цель.

💰 <b>от 700₽ / $8</b>
    `.trim(),

    effigy: `
<b>EFFIGY</b>

Это постер для печати или публикации в соцсетях. Создаём визуальную идею, которая отражает суть вашего события, продукта или акции. Каждый макет — уникальное решение под вашу задачу.

💰 <b>от 1200₽ / $14</b>
    `.trim(),

    tenebration: `
<b>TENEBRATION</b>

Готовые фотографии для вашего проекта. Мы улучшим цвет и свет, аккуратно поправим детали. Также добавим стилизацию под ваш бренд или выбранное настроение. Подготовим снимки к публикации.

💰 <b>от 300₽ / $4</b>
    `.trim(),

    pactlings: `
<b>PACTLINGS</b>

В этой категории вы приобретаете не просто картинку, а готовый образ с характером — будь то маскот для бренда, набор стикеров для чата или уникальный адопт-персонаж.

<b>Что вы получаете:</b>
• Маскот: <b>от 800₽ / $10</b> — Яркий образ персонажа для бренда.
• Адопт: <b>от 700₽ / $9</b> — Эксклюзивный дизайн, только для вас.
• Набор стикеров: <b>3 шт. — 500₽ / $7</b>, каждый доп. — <b>200₽ / $3</b>
    `.trim(),

    payment: `
<b>Способы оплаты</b>

🇷🇺  <b>Рубли</b> — Карты РФ
🇺🇸  <b>Доллары</b> — USDT

После оформления заказа менеджер отправит реквизиты.

<i>Работаем по 100% предоплате.</i>
    `.trim(),

    help: `
<b>Помощь</b>

<b>Как сделать заказ?</b>
Напишите нам → <a href="https://t.me/vortasdesign">@vortasdesign</a> или оформите через Mini App кнопкой «🛒 Оформить заказ».

<b>Как отследить заказ?</b>
Нажми «🔍 Отследить заказ» и введи 6-значный трек-код.

<b>Как отменить действие?</b>
Команда /cancel — сбрасывает текущий диалог.

<b>🎮 Хочешь поиграть?</b>
/quiz [тема] — запускает ИИ-викторину в группе или лично.

<b>Остались вопросы?</b>
Вся информация в канале поддержки → <a href="https://t.me/vortashelp">@vortashelp</a>
    `.trim(),

    contacts: `
<b>Контакты</b>

🌐  <b>Сайт</b>    → <a href="https://vortas.store">vortas.store</a>
📢  <b>Канал</b>   → <a href="https://t.me/vortas_store">@vortas_store</a>
💬  <b>ЛС</b>      → <a href="https://t.me/vortasdesign">@vortasdesign</a>
📧  <b>Email</b>   → <a href="mailto:vortasdesignrus@gmail.com">vortasdesignrus@gmail.com</a>

<i>Пн–Вс · 10:00–22:00 МСК · отвечаем в течение 2 часов</i>
    `.trim(),

    trackInput: `
<b>Отследить заказ</b>

Введи <b>6-значный трек-код</b>, который был выдан при оформлении.

<i>Пример: A1B2C3</i>
    `.trim(),

    orderNotFound: (code) => `
<b>Заказ не найден</b>

Трек-код <code>${esc(code)}</code> не числится в системе.
Проверь правильность ввода или обратись в поддержку → <a href="https://t.me/vortashelp">@vortashelp</a>
    `.trim(),

    orderStatus: (order) => {
        const s = getStatus(order.status);
        const extras = {
            completed:  "🎉 <b>Заказ выполнен!</b> Проверь личные сообщения от менеджера.",
            processing: "⚙️ <b>В работе</b> — скоро всё будет готово.",
            pending:    "⏳ <b>Ожидает подтверждения</b> — менеджер скоро свяжется.",
            accepted:   "✅ <b>Подтверждён</b> — работа началась.",
            rejected:   "❌ <b>Отклонён</b> — свяжитесь с поддержкой для уточнений.",
            cancelled:  "🚫 <b>Отменён</b>.",
        };
        return `
📦 <b>Статус заказа</b>

<b>Трек-код:</b> <code>${esc(order.trackCode)}</code>
<b>ID:</b>       <code>${esc(order.id)}</code>

${s.emoji} <b>${s.text}</b>
<b>Услуга:</b> ${esc(order.product)}
<b>Дата:</b>   <i>${fmtDate(order.createdAt)}</i>
${order.comment ? `<b>Комментарий:</b> ${esc(order.comment)}` : ""}

${extras[order.status] || ""}
        `.trim();
    },

    newOrder: (order) => {
        const s = getStatus(order.status);
        const src =
            order.source === "miniapp" ? "📱 Mini App" :
            order.source === "manual"  ? "🛠 Вручную"  : "💬 Бот";
        return `
🔔 <b>Новый заказ</b>

<b>ID:</b> <code>${esc(order.id)}</code>  ·  <b>Трек:</b> <code>${esc(order.trackCode)}</code>
<b>Источник:</b> ${src}

<b>Клиент:</b> ${esc(order.clientName)}${order.username ? `  ·  @${esc(order.username)}` : ""}
<b>Связь:</b>   ${esc(order.contactField) || "—"}

<b>Услуга:</b>      ${esc(order.product)}
<b>Описание:</b>    ${esc(order.comment) || "<i>—</i>"}
<b>Оплата:</b>      ${esc(order.payment)}
<b>Срочность:</b>   ${esc(order.urgency)}

<b>Статус:</b> ${s.emoji} <i>${s.text}</i>
<b>Создан:</b> ${fmtDate(order.createdAt)}
        `.trim();
    },

    statusChanged: (trackCode, newStatus) => {
        const s = getStatus(newStatus);
        return `
🔔 <b>Обновление заказа</b>

Заказ <code>${esc(trackCode)}</code>

Новый статус: ${s.emoji} <b>${s.text}</b>
${newStatus === "completed" ? "\n🎉 Заказ готов! Ожидай следующего сообщения от менеджера." : ""}
        `.trim();
    },

    adminPanel: (stats) => `
🔐 <b>Админ-панель VORTAS STORE</b>

📊 <b>Статистика:</b>
Всего заказов: <b>${stats.totalOrders}</b>
Пользователей: <b>${stats.totalUsers}</b>
Ожидают:        <b>${stats.pendingOrders}</b>
В работе:        <b>${stats.processingOrders}</b>
Выполнено:      <b>${stats.completedOrders}</b>
Отклонено:      <b>${stats.rejectedOrders}</b>
Сегодня:         <b>${stats.todayOrders}</b>
🎮 Quiz-игроков: <b>${stats.quizPlayers}</b>

Выбери действие 👇
    `.trim(),

    adminOrderSingleView: (order, index, total) => {
        const s = getStatus(order.status);
        const src =
            order.source === "miniapp" ? "📱 Mini App" :
            order.source === "manual"  ? "🛠 Вручную"  : "💬 Бот";
        return `
📦 <b>Заказ ${index + 1} из ${total}</b>

<b>Трек-код:</b> <code>${esc(order.trackCode)}</code>
<b>ID:</b>       <code>${esc(order.id)}</code>
<b>Источник:</b> ${src}

<b>Клиент:</b>   ${esc(order.clientName)}${order.username ? `  ·  @${esc(order.username)}` : ""}
<b>Связь:</b>    ${esc(order.contactField) || "—"}

<b>Услуга:</b>   ${esc(order.product)}
<b>Описание:</b> ${esc(order.comment) || "<i>—</i>"}
<b>Оплата:</b>   ${esc(order.payment)}
<b>Срочность:</b>${esc(order.urgency)}

${s.emoji} <b>${s.text}</b>
<b>Создан:</b>   ${fmtDate(order.createdAt)}
        `.trim();
    },

    orderCreated: (orderId, trackCode) => `
✅ <b>Заказ успешно создан!</b>

<b>ID:</b>       <code>${esc(orderId)}</code>
<b>Трек-код:</b> <code>${esc(trackCode)}</code>

Сохрани трек-код — с его помощью можно отслеживать статус заказа.
    `.trim(),
};

// ══════════════════════════════════════════════════════════════════════════════
//  ВСПОМОГАТЕЛЬНЫЕ
// ══════════════════════════════════════════════════════════════════════════════
async function safeEdit(ctx, text, extra) {
    try {
        await ctx.editMessageText(text, extra);
    } catch (e) {
        if (!e.message?.includes("not modified")) await ctx.reply(text, extra);
    }
}

async function sendStart(ctx) {
    saveUser(ctx);
    const imgPath = path.join(CONFIG.IMAGES_PATH, "reclam.png");
    try {
        if (fs.existsSync(imgPath)) {
            await ctx.replyWithPhoto(
                { source: imgPath },
                { caption: MSG.start(ctx.from.first_name), parse_mode: "HTML", ...KB.main() },
            );
            return;
        }
    } catch (_) {}
    await ctx.reply(MSG.start(ctx.from.first_name), { parse_mode: "HTML", ...KB.main() });
}

async function sendCatalogItem(ctx, key) {
    await ctx.answerCbQuery();
    const msgText = MSG[key];
    const imgPath = path.join(CONFIG.IMAGES_PATH, `${key}.jpg`);
    try {
        if (fs.existsSync(imgPath)) {
            await ctx.replyWithPhoto(
                { source: imgPath },
                { caption: msgText, parse_mode: "HTML", ...KB.product() },
            );
            return;
        }
    } catch (_) {}
    await safeEdit(ctx, msgText, { parse_mode: "HTML", ...KB.product() });
}

async function showOrderCard(ctx, order, orderIndex, totalOrders) {
    const text  = MSG.adminOrderSingleView(order, orderIndex, totalOrders);
    const extra = { parse_mode: "HTML", ...KB.adminOrderSingle(orderIndex, totalOrders, order.id) };
    try {
        await ctx.editMessageText(text, extra);
    } catch (e) {
        if (!e.message?.includes("not modified")) await ctx.reply(text, extra);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  РЕГИСТРИРУЕМ QUIZ HANDLERS (до остальных, чтобы не перехватывались)
// ══════════════════════════════════════════════════════════════════════════════
registerQuizHandlers(bot);

// ══════════════════════════════════════════════════════════════════════════════
//  КОМАНДЫ
// ══════════════════════════════════════════════════════════════════════════════
bot.command("start", async (ctx) => {
    clearState(ctx.from.id);
    await sendStart(ctx);
});

bot.command("admin", async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) { await ctx.reply("⛔️ Доступ запрещён"); return; }
    await ctx.reply(MSG.adminPanel(getStats()), { parse_mode: "HTML", ...KB.adminInline() });
});

bot.command("track", async (ctx) => {
    saveUser(ctx);
    clearState(ctx.from.id);
    store.orderStates.set(ctx.from.id, { step: "track" });
    await ctx.reply(MSG.trackInput, { parse_mode: "HTML", ...KB.trackInput() });
});

bot.command("catalog", async (ctx) => {
    saveUser(ctx);
    await ctx.reply(MSG.catalog, { parse_mode: "HTML", ...KB.catalog() });
});

bot.command("help", async (ctx) => {
    saveUser(ctx);
    await ctx.reply(MSG.help, { parse_mode: "HTML", ...KB.backMain() });
});

bot.command("contacts", async (ctx) => {
    saveUser(ctx);
    await ctx.reply(MSG.contacts, { parse_mode: "HTML", ...KB.backMain() });
});

bot.command("cancel", async (ctx) => {
    clearState(ctx.from.id);
    await ctx.reply("✅ Действие отменено.", { parse_mode: "HTML", ...KB.main() });
});

// ══════════════════════════════════════════════════════════════════════════════
//  ТЕКСТОВЫЕ КНОПКИ
// ══════════════════════════════════════════════════════════════════════════════
bot.hears("📦 Каталог", async (ctx) => {
    saveUser(ctx); await ctx.reply(MSG.catalog, { parse_mode: "HTML", ...KB.catalog() });
});
bot.hears("🔍 Отследить заказ", async (ctx) => {
    saveUser(ctx);
    clearState(ctx.from.id);
    store.orderStates.set(ctx.from.id, { step: "track" });
    await ctx.reply(MSG.trackInput, { parse_mode: "HTML", ...KB.trackInput() });
});
bot.hears("💳 Оплата",   async (ctx) => { saveUser(ctx); await ctx.reply(MSG.payment,   { parse_mode: "HTML", ...KB.backMain() }); });
bot.hears("❓ Помощь",   async (ctx) => { saveUser(ctx); await ctx.reply(MSG.help,      { parse_mode: "HTML", ...KB.backMain() }); });
bot.hears("📞 Контакты", async (ctx) => { saveUser(ctx); await ctx.reply(MSG.contacts,  { parse_mode: "HTML", ...KB.backMain() }); });

// Админ-кнопки (текст)
bot.hears("📊 Статистика", async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    await ctx.reply(MSG.adminPanel(getStats()), { parse_mode: "HTML", ...KB.adminInline() });
});
bot.hears("📋 Все заказы", async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    if (!store.orders.length) { await ctx.reply("❌ Заказов пока нет"); return; }
    const rev = [...store.orders].reverse();
    await ctx.reply(MSG.adminOrderSingleView(rev[0], 0, rev.length), {
        parse_mode: "HTML", ...KB.adminOrderSingle(0, rev.length, rev[0].id),
    });
});
bot.hears("👥 Пользователи", async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    const users = Array.from(store.users.values()).slice(-10).reverse();
    const lines = users.map((u, i) =>
        `${i + 1}. ${esc(u.firstName)}${u.username ? " @" + u.username : ""} — ${u.ordersCount} зак.`,
    );
    await ctx.reply(
        `<b>👥 Пользователи (всего: ${store.users.size})</b>\n\n${lines.join("\n") || "Нет пользователей"}`,
        { parse_mode: "HTML", ...KB.adminInline() },
    );
});
bot.hears("📢 Рассылка", async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    store.orderStates.set(ctx.from.id, { step: "broadcast" });
    await ctx.reply("📢 <b>Рассылка</b>\n\nВведите текст рассылки (поддерживается HTML):", {
        parse_mode: "HTML", ...KB.adminBack(),
    });
});
bot.hears("➕ Создать заказ вручную", async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    clearState(ctx.from.id);
    store.orderStates.set(ctx.from.id, { step: "manual_client" });
    await ctx.reply("📋 <b>Создать заказ (шаг 1/6)</b>\n\nВведите имя клиента:", {
        parse_mode: "HTML", ...KB.adminBack(),
    });
});
bot.hears("🔒 Закрыть админку", async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    clearState(ctx.from.id);
    await ctx.reply("🔒 Админ-панель закрыта.", { ...KB.main() });
});

// ══════════════════════════════════════════════════════════════════════════════
//  STATE MACHINE
// ══════════════════════════════════════════════════════════════════════════════
bot.on("text", async (ctx) => {
    const uid   = ctx.from.id;
    const state = store.orderStates.get(uid);
    const text  = ctx.message.text.trim();
    if (!state) return;

    // ── Track ──────────────────────────────────────────────────────────────
    if (state.step === "track") {
        const code  = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const order = store.orders.find((o) => o.trackCode === code);
        if (!order) {
            await ctx.reply(MSG.orderNotFound(code), { parse_mode: "HTML", ...KB.trackInput() });
            return;
        }
        clearState(uid);
        await ctx.reply(MSG.orderStatus(order), { parse_mode: "HTML", ...KB.orderStatus() });
        return;
    }

    // ── Broadcast ──────────────────────────────────────────────────────────
    if (state.step === "broadcast" && uid === CONFIG.ADMIN_ID) {
        store.orderStates.set(uid, { step: "broadcast_confirm", broadcastText: text });
        await ctx.reply(
            `<b>📋 Предпросмотр рассылки:</b>\n\n${text}\n\n<i>Отправить ${store.users.size} пользователям?</i>`,
            { parse_mode: "HTML", ...KB.broadcastConfirm() },
        );
        return;
    }

    // ── Admin reply ────────────────────────────────────────────────────────
    if (state.step === "admin_reply" && uid === CONFIG.ADMIN_ID) {
        const order = store.orders.find((o) => o.id === state.orderId);
        if (order?.userId) {
            try {
                await bot.telegram.sendMessage(
                    order.userId,
                    `<b>💬 Сообщение от VORTAS STORE</b>\n\nПо заказу <code>${order.trackCode}</code>:\n\n${text}`,
                    { parse_mode: "HTML" },
                );
                await ctx.reply("✅ Сообщение отправлено клиенту.", { ...KB.adminInline() });
            } catch {
                await ctx.reply("❌ Не удалось отправить сообщение.", { ...KB.adminInline() });
            }
        } else {
            await ctx.reply("❌ Заказ не привязан к пользователю.", { ...KB.adminInline() });
        }
        clearState(uid);
        return;
    }

    // ── Manual order (admin) ───────────────────────────────────────────────
    if (uid === CONFIG.ADMIN_ID) {
        if (state.step === "manual_client") {
            state.clientName = text;
            state.step = "manual_contact";
            await ctx.reply("📋 <b>Создать заказ (шаг 2/6)</b>\n\nВведите способ связи:", {
                parse_mode: "HTML", ...KB.adminBack(),
            });
            return;
        }
        if (state.step === "manual_contact") {
            state.contactField = text;
            state.step = "manual_product_wait";
            await ctx.reply("📋 <b>Создать заказ (шаг 3/6)</b>\n\nВыберите товар:", {
                parse_mode: "HTML", ...KB.adminSelectProduct(),
            });
            return;
        }
        if (state.step === "manual_comment") {
            state.comment = text === "—" ? "" : text;
            state.step = "manual_urgency_wait";
            await ctx.reply("📋 <b>Создать заказ (шаг 6/6)</b>\n\nВыберите срочность:", {
                parse_mode: "HTML", ...KB.adminSelectUrgency(),
            });
            return;
        }
    }
});

// ══════════════════════════════════════════════════════════════════════════════
//  НАВИГАЦИЯ (inline callbacks)
// ══════════════════════════════════════════════════════════════════════════════
bot.action("cat_menu",      async (ctx) => { await ctx.answerCbQuery(); await safeEdit(ctx, MSG.catalog,   { parse_mode: "HTML", ...KB.catalog()  }); });
bot.action("payment_menu",  async (ctx) => { await ctx.answerCbQuery(); await safeEdit(ctx, MSG.payment,   { parse_mode: "HTML", ...KB.backMain() }); });
bot.action("help_menu",     async (ctx) => { await ctx.answerCbQuery(); await safeEdit(ctx, MSG.help,      { parse_mode: "HTML", ...KB.backMain() }); });
bot.action("contacts_menu", async (ctx) => { await ctx.answerCbQuery(); await safeEdit(ctx, MSG.contacts,  { parse_mode: "HTML", ...KB.backMain() }); });
bot.action("back_catalog",  async (ctx) => { await ctx.answerCbQuery(); await safeEdit(ctx, MSG.catalog,   { parse_mode: "HTML", ...KB.catalog()  }); });

bot.action("track_menu", async (ctx) => {
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    store.orderStates.set(ctx.from.id, { step: "track" });
    await safeEdit(ctx, MSG.trackInput, { parse_mode: "HTML", ...KB.trackInput() });
});

bot.action("back_main", async (ctx) => {
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    await safeEdit(ctx, MSG.start(ctx.from.first_name), { parse_mode: "HTML", ...KB.mainInline() });
});

bot.action("back_admin", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    clearState(ctx.from.id);
    await safeEdit(ctx, MSG.adminPanel(getStats()), { parse_mode: "HTML", ...KB.adminInline() });
});

// ── КАТАЛОГ ───────────────────────────────────────────────────────────────────
bot.action("cat_vexillum",   (ctx) => sendCatalogItem(ctx, "vexillum"));
bot.action("cat_effigy",     (ctx) => sendCatalogItem(ctx, "effigy"));
bot.action("cat_tenebration",(ctx) => sendCatalogItem(ctx, "tenebration"));
bot.action("cat_pactlings",  (ctx) => sendCatalogItem(ctx, "pactlings"));

// ── ЗАКАЗЫ (ADMIN) ────────────────────────────────────────────────────────────
bot.action("admin_orders_view", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    if (!store.orders.length) { await safeEdit(ctx, "❌ Заказов пока нет.", KB.adminInline()); return; }
    const rev = [...store.orders].reverse();
    await showOrderCard(ctx, rev[0], 0, rev.length);
});

bot.action(/^ao_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    const idx = parseInt(ctx.match[1]);
    const rev = [...store.orders].reverse();
    if (idx < 0 || idx >= rev.length) { await ctx.answerCbQuery("Заказ не найден", { show_alert: true }); return; }
    await showOrderCard(ctx, rev[idx], idx, rev.length);
});

// ── СТАТУС ЗАКАЗА ─────────────────────────────────────────────────────────────
const STATUS_ACTIONS = { a: "accepted", p: "processing", c: "completed", r: "rejected" };

bot.action(/^adm_([apcr])_(.+)$/, async (ctx) => {
    if (ctx.from.id !== CONFIG.ADMIN_ID) { await ctx.answerCbQuery(); return; }
    const [, code, orderId] = ctx.match;
    const newStatus = STATUS_ACTIONS[code];
    if (!newStatus) { await ctx.answerCbQuery(); return; }
    const order = store.orders.find((o) => o.id === orderId);
    if (!order) { await ctx.answerCbQuery("Заказ не найден", { show_alert: true }); return; }
    await ctx.answerCbQuery(`Статус: ${getStatus(newStatus).text}`);
    order.status = newStatus;
    order.history.push({ status: newStatus, timestamp: Date.now() });
    saveData();
    if (order.userId) {
        try {
            await bot.telegram.sendMessage(order.userId, MSG.statusChanged(order.trackCode, newStatus), { parse_mode: "HTML" });
        } catch (e) { console.error("Уведомление клиента:", e.message); }
    }
    const rev = [...store.orders].reverse();
    const orderIndex = rev.findIndex((o) => o.id === orderId);
    await showOrderCard(ctx, order, orderIndex >= 0 ? orderIndex : 0, rev.length);
});

bot.action(/^adm_msg_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    store.orderStates.set(ctx.from.id, { step: "admin_reply", orderId: ctx.match[1] });
    await ctx.reply("💬 Введите сообщение для клиента:\n<i>(или /cancel для отмены)</i>", { parse_mode: "HTML" });
});

bot.action(/^adm_del_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    const orderId    = ctx.match[1];
    const orderIndex = store.orders.findIndex((o) => o.id === orderId);
    if (orderIndex === -1) { await ctx.answerCbQuery("Заказ не найден", { show_alert: true }); return; }
    const order = store.orders[orderIndex];
    store.orders.splice(orderIndex, 1);
    saveData();
    await ctx.reply(
        `🗑 <b>Заказ удалён</b>\n\nТрек-код: <code>${order.trackCode}</code>\nКлиент: ${esc(order.clientName)}`,
        { parse_mode: "HTML", ...KB.adminInline() },
    );
});

// ── ADMIN STATS / USERS ───────────────────────────────────────────────────────
bot.action("admin_stats", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    await safeEdit(ctx, MSG.adminPanel(getStats()), { parse_mode: "HTML", ...KB.adminInline() });
});

bot.action("admin_users", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    const users = Array.from(store.users.values()).slice(-10).reverse();
    const lines = users.map((u, i) =>
        `${i + 1}. ${esc(u.firstName)}${u.username ? " @" + u.username : ""} — ${u.ordersCount} зак.`,
    );
    await ctx.reply(
        `<b>👥 Пользователи (всего: ${store.users.size})</b>\n\n${lines.join("\n") || "Нет пользователей"}`,
        { parse_mode: "HTML", ...KB.adminInline() },
    );
});

// ── ADMIN QUIZ SCORES ─────────────────────────────────────────────────────────
bot.action("admin_quiz_scores", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    const lb      = getGlobalLeaderboard();
    const entries = Object.entries(lb)
        .sort(([, a], [, b]) => b.totalPoints - a.totalPoints)
        .slice(0, 10);

    if (!entries.length) {
        await ctx.reply("📊 Таблица рекордов Quiz пуста.", { ...KB.adminInline() });
        return;
    }
    const medals = ["🥇", "🥈", "🥉"];
    const lines  = entries.map(([, g], i) =>
        `${medals[i] ?? (i + 1) + "."} <b>${esc(g.name)}</b> — ${g.totalPoints} очков  (${g.played} игр, ${g.wins} побед)`,
    );
    await ctx.reply(
        `🏅 <b>Quiz — Таблица рекордов</b>\n\n${lines.join("\n")}`,
        { parse_mode: "HTML", ...KB.adminInline() },
    );
});

// ── РАССЫЛКА ──────────────────────────────────────────────────────────────────
bot.action("admin_broadcast", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    store.orderStates.set(ctx.from.id, { step: "broadcast" });
    await ctx.reply(
        "📢 <b>Рассылка</b>\n\nВведите текст рассылки (поддерживается HTML):\n<i>(или /cancel для отмены)</i>",
        { parse_mode: "HTML", ...KB.adminBack() },
    );
});

bot.action("broadcast_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    const state = store.orderStates.get(ctx.from.id);
    if (!state?.broadcastText) return;
    let ok = 0, fail = 0;
    for (const [uid] of store.users) {
        try {
            await bot.telegram.sendMessage(uid, state.broadcastText, { parse_mode: "HTML" });
            ok++;
        } catch { fail++; }
        await new Promise((r) => setTimeout(r, 50));
    }
    clearState(ctx.from.id);
    await ctx.reply(`<b>✅ Рассылка завершена</b>\nУспешно: ${ok} · Ошибок: ${fail}`, {
        parse_mode: "HTML", ...KB.adminInline(),
    });
});

bot.action("broadcast_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    clearState(ctx.from.id);
    await ctx.reply("❌ Рассылка отменена.", KB.adminInline());
});

// ── СОЗДАНИЕ ЗАКАЗА ВРУЧНУЮ ───────────────────────────────────────────────────
bot.action("admin_create_order", async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.from.id !== CONFIG.ADMIN_ID) return;
    clearState(ctx.from.id);
    store.orderStates.set(ctx.from.id, { step: "manual_client" });
    await ctx.reply("📋 <b>Создать заказ (шаг 1/6)</b>\n\nВведите имя клиента:", {
        parse_mode: "HTML", ...KB.adminBack(),
    });
});

const MANUAL_PRODUCTS = {
    vexillum:   "🎨 VEXILLUM",
    effigy:     "🖼 EFFIGY",
    tenebration:"📸 TENEBRATION",
    pactlings:  "🎭 PACTLINGS",
};
for (const [key, label] of Object.entries(MANUAL_PRODUCTS)) {
    bot.action(`mp_${key}`, async (ctx) => {
        await ctx.answerCbQuery();
        if (ctx.from.id !== CONFIG.ADMIN_ID) return;
        const state = store.orderStates.get(ctx.from.id);
        if (!state) return;
        state.product = label;
        state.step    = "manual_payment_wait";
        await ctx.editMessageText("📋 <b>Создать заказ (шаг 4/6)</b>\n\nВыберите способ оплаты:", {
            parse_mode: "HTML", ...KB.adminSelectPayment(),
        });
    });
}

for (const [key, label] of [["rub", "Рубли"], ["usd", "Доллары"]]) {
    bot.action(`mpay_${key}`, async (ctx) => {
        await ctx.answerCbQuery();
        if (ctx.from.id !== CONFIG.ADMIN_ID) return;
        const state = store.orderStates.get(ctx.from.id);
        if (!state) return;
        state.payment = label;
        state.step    = "manual_comment";
        await ctx.editMessageText(
            "📋 <b>Создать заказ (шаг 5/6)</b>\n\nВведите описание/комментарий\n<i>(или «—» чтобы пропустить)</i>:",
            { parse_mode: "HTML", ...KB.adminBack() },
        );
    });
}

const MANUAL_URGENCY = {
    standard: "📅 Стандарт (3-13 дней)",
    fast:     "🕐 Срочно (1-6 дней)",
    veryfast: "⚡ Очень срочно (1-3 дня)",
    superfast:"🔥 Сверхсрочно (24 часа)",
};
for (const [key, label] of Object.entries(MANUAL_URGENCY)) {
    bot.action(`murg_${key}`, async (ctx) => {
        await ctx.answerCbQuery();
        if (ctx.from.id !== CONFIG.ADMIN_ID) return;
        const state = store.orderStates.get(ctx.from.id);
        if (!state) return;
        state.urgency = label;
        const { orderId, trackCode } = await createOrder(
            0,
            {
                clientName:   state.clientName   || "—",
                contactType:  "Telegram",
                contactField: state.contactField  || "—",
                product:      state.product,
                payment:      state.payment,
                urgency:      state.urgency,
                comment:      state.comment || "",
            },
            "manual",
        );
        clearState(ctx.from.id);
        await ctx.reply(MSG.orderCreated(orderId, trackCode), { parse_mode: "HTML", ...KB.adminInline() });
    });
}

bot.action("noop", (ctx) => ctx.answerCbQuery());

// ══════════════════════════════════════════════════════════════════════════════
//  MINI APP
// ══════════════════════════════════════════════════════════════════════════════
bot.on("web_app_data", async (ctx) => {
    saveUser(ctx);
    try {
        const data = JSON.parse(ctx.message.web_app_data.data);
        const { orderId, trackCode } = await createOrder(
            ctx.from.id,
            {
                clientName:   ctx.from.first_name,
                username:     ctx.from.username || "",
                contactType:  "Mini App",
                contactField: data.contact || ctx.from.username || "",
                product:      data.product || "Услуга из Mini App",
                payment:      data.payment || "Не указано",
                urgency:      data.urgency || "Стандарт",
                comment:      data.comment || "",
            },
            "miniapp",
        );
        await ctx.reply(MSG.orderCreated(orderId, trackCode), { parse_mode: "HTML", ...KB.backMain() });
    } catch (e) {
        console.error("WebApp error:", e);
        await ctx.reply("❌ Ошибка обработки заказа. Обратитесь в поддержку.");
    }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ОБРАБОТКА ОШИБОК
// ══════════════════════════════════════════════════════════════════════════════
bot.catch((err, ctx) => {
    console.error(`[${ctx?.updateType || "?"}]`, err?.message || err);
});

process.on("SIGINT",  () => { saveData(); bot.stop("SIGINT");  process.exit(0); });
process.on("SIGTERM", () => { saveData(); bot.stop("SIGTERM"); process.exit(0); });

// ══════════════════════════════════════════════════════════════════════════════
//  ЗАПУСК
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║   VORTAS STORE V4.0 — WITH QUIZ ENGINE       ║");
    console.log("╚══════════════════════════════════════════════╝\n");

    keepAlive();

    const info = await bot.telegram.getMe();
    console.log(`Бот:      @${info.username}`);
    console.log(`Admin ID: ${CONFIG.ADMIN_ID}`);

    // Разрешаем боту работать в группах
    await bot.telegram.setMyDefaultAdministratorRights({
        rights: {
            can_manage_chat:          true,
            can_delete_messages:      false,
            can_manage_video_chats:   false,
            can_restrict_members:     false,
            can_promote_members:      false,
            can_change_info:          false,
            can_invite_users:         false,
            can_pin_messages:         false,
        },
        for_channels: false,
    }).catch(() => {}); // не критично если прав нет

    const cmds = [
        { command: "start",       description: "🏠 Главная" },
        { command: "track",       description: "🔍 Отследить заказ" },
        { command: "catalog",     description: "📦 Каталог услуг" },
        { command: "help",        description: "❓ Помощь" },
        { command: "contacts",    description: "📞 Контакты" },
        { command: "cancel",      description: "❌ Отменить действие" },
        { command: "quiz",        description: "🎮 Запустить викторину [тема]" },
        { command: "quiz_stop",   description: "⏹ Остановить викторину" },
        { command: "quiz_scores", description: "🏆 Таблица рекордов" },
        { command: "quiz_help",   description: "📖 Правила викторины" },
    ];
    await bot.telegram.setMyCommands(cmds);
    await bot.telegram.setMyCommands(
        [...cmds, { command: "admin", description: "🔐 Админ-панель" }],
        { scope: { type: "chat", chat_id: CONFIG.ADMIN_ID } },
    );

    await bot.telegram.deleteWebhook();
    console.log("✅ Бот запущен в режиме Long Polling");
    console.log("🎮 Quiz Engine активен\n");
    await bot.launch();
}

main().catch(console.error);

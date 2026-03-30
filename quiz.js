// ══════════════════════════════════════════════════════════════════════════════
//  VORTAS QUIZ ENGINE  —  AI-powered trivia for groups & private chats
// ══════════════════════════════════════════════════════════════════════════════

"use strict";

const { Markup } = require("telegraf");

// ── КОНСТАНТЫ ─────────────────────────────────────────────────────────────────
const QCF = {
    QUESTIONS_PER_ROUND: 7,        // вопросов в раунде
    ANSWER_TIME_SEC: 25,           // секунд на ответ
    SPEED_BONUS_SEC: 8,            // ответ быстрее этого → бонус
    POINTS: {
        correct: 100,
        speedBonus: 50,            // если ответил за < SPEED_BONUS_SEC
        streak3: 30,               // бонус за серию 3
        streak5: 60,               // бонус за серию 5
    },
    DIFFICULTY: {
        easy:   { label: "🟢 Лёгкий",   emoji: "🟢", mult: 1.0 },
        medium: { label: "🟡 Средний",  emoji: "🟡", mult: 1.5 },
        hard:   { label: "🔴 Сложный",  emoji: "🔴", mult: 2.0 },
    },
    COUNTDOWN_WARN_SEC: 10,        // предупреждение "осталось N сек" при таймере
    MAX_TOPIC_LEN: 80,
    ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
    ANTHROPIC_URL: "https://api.anthropic.com/v1/messages",
};

// активные викторины: chatId → QuizSession
const sessions = new Map();

// глобальная таблица рекордов (сохраняется вместе с data.json)
let globalLeaderboard = {};   // userId → { name, totalPoints, wins, played }

// ── УТИЛИТЫ ───────────────────────────────────────────────────────────────────
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const esc    = (t)  => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plural = (n, one, few, many) => {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
};

// Медаль по месту
const medal = (pos) => ["🥇", "🥈", "🥉"][pos] ?? `${pos + 1}.`;

// Прогресс-бар таймера
function timerBar(secLeft, total) {
    const filled = Math.round((secLeft / total) * 10);
    return "▓".repeat(filled) + "░".repeat(10 - filled);
}

// ── ГЕНЕРАЦИЯ ВОПРОСОВ ЧЕРЕЗ CLAUDE API ───────────────────────────────────────
async function generateQuestions(topic, difficulty, count) {
    const diffInfo = QCF.DIFFICULTY[difficulty];
    const systemPrompt =
        `You are a quiz master. Generate exactly ${count} trivia questions in Russian about the topic provided. ` +
        `Difficulty: ${difficulty} (${diffInfo.label}). ` +
        `Return ONLY valid JSON — no markdown, no explanation — in this exact format:
[
  {
    "q": "Текст вопроса?",
    "options": ["Вариант А", "Вариант Б", "Вариант В", "Вариант Г"],
    "correct": 0,
    "fact": "Краткий интересный факт об ответе (1 предложение)"
  }
]
Rules:
- All text must be in Russian
- "correct" is the 0-based index of the correct option in "options"
- options must be shuffled (correct answer not always first)
- fact must be curious and educational
- questions must be clear and unambiguous
- for "${difficulty}" difficulty: ${
    difficulty === "easy"   ? "well-known facts, suitable for anyone" :
    difficulty === "medium" ? "requires some knowledge, moderate challenge" :
                              "specialist-level, challenging even for experts"
}`;

    const response = await fetch(QCF.ANTHROPIC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: QCF.ANTHROPIC_MODEL,
            max_tokens: 3000,
            system: systemPrompt,
            messages: [{ role: "user", content: `Topic: ${topic}` }],
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const raw  = data.content?.[0]?.text ?? "";

    // Извлекаем JSON из ответа (на случай если модель добавит лишнее)
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("Не удалось распарсить вопросы из ответа ИИ");

    const questions = JSON.parse(match[0]);
    if (!Array.isArray(questions) || questions.length === 0)
        throw new Error("ИИ вернул пустой список вопросов");

    return questions.slice(0, count);
}

// ── КЛАСС СЕССИИ ──────────────────────────────────────────────────────────────
class QuizSession {
    constructor(chatId, topic, difficulty, startedBy) {
        this.chatId      = chatId;
        this.topic       = topic;
        this.difficulty  = difficulty;
        this.startedBy   = startedBy;
        this.questions   = [];
        this.currentIdx  = -1;
        this.scores      = new Map();   // userId → { name, points, streak, correct, wrong, speed }
        this.answered    = new Set();   // userIds that answered current question
        this.questionMsgId = null;
        this.timerMsgId  = null;
        this.timerHandle = null;
        this.warnHandle  = null;
        this.questionStartTs = 0;
        this.status      = "loading";   // loading | active | finished
    }

    getOrCreatePlayer(userId, name) {
        if (!this.scores.has(userId)) {
            this.scores.set(userId, {
                name, points: 0, streak: 0,
                correct: 0, wrong: 0, speed: [],
            });
        }
        return this.scores.get(userId);
    }

    awardPoints(userId, name, isCorrect, elapsedSec) {
        const p = this.getOrCreatePlayer(userId, name);
        if (isCorrect) {
            const diff = QCF.DIFFICULTY[this.difficulty];
            let pts = Math.round(QCF.POINTS.correct * diff.mult);
            if (elapsedSec <= QCF.SPEED_BONUS_SEC)
                pts += Math.round(QCF.POINTS.speedBonus * diff.mult);
            p.streak += 1;
            if (p.streak >= 5) pts += QCF.POINTS.streak5;
            else if (p.streak >= 3) pts += QCF.POINTS.streak3;
            p.points += pts;
            p.correct += 1;
            p.speed.push(elapsedSec);
            return pts;
        } else {
            p.streak = 0;
            p.wrong += 1;
            p.getOrCreatePlayer = undefined; // cleanup artifact
            return 0;
        }
    }

    sortedPlayers() {
        return [...this.scores.entries()]
            .sort(([, a], [, b]) => b.points - a.points);
    }
}

// ── КЛАВИАТУРЫ ────────────────────────────────────────────────────────────────
const QB = {
    difficulty: (topic) =>
        Markup.inlineKeyboard([
            [
                Markup.button.callback("🟢 Лёгкий",  `qd_easy_${encodeURIComponent(topic)}`),
                Markup.button.callback("🟡 Средний", `qd_medium_${encodeURIComponent(topic)}`),
                Markup.button.callback("🔴 Сложный", `qd_hard_${encodeURIComponent(topic)}`),
            ],
            [Markup.button.callback("❌ Отмена", "quiz_cancel_setup")],
        ]),

    answers: (questionIdx, options, chatId) =>
        Markup.inlineKeyboard(
            options.map((opt, i) => [
                Markup.button.callback(
                    `${["А", "Б", "В", "Г"][i]}. ${opt}`,
                    `qa_${chatId}_${questionIdx}_${i}`,
                ),
            ]),
        ),

    stopQuiz: (chatId) =>
        Markup.inlineKeyboard([
            [Markup.button.callback("⏹ Завершить викторину", `quiz_stop_${chatId}`)],
        ]),
};

// ── ФОРМАТИРОВАНИЕ ────────────────────────────────────────────────────────────
function fmtQuestion(session, question) {
    const { currentIdx, questions, topic, difficulty } = session;
    const diff = QCF.DIFFICULTY[difficulty];
    const letters = ["А", "Б", "В", "Г"];
    const opts = question.options
        .map((o, i) => `  ${letters[i]}. ${esc(o)}`)
        .join("\n");

    return (
        `${diff.emoji} <b>Викторина: ${esc(topic)}</b>  ·  ` +
        `Вопрос <b>${currentIdx + 1}/${questions.length}</b>\n\n` +
        `❓ <b>${esc(question.q)}</b>\n\n` +
        `${opts}\n\n` +
        `⏱ <i>${QCF.ANSWER_TIME_SEC} секунд на ответ</i>`
    );
}

function fmtMiniLeaderboard(session, limit = 3) {
    const top = session.sortedPlayers().slice(0, limit);
    if (!top.length) return "";
    return (
        "\n\n📊 <b>Счёт:</b>  " +
        top.map(([, p], i) => `${medal(i)} ${esc(p.name)} — ${p.points}`).join("  ·  ")
    );
}

function fmtFinalResults(session) {
    const diff     = QCF.DIFFICULTY[session.difficulty];
    const players  = session.sortedPlayers();
    const total    = session.questions.length;

    let text =
        `🏆 <b>Викторина завершена!</b>\n\n` +
        `📌 Тема: <b>${esc(session.topic)}</b>  ${diff.emoji}\n` +
        `📝 Вопросов: <b>${total}</b>\n\n` +
        `<b>Итоги:</b>\n`;

    if (!players.length) {
        text += "\n<i>Никто не ответил ни на один вопрос 😔</i>";
    } else {
        players.forEach(([, p], i) => {
            const avgSpeed =
                p.speed.length
                    ? (p.speed.reduce((a, b) => a + b, 0) / p.speed.length).toFixed(1)
                    : "—";
            const pct = total ? Math.round((p.correct / total) * 100) : 0;
            text +=
                `\n${medal(i)} <b>${esc(p.name)}</b>  —  <b>${p.points} очков</b>\n` +
                `   ✅ ${p.correct}/${total} (${pct}%)  ·  ⚡ ср. ${avgSpeed}с  ·  🔥 макс. серия ${p.streak}\n`;
        });
    }

    const winner = players[0];
    if (winner) {
        text += `\n🎉 Победитель: <b>${esc(winner[1].name)}</b> с ${winner[1].points} очками!`;
    }

    return text;
}

// ── ЯДРО ВИКТОРИНЫ ────────────────────────────────────────────────────────────
async function runNextQuestion(bot, session) {
    session.currentIdx += 1;

    if (session.currentIdx >= session.questions.length) {
        await finishQuiz(bot, session);
        return;
    }

    const question = session.questions[session.currentIdx];
    session.answered.clear();
    session.questionStartTs = Date.now();

    const text  = fmtQuestion(session, question);
    const extra = {
        parse_mode: "HTML",
        ...QB.answers(session.currentIdx, question.options, session.chatId),
    };

    try {
        const msg = await bot.telegram.sendMessage(session.chatId, text, extra);
        session.questionMsgId = msg.message_id;
    } catch (e) {
        console.error("[Quiz] sendQuestion:", e.message);
        return;
    }

    // Предупреждение об оставшемся времени
    session.warnHandle = setTimeout(async () => {
        if (!sessions.has(session.chatId)) return;
        try {
            await bot.telegram.sendMessage(
                session.chatId,
                `⏳ <b>Осталось ${QCF.COUNTDOWN_WARN_SEC} секунд!</b>`,
                { parse_mode: "HTML" },
            );
        } catch (_) {}
    }, (QCF.ANSWER_TIME_SEC - QCF.COUNTDOWN_WARN_SEC) * 1000);

    // Таймаут вопроса
    session.timerHandle = setTimeout(async () => {
        if (!sessions.has(session.chatId)) return;
        await revealAnswer(bot, session, null, null);
    }, QCF.ANSWER_TIME_SEC * 1000);
}

async function revealAnswer(bot, session, winnerId, winnerName) {
    clearTimeout(session.timerHandle);
    clearTimeout(session.warnHandle);

    const question = session.questions[session.currentIdx];
    const correctOpt = question.options[question.correct];
    const letters = ["А", "Б", "В", "Г"];

    // Снимаем кнопки с вопроса
    try {
        await bot.telegram.editMessageReplyMarkup(
            session.chatId,
            session.questionMsgId,
            undefined,
            { inline_keyboard: [] },
        );
    } catch (_) {}

    // Составляем вердикт
    let verdict = "";
    if (winnerId) {
        const p    = session.scores.get(winnerId);
        const streak = p?.streak ?? 0;
        verdict =
            `✅ <b>${esc(winnerName)}</b> ответил(а) верно!\n` +
            (p?.points ? `+очки  (всего: <b>${p.points}</b>)` : "") +
            (streak >= 3 ? `  🔥 Серия: ${streak}!` : "");
    } else {
        verdict = "⌛️ <b>Время вышло!</b> Никто не ответил.";
    }

    const miniLB = fmtMiniLeaderboard(session);

    const revealText =
        `${verdict}\n\n` +
        `✔️ Правильный ответ: <b>${letters[question.correct]}. ${esc(correctOpt)}</b>\n\n` +
        `💡 <i>${esc(question.fact)}</i>` +
        miniLB;

    try {
        await bot.telegram.sendMessage(session.chatId, revealText, {
            parse_mode: "HTML",
        });
    } catch (e) {
        console.error("[Quiz] revealAnswer:", e.message);
    }

    await sleep(3000);
    await runNextQuestion(bot, session);
}

async function finishQuiz(bot, session) {
    session.status = "finished";
    sessions.delete(session.chatId);

    // Обновляем глобальный лидерборд
    const players = session.sortedPlayers();
    players.forEach(([uid, p], i) => {
        if (!globalLeaderboard[uid]) {
            globalLeaderboard[uid] = { name: p.name, totalPoints: 0, wins: 0, played: 0 };
        }
        const g = globalLeaderboard[uid];
        g.name        = p.name;
        g.totalPoints += p.points;
        g.played      += 1;
        if (i === 0 && p.points > 0) g.wins += 1;
    });

    try {
        await bot.telegram.sendMessage(
            session.chatId,
            fmtFinalResults(session),
            { parse_mode: "HTML" },
        );
    } catch (e) {
        console.error("[Quiz] finishQuiz:", e.message);
    }
}

// ── ПУБЛИЧНЫЙ API ─────────────────────────────────────────────────────────────

/**
 * Зарегистрировать все обработчики викторины на экземпляре бота.
 * Вызывать один раз при инициализации бота.
 */
function registerQuizHandlers(bot) {

    // /quiz [тема] — запустить викторину
    bot.command("quiz", async (ctx) => {
        const chatId = ctx.chat.id;

        if (sessions.has(chatId)) {
            await ctx.reply(
                "⚠️ В этом чате уже идёт викторина!\n" +
                "Используй /quiz_stop чтобы завершить её.",
                { parse_mode: "HTML" },
            );
            return;
        }

        const rawTopic = ctx.message.text.replace(/^\/quiz\s*/i, "").trim();
        if (!rawTopic) {
            await ctx.reply(
                "📝 <b>Как запустить викторину:</b>\n\n" +
                "<code>/quiz [тема]</code>\n\n" +
                "Примеры:\n" +
                "• /quiz История России\n" +
                "• /quiz Животные Африки\n" +
                "• /quiz JavaScript\n" +
                "• /quiz Marvel вселенная",
                { parse_mode: "HTML" },
            );
            return;
        }

        const topic = rawTopic.slice(0, QCF.MAX_TOPIC_LEN);

        await ctx.reply(
            `🎯 Тема: <b>${esc(topic)}</b>\n\nВыбери уровень сложности:`,
            { parse_mode: "HTML", ...QB.difficulty(topic) },
        );
    });

    // /quiz_stop — остановить викторину
    bot.command("quiz_stop", async (ctx) => {
        const chatId = ctx.chat.id;
        const session = sessions.get(chatId);

        if (!session) {
            await ctx.reply("❌ В этом чате нет активной викторины.");
            return;
        }

        clearTimeout(session.timerHandle);
        clearTimeout(session.warnHandle);
        sessions.delete(chatId);

        await ctx.reply(
            `⏹ <b>Викторина остановлена.</b>\n\n` + fmtFinalResults(session),
            { parse_mode: "HTML" },
        );
    });

    // /quiz_scores — таблица рекордов
    bot.command("quiz_scores", async (ctx) => {
        const entries = Object.entries(globalLeaderboard)
            .sort(([, a], [, b]) => b.totalPoints - a.totalPoints)
            .slice(0, 10);

        if (!entries.length) {
            await ctx.reply("📊 Таблица рекордов пока пуста. Сыграй первым!");
            return;
        }

        const lines = entries.map(([, g], i) => {
            const winRate = g.played
                ? Math.round((g.wins / g.played) * 100)
                : 0;
            return (
                `${medal(i)} <b>${esc(g.name)}</b>\n` +
                `   🏆 ${g.totalPoints} очков  ·  🎮 ${g.played} ${plural(g.played, "игра", "игры", "игр")}  ·  🥇 ${winRate}% побед`
            );
        });

        await ctx.reply(
            `🏅 <b>Таблица рекордов VORTAS QUIZ</b>\n\n${lines.join("\n\n")}`,
            { parse_mode: "HTML" },
        );
    });

    // /quiz_help — помощь
    bot.command("quiz_help", async (ctx) => {
        await ctx.reply(
            `🎮 <b>VORTAS QUIZ — Правила</b>\n\n` +
            `<b>Команды:</b>\n` +
            `• /quiz [тема] — начать викторину\n` +
            `• /quiz_stop — остановить текущую\n` +
            `• /quiz_scores — таблица рекордов\n\n` +
            `<b>Как работает:</b>\n` +
            `ИИ генерирует ${QCF.QUESTIONS_PER_ROUND} вопросов по заданной теме.\n` +
            `На каждый вопрос — ${QCF.ANSWER_TIME_SEC} секунд. Нажми кнопку с правильным ответом!\n\n` +
            `<b>Очки:</b>\n` +
            `✅ Правильный ответ — <b>100 очков</b> (×1.5 средний / ×2 сложный)\n` +
            `⚡ Быстрый ответ (<${QCF.SPEED_BONUS_SEC}с) — +<b>50 бонус</b>\n` +
            `🔥 Серия 3 подряд — +<b>30</b>  ·  Серия 5 — +<b>60</b>\n\n` +
            `<i>Работает в группах и личных чатах!</i>`,
            { parse_mode: "HTML" },
        );
    });

    // ── CALLBACK: выбор сложности ──────────────────────────────────────────────
    bot.action(/^qd_(easy|medium|hard)_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const difficulty = ctx.match[1];
        const topic      = decodeURIComponent(ctx.match[2]);
        const chatId     = ctx.chat.id;

        if (sessions.has(chatId)) {
            await ctx.answerCbQuery("Викторина уже идёт!", { show_alert: true });
            return;
        }

        const diff    = QCF.DIFFICULTY[difficulty];
        const session = new QuizSession(chatId, topic, difficulty, ctx.from.id);
        sessions.set(chatId, session);

        // Удаляем сообщение выбора сложности
        try { await ctx.deleteMessage(); } catch (_) {}

        const loadMsg = await ctx.reply(
            `${diff.emoji} <b>Готовим викторину...</b>\n\n` +
            `📌 Тема: <b>${esc(topic)}</b>\n` +
            `🎯 Сложность: ${diff.label}\n\n` +
            `<i>ИИ генерирует ${QCF.QUESTIONS_PER_ROUND} вопросов — секунду!</i>`,
            { parse_mode: "HTML" },
        );

        try {
            const questions = await generateQuestions(
                topic,
                difficulty,
                QCF.QUESTIONS_PER_ROUND,
            );
            session.questions = questions;
            session.status    = "active";

            // Удаляем сообщение-загрузчик
            try {
                await bot.telegram.deleteMessage(chatId, loadMsg.message_id);
            } catch (_) {}

            await bot.telegram.sendMessage(
                chatId,
                `🎉 <b>Викторина начинается!</b>\n\n` +
                `📌 Тема: <b>${esc(topic)}</b>\n` +
                `${diff.emoji} Сложность: ${diff.label}\n` +
                `❓ Вопросов: <b>${questions.length}</b>\n` +
                `⏱ Время на вопрос: <b>${QCF.ANSWER_TIME_SEC} секунд</b>\n\n` +
                `<i>Отвечай на кнопки быстрее всех и зарабатывай бонусы!</i>\n` +
                `Для остановки: /quiz_stop`,
                { parse_mode: "HTML" },
            );

            await sleep(2000);
            await runNextQuestion(bot, session);

        } catch (e) {
            sessions.delete(chatId);
            console.error("[Quiz] generateQuestions:", e.message);

            try {
                await bot.telegram.editMessageText(
                    chatId,
                    loadMsg.message_id,
                    undefined,
                    `❌ <b>Ошибка генерации вопросов</b>\n\n<i>${esc(e.message)}</i>\n\nПопробуй другую тему или повтори позже.`,
                    { parse_mode: "HTML" },
                );
            } catch (_) {}
        }
    });

    // ── CALLBACK: отмена выбора сложности ────────────────────────────────────
    bot.action("quiz_cancel_setup", async (ctx) => {
        await ctx.answerCbQuery("Отменено");
        try { await ctx.deleteMessage(); } catch (_) {}
    });

    // ── CALLBACK: кнопка остановки ────────────────────────────────────────────
    bot.action(/^quiz_stop_(-?\d+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const chatId  = parseInt(ctx.match[1]);
        const session = sessions.get(chatId);
        if (!session) {
            await ctx.answerCbQuery("Викторина уже завершена", { show_alert: true });
            return;
        }
        clearTimeout(session.timerHandle);
        clearTimeout(session.warnHandle);
        sessions.delete(chatId);
        await ctx.reply(
            `⏹ <b>Викторина остановлена.</b>\n\n` + fmtFinalResults(session),
            { parse_mode: "HTML" },
        );
    });

    // ── CALLBACK: ответ на вопрос ─────────────────────────────────────────────
    bot.action(/^qa_(-?\d+)_(\d+)_(\d+)$/, async (ctx) => {
        const chatId      = parseInt(ctx.match[1]);
        const questionIdx = parseInt(ctx.match[2]);
        const answerIdx   = parseInt(ctx.match[3]);

        const session = sessions.get(chatId);

        if (!session || session.status !== "active") {
            await ctx.answerCbQuery("Викторина завершена", { show_alert: true });
            return;
        }

        if (session.currentIdx !== questionIdx) {
            await ctx.answerCbQuery("Этот вопрос уже закрыт ⏩", { show_alert: true });
            return;
        }

        const uid  = ctx.from.id;
        const name = ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");

        if (session.answered.has(uid)) {
            await ctx.answerCbQuery("Ты уже ответил(а) на этот вопрос!", { show_alert: true });
            return;
        }

        session.answered.add(uid);
        session.getOrCreatePlayer = undefined; // not a method on session
        session.scores.get  // ensure player exists
        session.getOrCreatePlayer; // noop

        // Убедимся что игрок существует
        if (!session.scores.has(uid)) {
            session.scores.set(uid, {
                name, points: 0, streak: 0,
                correct: 0, wrong: 0, speed: [],
            });
        }

        const question   = session.questions[questionIdx];
        const isCorrect  = answerIdx === question.correct;
        const elapsedSec = (Date.now() - session.questionStartTs) / 1000;
        const player     = session.scores.get(uid);

        if (isCorrect) {
            const diff  = QCF.DIFFICULTY[session.difficulty];
            let pts = Math.round(QCF.POINTS.correct * diff.mult);

            if (elapsedSec <= QCF.SPEED_BONUS_SEC)
                pts += Math.round(QCF.POINTS.speedBonus * diff.mult);

            player.streak  += 1;
            if (player.streak >= 5)      pts += QCF.POINTS.streak5;
            else if (player.streak >= 3) pts += QCF.POINTS.streak3;

            player.points  += pts;
            player.correct += 1;
            player.speed.push(elapsedSec);

            const letters = ["А", "Б", "В", "Г"];
            let feedback =
                `✅ Верно! +${pts} очков` +
                (elapsedSec <= QCF.SPEED_BONUS_SEC ? " ⚡ Бонус за скорость!" : "") +
                (player.streak >= 3 ? ` 🔥 Серия ${player.streak}!` : "");

            await ctx.answerCbQuery(feedback, { show_alert: false });

            // Первый правильный ответ — раскрываем сразу
            clearTimeout(session.timerHandle);
            clearTimeout(session.warnHandle);
            await revealAnswer(bot, session, uid, name);

        } else {
            player.streak = 0;
            player.wrong  += 1;
            const letters  = ["А", "Б", "В", "Г"];
            await ctx.answerCbQuery(
                `❌ Неверно! Ты выбрал(а): ${letters[answerIdx]}`,
                { show_alert: false },
            );
        }
    });
}

// ── ЭКСПОРТ ───────────────────────────────────────────────────────────────────
module.exports = {
    registerQuizHandlers,
    getGlobalLeaderboard: () => globalLeaderboard,
    setGlobalLeaderboard: (data) => { globalLeaderboard = data || {}; },
    getActiveSessions:    () => sessions,
};

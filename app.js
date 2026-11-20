'use strict';

// ---------- Konfiguration ----------

const CONFIG = {
  storageKey: 'spanischApp.v1',

  // Session
  sessionSize: 20,        // max. Karten pro Session
  maxNewPerSession: 10,   // höchstens so viele neue Karten pro Session
  reservedNewSlots: 5,    // so viele Plätze bleiben für neue Karten frei, auch wenn viel fällig ist
  retriesPerSession: 2,   // so oft kommt eine falsch beantwortete Karte in derselben Session wieder
  retryGap: 3,            // ... und zwar nach so vielen anderen Karten

  // Spaced Repetition (vereinfachtes SM-2)
  startEase: 2.5,
  minEase: 1.3,
  maxEase: 3.0,
  easeBonus: 0.05,        // bei richtiger Antwort
  easePenalty: 0.2,       // bei falscher Antwort
  firstIntervals: [1, 3], // Tage nach der 1. und 2. richtigen Antwort, danach Intervall × easeFactor
  solidInterval: 7,       // ab diesem Intervall (Tage) gilt eine Karte als "sicher"

  // Freischaltung der nächsten Kategorie
  unlockWindow: 20,       // die letzten N Antworten der aktuellen Kategorie zählen
  unlockThreshold: 0.8,   // Erfolgsquote muss darüber liegen

  // Freitext
  typoTolerance: 0.2,     // erlaubte Tippfehler = Antwortlänge × Wert (in den Einstellungen änderbar)
  maxInputLength: 32,     // längere Antworten werden nicht als Freitext abgefragt
};

// ---------- Hilfsfunktionen ----------

function dateKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  return dateKey(new Date(year, month - 1, day + days));
}

function shuffle(list) {
  const result = list.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function sum(numbers) {
  return numbers.reduce((total, n) => total + n, 0);
}

// ---------- Speicherung (localStorage) ----------

function defaultState() {
  return {
    version: 1,
    cards: {},      // id -> { interval, easeFactor, dueDate, repetitions }, entsteht beim ersten Üben
    history: {},    // Kategorie-id -> letzte Antworten (1 = richtig, 0 = falsch)
    unlocked: [],   // freigeschaltete Kategorie-ids (die erste Kategorie ist immer frei)
    streak: { count: 0, lastDate: null },
    grammar: {},    // Thema-id -> { best, total }
    settings: { typoTolerance: CONFIG.typoTolerance },
  };
}

function loadState() {
  const state = defaultState();
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.storageKey));
    if (saved && saved.version === state.version) {
      Object.assign(state, saved);
      state.settings = Object.assign(defaultState().settings, saved.settings);
    }
  } catch (err) {
    // Kein oder defekter Speicherstand: mit leerem Stand starten
  }
  return state;
}

function saveState(state) {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
  } catch (err) {
    // Speicher voll oder gesperrt (z.B. privater Modus): App läuft ohne Speichern weiter
  }
}

// ---------- Spaced Repetition ----------

function newSrs() {
  return { interval: 0, easeFactor: CONFIG.startEase, dueDate: null, repetitions: 0 };
}

// Liefert den neuen SRS-Stand einer Karte nach einer Antwort.
function review(srs, correct, today) {
  const next = Object.assign(newSrs(), srs);
  if (correct) {
    next.interval = next.repetitions < CONFIG.firstIntervals.length
      ? CONFIG.firstIntervals[next.repetitions]
      : Math.max(next.interval + 1, Math.round(next.interval * next.easeFactor));
    next.repetitions += 1;
    next.easeFactor = Math.min(CONFIG.maxEase, next.easeFactor + CONFIG.easeBonus);
  } else {
    // Zurücksetzen: Karte ist sofort wieder fällig
    next.interval = 0;
    next.repetitions = 0;
    next.easeFactor = Math.max(CONFIG.minEase, next.easeFactor - CONFIG.easePenalty);
  }
  next.easeFactor = Math.round(next.easeFactor * 100) / 100;
  next.dueDate = addDays(today, next.interval);
  return next;
}

function isDue(srs, today) {
  return Boolean(srs) && srs.dueDate <= today;
}

// ---------- Kategorien & Freischaltung ----------

function isUnlocked(state, data, categoryId) {
  return data.categories[0].id === categoryId || state.unlocked.includes(categoryId);
}

// Die nächste noch gesperrte Kategorie; "aktuell" ist die Kategorie direkt davor.
function nextLockedCategory(state, data) {
  return data.categories.find(category => !isUnlocked(state, data, category.id)) || null;
}

function currentCategory(state, data) {
  const locked = nextLockedCategory(state, data);
  if (!locked) return null;
  return data.categories[data.categories.indexOf(locked) - 1];
}

// Schaltet die nächste Kategorie frei, wenn die Erfolgsquote der letzten
// Antworten in der aktuellen Kategorie über der Schwelle liegt.
function checkUnlock(state, data) {
  const locked = nextLockedCategory(state, data);
  if (!locked) return null;
  const answers = state.history[currentCategory(state, data).id] || [];
  if (answers.length < CONFIG.unlockWindow) return null;
  if (sum(answers) / answers.length <= CONFIG.unlockThreshold) return null;
  state.unlocked.push(locked.id);
  return locked;
}

function categoryStats(state, data, categoryId) {
  const cards = data.items.filter(card => card.category === categoryId);
  const srs = cards.map(card => state.cards[card.id]).filter(Boolean);
  const answers = state.history[categoryId] || [];
  return {
    total: cards.length,
    learned: srs.filter(s => s.repetitions > 0).length,
    solid: srs.filter(s => s.interval >= CONFIG.solidInterval).length,
    answers: answers.length,
    correct: sum(answers),
  };
}

// Verbucht eine Antwort: SRS-Stand, Antwort-Historie der Kategorie, Freischaltung.
// Gibt die neu freigeschaltete Kategorie zurück (oder null).
function recordAnswer(state, data, card, correct, today) {
  const srs = state.cards[card.id];
  // Richtig beantwortete Karten, die noch gar nicht fällig waren (freies Üben),
  // behalten ihren Termin – sonst würden die Intervalle künstlich wachsen.
  const early = Boolean(srs) && !isDue(srs, today);
  if (!(early && correct)) state.cards[card.id] = review(srs, correct, today);

  const answers = state.history[card.category] || (state.history[card.category] = []);
  answers.push(correct ? 1 : 0);
  if (answers.length > CONFIG.unlockWindow) answers.splice(0, answers.length - CONFIG.unlockWindow);

  return checkUnlock(state, data);
}

// ---------- Session-Zusammenstellung ----------

const LEVELS = ['A1', 'A2', 'B1', 'B2'];

function levelRank(card) {
  const rank = LEVELS.indexOf(card.level);
  return rank === -1 ? LEVELS.length : rank;
}

// "Heute üben": fällige Karten (älteste zuerst) plus neue Karten aus freien Kategorien.
// Neue Karten kommen nach Niveau (erst alle A1, dann A2 ...), innerhalb eines
// Niveaus in der Reihenfolge der Datei.
function planSession(state, data, today) {
  const due = data.items
    .filter(card => isDue(state.cards[card.id], today))
    .sort((a, b) => state.cards[a.id].dueDate.localeCompare(state.cards[b.id].dueDate));
  const fresh = data.items
    .filter(card => !state.cards[card.id] && isUnlocked(state, data, card.category))
    .sort((a, b) => levelRank(a) - levelRank(b));

  const newCount = Math.min(
    fresh.length,
    CONFIG.maxNewPerSession,
    Math.max(CONFIG.reservedNewSlots, CONFIG.sessionSize - due.length)
  );
  const dueCount = Math.min(due.length, CONFIG.sessionSize - newCount);
  return {
    due: due.slice(0, dueCount),
    fresh: fresh.slice(0, newCount),
    dueTotal: due.length,
    freshTotal: fresh.length,
  };
}

// Freies Üben einer Kategorie: fällige zuerst, dann neue, dann der Rest nach Termin.
function planCategorySession(state, data, categoryId, today) {
  const rank = card => {
    const srs = state.cards[card.id];
    if (!srs) return '1';
    return isDue(srs, today) ? '0' + srs.dueDate : '2' + srs.dueDate;
  };
  return data.items
    .filter(card => card.category === categoryId)
    .sort((a, b) => rank(a).localeCompare(rank(b)))
    .slice(0, CONFIG.sessionSize);
}

// ---------- Streak ----------

function currentStreak(state, today) {
  const { count, lastDate } = state.streak;
  return lastDate === today || lastDate === addDays(today, -1) ? count : 0;
}

// Nach jeder abgeschlossenen Session aufrufen; zählt pro Tag nur einmal.
function markSessionDone(state, today) {
  if (state.streak.lastDate === today) return;
  state.streak.count = currentStreak(state, today) + 1;
  state.streak.lastDate = today;
}

// ---------- Antwort-Prüfung (Freitext) ----------

const ARTICLES = {
  es: /^(el|la|los|las|un|una) /,
  de: /^(der|die|das|den|ein|eine|einen) /,
};

// Kleinschreibung, ohne Satzzeichen; ohne keepAccents auch ohne Akzente/Umlaute.
function normalize(text, keepAccents = false) {
  let result = text.toLowerCase().replace(/ß/g, 'ss').normalize('NFD');
  result = keepAccents ? result.normalize('NFC') : result.replace(/[̀-ͯ]/g, '');
  return result.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Alle Schreibweisen, die als richtig gelten:
// "A / B" sind Alternativen, "(Hinweis)" wird ignoriert, "vegetariano/a" steht
// für beide Formen, der Artikel darf fehlen, Umlaute dürfen als ae/oe/ue kommen.
function answerVariants(text, lang, keepAccents = false) {
  const variants = new Set();
  for (const part of text.replace(/\([^)]*\)/g, ' ').split(/\s+\/\s+/)) {
    const forms = /o\/a(?!\p{L})/u.test(part)
      ? [part.replace(/o\/a(?!\p{L})/gu, 'o'), part.replace(/o\/a(?!\p{L})/gu, 'a'), part]
      : [part];
    if (lang === 'de') {
      forms.push(...forms.map(form => form.replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue')));
    }
    for (const form of forms) {
      const normalized = normalize(form, keepAccents);
      variants.add(normalized);
      variants.add(normalized.replace(ARTICLES[lang], ''));
    }
  }
  variants.delete('');
  return [...variants];
}

// Levenshtein-Distanz; vertauschte Nachbarbuchstaben zählen als ein Fehler.
function editDistance(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) {
    d.push([i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        d[i][j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// correct: wird als richtig gewertet; exact: auch Akzente und Schreibweise stimmen.
// others: Antworten der übrigen Karten – liegt die Eingabe mindestens so nah an
// einer anderen Vokabel (z.B. "con gas" statt "sin gas"), gilt sie als falsch.
function checkAnswer(input, expected, lang, tolerance, others = []) {
  const wrong = { correct: false, exact: false };
  if (answerVariants(expected, lang, true).includes(normalize(input, true))) {
    return { correct: true, exact: true };
  }
  const typed = normalize(input);
  if (!typed) return wrong;

  const variants = answerVariants(expected, lang);
  const distances = variants
    .map(variant => ({ distance: editDistance(typed, variant), allowed: Math.floor(variant.length * tolerance) }))
    .filter(entry => entry.distance <= entry.allowed)
    .map(entry => entry.distance);
  if (!distances.length) return wrong;

  const best = Math.min(...distances);
  const confusable = best > 0 && others.some(other =>
    answerVariants(other, lang)
      .filter(variant => !variants.includes(variant))
      .some(variant => editDistance(typed, variant) <= best)
  );
  return confusable ? wrong : { correct: true, exact: false };
}

// ---------- App-Zustand & Rendering ----------

const LANG = { es: 'Spanisch', de: 'Deutsch' };
const FORMATS = ['choice', 'input', 'flip'];

let data = null;      // Inhalt von data/vocab-seed.json
let grammar = null;   // Inhalt von data/grammar.json
let state = loadState();
let view = { name: 'home' };
let session = null;   // laufende Übungs-Session

function esc(text) {
  return String(text).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function render() {
  const views = {
    home: renderHome,
    grammar: renderGrammarList,
    topic: renderTopic,
    settings: renderSettings,
    session: renderSession,
    summary: renderSummary,
  };
  const app = document.getElementById('app');
  app.innerHTML = views[view.name]();

  const tabbar = document.getElementById('tabbar');
  tabbar.hidden = view.name === 'session' || view.name === 'summary';
  for (const button of tabbar.querySelectorAll('button')) {
    if (button.dataset.tab === (view.tab || view.name)) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  window.scrollTo(0, 0);
  const focus = app.querySelector('[data-autofocus]');
  if (focus) focus.focus();
}

// ---------- Startbildschirm ----------

function renderHome() {
  const today = dateKey();
  const streak = currentStreak(state, today);
  let streakNote = 'Schließe eine Session ab, um einen Streak zu starten';
  if (state.streak.lastDate === today) streakNote = 'Heute schon geübt';
  else if (streak) streakNote = 'Heute noch nicht geübt – eine Session hält den Streak';

  const plan = planSession(state, data, today);
  const parts = [];
  if (plan.due.length) parts.push(`${plan.due.length} fällig`);
  if (plan.fresh.length) parts.push(`${plan.fresh.length} neu`);
  const planNote = parts.length
    ? `${plan.due.length + plan.fresh.length} Karten: ${parts.join(' · ')}`
    : 'Für heute ist alles erledigt. Du kannst unten jede freie Kategorie zusätzlich üben.';

  return `
    <h1>¡Hola!</h1>
    <p class="muted">Spanisch für Reiseleiter</p>
    <section class="card streak">
      <div class="streak-count">${streak}</div>
      <div>
        <p><strong>${streak === 1 ? 'Tag' : 'Tage'} in Folge</strong></p>
        <p class="muted small">${streakNote}</p>
      </div>
    </section>
    <section class="card">
      <button type="button" class="btn primary" data-action="practice-today"${parts.length ? '' : ' disabled'}>Heute üben</button>
      <p class="muted small">${planNote}</p>
    </section>
    <h2>Kategorien</h2>
    <p class="muted small">Balken: hell = gelernt, dunkel = sicher (Intervall ab ${CONFIG.solidInterval} Tagen)</p>
    <ul class="cats">${data.categories.map(renderCategory).join('')}</ul>`;
}

function renderCategory(category, index) {
  const stats = categoryStats(state, data, category.id);
  const threshold = Math.round(CONFIG.unlockThreshold * 100);
  const head = count => `
    <div class="cat-head">
      <span class="cat-name">${index + 1}. ${esc(category.name_de)}</span>
      <span class="cat-count">${count}</span>
    </div>`;

  if (!isUnlocked(state, data, category.id)) {
    const note = nextLockedCategory(state, data) === category
      ? `Gesperrt – wird frei bei über ${threshold} % in „${esc(data.categories[index - 1].name_de)}“`
      : 'Gesperrt';
    return `<li class="card cat locked">${head(`${stats.total} Karten`)}<p class="muted small">${note}</p></li>`;
  }

  let note = 'Noch nicht geübt';
  if (stats.answers) {
    note = `Erfolgsquote: ${Math.round(stats.correct / stats.answers * 100)} % (${stats.correct}/${stats.answers})`;
    if (currentCategory(state, data) === category) {
      note += stats.answers < CONFIG.unlockWindow
        ? ` · Freischaltung ab ${CONFIG.unlockWindow} Antworten mit über ${threshold} %`
        : ` · über ${threshold} % schaltet die nächste Kategorie frei`;
    }
  }
  const percent = count => Math.round(count / stats.total * 100);
  return `
    <li class="card cat">
      ${head(`${stats.learned} / ${stats.total} gelernt`)}
      <div class="bar" role="img" aria-label="${stats.learned} von ${stats.total} gelernt, ${stats.solid} sicher">
        <div class="bar-fill bar-learned" style="width:${percent(stats.learned)}%"></div>
        <div class="bar-fill bar-solid" style="width:${percent(stats.solid)}%"></div>
      </div>
      <div class="cat-foot">
        <p class="muted small">${note}</p>
        <button type="button" class="btn inline" data-action="practice-category" data-id="${esc(category.id)}">Üben</button>
      </div>
    </li>`;
}

// ---------- Übungs-Session ----------

function startVocabSession(cards, title) {
  if (!cards.length) return;
  session = {
    kind: 'vocab',
    title,
    queue: shuffle(cards).map(card => ({ card, tries: 0 })),
    step: 0,
    formatOffset: Math.floor(Math.random() * FORMATS.length),
    done: 0,
    correct: 0,
    unlocked: [],
    current: null,
  };
  view = { name: 'session' };
  nextQuestion();
}

function nextQuestion() {
  if (!session.queue.length) {
    finishSession();
    return;
  }
  const entry = session.queue.shift();
  session.current = session.kind === 'grammar'
    ? { entry, exercise: entry.exercise, phase: 'ask', result: null }
    : makeVocabQuestion(entry);
  render();
}

function makeVocabQuestion(entry) {
  const card = entry.card;
  const [from, to] = Math.random() < 0.5 ? ['es', 'de'] : ['de', 'es'];
  const question = { entry, card, from, to, format: pickFormat(card, to), phase: 'ask', result: null };
  if (question.format === 'choice') question.options = buildOptions(card, to);
  return question;
}

// Die drei Formate wechseln reihum. Neue Karten und sehr lange Antworten
// werden nicht frei getippt, sondern als Multiple Choice bzw. Karteikarte gefragt.
function pickFormat(card, answerLang) {
  const step = session.step++;
  const format = FORMATS[(step + session.formatOffset) % FORMATS.length];
  if (format !== 'input') return format;
  const shortest = Math.min(...answerVariants(card[answerLang], answerLang).map(variant => variant.length));
  if (!state.cards[card.id] || shortest > CONFIG.maxInputLength) return step % 2 ? 'choice' : 'flip';
  return format;
}

// Richtige Antwort plus 3 Distraktoren aus derselben Kategorie (bevorzugt gleicher Typ).
function buildOptions(card, lang) {
  const pool = shuffle(data.items.filter(other => other.category === card.category && other.id !== card.id));
  const candidates = pool.filter(other => other.type === card.type).concat(pool.filter(other => other.type !== card.type));
  const texts = [card[lang]];
  for (const other of candidates) {
    if (texts.length === 4) break;
    if (!texts.includes(other[lang])) texts.push(other[lang]);
  }
  return shuffle(texts.map((text, index) => ({ text, correct: index === 0 })));
}

function commitAnswer(correct) {
  const question = session.current;
  session.done += 1;
  if (correct) session.correct += 1;

  if (session.kind === 'grammar') {
    if (!correct) session.mistakes.push(question);
    nextQuestion();
    return;
  }

  const unlocked = recordAnswer(state, data, question.card, correct, dateKey());
  if (unlocked) session.unlocked.push(unlocked);
  saveState(state);
  // Falsch beantwortete Karten kommen nach ein paar anderen Karten noch einmal
  if (!correct && question.entry.tries < CONFIG.retriesPerSession) {
    question.entry.tries += 1;
    session.queue.splice(Math.min(CONFIG.retryGap, session.queue.length), 0, question.entry);
  }
  nextQuestion();
}

function finishSession() {
  markSessionDone(state, dateKey());
  if (session.kind === 'grammar') {
    const best = state.grammar[session.topic.id];
    if (!best || session.correct > best.best) {
      state.grammar[session.topic.id] = { best: session.correct, total: session.done };
    }
  }
  saveState(state);
  view = { name: 'summary' };
  render();
}

function renderSession() {
  const question = session.current;
  const position = session.done + 1;
  const total = position + session.queue.length;
  return `
    <header class="session-head">
      <button type="button" class="link" data-action="quit">Beenden</button>
      <span class="muted">${esc(session.title)} · ${position} / ${total}</span>
    </header>
    <div class="bar"><div class="bar-fill bar-solid" style="width:${Math.round(session.done / total * 100)}%"></div></div>
    <section class="card">${session.kind === 'grammar' ? renderGrammarQuestion(question) : renderVocabQuestion(question)}</section>`;
}

function renderVocabQuestion(question) {
  const { card, from, to } = question;
  const head = `
    <p class="label">${LANG[from]} → ${LANG[to]}${card.level ? ` · ${esc(card.level)}` : ''}</p>
    <p class="prompt" lang="${from}">${esc(card[from])}</p>`;
  if (question.format === 'choice') return head + renderChoice(question);
  if (question.format === 'flip') return head + renderFlip(question);
  if (question.phase === 'ask') return head + renderInputForm(`Antwort auf ${LANG[to]}`);
  return head + renderInputFeedback(question, `<span lang="${to}">${esc(card[to])}</span>`, { allowOverride: true });
}

function renderResult(result) {
  let text = 'Leider falsch';
  if (result.correct) text = result.exact ? 'Richtig!' : 'Richtig – achte auf die genaue Schreibweise';
  return `<p class="result ${result.correct ? 'ok' : 'bad'}">${text}</p>`;
}

function renderChoice(question) {
  const answered = question.phase === 'feedback';
  const options = question.options.map((option, index) => {
    let mark = '';
    if (answered && option.correct) mark = ' correct';
    else if (answered && index === question.chosen) mark = ' wrong';
    return `<button type="button" class="btn option${mark}" lang="${question.to}" data-action="choose" data-index="${index}"${answered ? ' disabled' : ''}>${esc(option.text)}</button>`;
  }).join('');
  if (!answered) return `<div class="options">${options}</div>`;
  return `
    <div class="options">${options}</div>
    ${renderResult(question.result)}
    <div class="actions"><button type="button" class="btn primary" data-action="next" data-autofocus>Weiter</button></div>`;
}

function renderFlip(question) {
  if (question.phase === 'ask') {
    return `<div class="actions"><button type="button" class="btn primary" data-action="flip" data-autofocus>Umdrehen</button></div>`;
  }
  return `
    <hr class="divider">
    <p class="label">${LANG[question.to]}</p>
    <p class="solution" lang="${question.to}">${esc(question.card[question.to])}</p>
    <div class="actions two">
      <button type="button" class="btn" data-action="self" data-correct="0">Wusste ich nicht</button>
      <button type="button" class="btn primary" data-action="self" data-correct="1">Wusste ich</button>
    </div>`;
}

function renderInputForm(placeholder) {
  return `
    <form data-form="answer" autocomplete="off">
      <input class="answer-input" name="answer" type="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"
        autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="done" data-autofocus>
      <div class="actions">
        <button type="submit" class="btn primary">Prüfen</button>
        <button type="button" class="link" data-action="give-up">Weiß ich nicht</button>
      </div>
    </form>`;
}

function renderInputFeedback(question, solutionHtml, { extra = '', allowOverride = false } = {}) {
  const typed = question.typed ? `<p class="muted">Deine Antwort: ${esc(question.typed)}</p>` : '';
  const override = allowOverride && question.typed && !question.result.correct
    ? '<button type="button" class="link" data-action="override">War doch richtig</button>'
    : '';
  return `
    ${renderResult(question.result)}
    ${typed}
    <p class="label">Lösung</p>
    <p class="solution">${solutionHtml}</p>
    ${extra}
    <div class="actions">
      <button type="button" class="btn primary" data-action="next" data-autofocus>Weiter</button>
      ${override}
    </div>`;
}

function submitAnswer(text) {
  const question = session.current;
  if (question.phase !== 'ask' || !text.trim()) return;
  question.typed = text.trim();
  if (session.kind === 'grammar') {
    question.result = checkGrammarAnswer(text, question.exercise);
  } else {
    const others = data.items.filter(card => card.id !== question.card.id).map(card => card[question.to]);
    question.result = checkAnswer(text, question.card[question.to], question.to, state.settings.typoTolerance, others);
  }
  question.phase = 'feedback';
  render();
}

function renderSummary() {
  const streak = currentStreak(state, dateKey());
  const unlocked = session.unlocked
    .map(category => `<p class="result ok">Neue Kategorie freigeschaltet: ${esc(category.name_de)}</p>`)
    .join('');
  const buttons = session.kind === 'grammar'
    ? `<button type="button" class="btn primary" data-action="start-grammar" data-id="${esc(session.topic.id)}">Nochmal üben</button>
       <button type="button" class="btn" data-action="quit">Zurück zum Thema</button>`
    : '<button type="button" class="btn primary" data-action="quit" data-autofocus>Zur Startseite</button>';
  return `
    <h1>Geschafft!</h1>
    <p class="muted">${esc(session.title)}</p>
    <section class="card">
      <p class="prompt">${session.correct} von ${session.done} Antworten richtig</p>
      <p>Streak: <strong>${streak} ${streak === 1 ? 'Tag' : 'Tage'}</strong> in Folge</p>
    </section>
    ${unlocked}
    ${session.kind === 'grammar' ? renderMistakes(session.mistakes) : ''}
    <div class="actions">${buttons}</div>`;
}

// ---------- Grammatik ----------

function findTopic(id) {
  return grammar.topics.find(topic => topic.id === id);
}

function renderGrammarList() {
  const topics = grammar.topics.map(topic => {
    const best = state.grammar[topic.id];
    const note = best ? `Bestes Ergebnis: ${best.best} / ${best.total}` : `${topic.exercises.length} Übungen`;
    return `
      <li class="card">
        <h2>${esc(topic.title)}</h2>
        <p class="muted small">${esc(topic.subtitle)}</p>
        <div class="cat-foot">
          <p class="muted small">${note}</p>
          <button type="button" class="btn inline" data-action="open-topic" data-id="${esc(topic.id)}">Öffnen</button>
        </div>
      </li>`;
  }).join('');
  return `
    <h1>Grammatik</h1>
    <p class="muted">Lateinamerikanisches Spanisch – mit ustedes, ohne vosotros.</p>
    <ul class="topic-list">${topics}</ul>`;
}

function renderTopic() {
  const topic = findTopic(view.id);
  const cells = (row, tag) => row.map(cell => `<${tag}>${esc(cell)}</${tag}>`).join('');
  const table = topic.table ? `
    <section class="card table-wrap">
      <table lang="es">
        <thead><tr>${cells(topic.table.head, 'th')}</tr></thead>
        <tbody>${topic.table.rows.map(row => `<tr>${cells(row, 'td')}</tr>`).join('')}</tbody>
      </table>
    </section>` : '';
  return `
    <button type="button" class="link" data-action="tab" data-tab="grammar">‹ Grammatik</button>
    <h1>${esc(topic.title)}</h1>
    <p class="muted">${esc(topic.subtitle)}</p>
    <section class="card"><p>${esc(topic.explanation)}</p></section>
    ${table}
    <div class="actions">
      <button type="button" class="btn primary" data-action="start-grammar" data-id="${esc(topic.id)}">Übungen starten (${topic.exercises.length})</button>
    </div>`;
}

function startGrammarSession(topic) {
  session = {
    kind: 'grammar',
    title: topic.title,
    topic,
    queue: shuffle(topic.exercises).map(exercise => ({ exercise })),
    done: 0,
    correct: 0,
    unlocked: [],
    mistakes: [],
    current: null,
  };
  view = { name: 'session' };
  nextQuestion();
}

// Bei Konjugationen gibt es keine Tippfehler-Toleranz ("tiene" ist nicht "tienen");
// nur Groß-/Kleinschreibung und fehlende Akzente werden verziehen.
function checkGrammarAnswer(input, exercise) {
  const answers = [].concat(exercise.answer);
  if (answers.some(answer => normalize(answer, true) === normalize(input, true))) return { correct: true, exact: true };
  if (answers.some(answer => normalize(answer) === normalize(input))) return { correct: true, exact: false };
  return { correct: false, exact: false };
}

// Der Satz mit ausgefüllter (oder markierter) Lücke.
function renderSentence(exercise, gapHtml) {
  const [before, after] = exercise.sentence.split('___');
  return `<span lang="es">${esc(before)}${gapHtml}${esc(after)}</span>`;
}

function renderSolvedSentence(exercise) {
  return renderSentence(exercise, `<span class="fill">${esc([].concat(exercise.answer)[0])}</span>`);
}

function renderGrammarQuestion(question) {
  const exercise = question.exercise;
  const label = `<p class="label">Lücke füllen · ${esc(exercise.hint)}</p>`;
  const translation = `<p class="hint">${esc(exercise.de)}</p>`;
  if (question.phase === 'ask') {
    return `
      ${label}
      <p class="prompt">${renderSentence(exercise, '<span class="blank">___</span>')}</p>
      ${translation}
      ${renderInputForm('Fehlende Form')}`;
  }
  return label + renderInputFeedback(question, renderSolvedSentence(exercise), { extra: translation });
}

function renderMistakes(mistakes) {
  if (!mistakes.length) return '';
  const items = mistakes.map(question => `
    <li>
      ${renderSolvedSentence(question.exercise)}
      ${question.typed ? `<br><span class="muted small">Deine Antwort: ${esc(question.typed)}</span>` : ''}
    </li>`).join('');
  return `
    <section class="card">
      <p class="label">Zum Wiederholen</p>
      <ul class="mistakes">${items}</ul>
    </section>`;
}

// ---------- Einstellungen ----------

const TOLERANCES = [
  [0, 'Aus – keine Tippfehler erlaubt'],
  [0.1, 'Streng'],
  [0.2, 'Normal'],
  [0.3, 'Großzügig'],
];

function renderSettings() {
  const options = TOLERANCES.map(([value, label]) => (
    `<option value="${value}"${value === state.settings.typoTolerance ? ' selected' : ''}>${label}</option>`
  )).join('');
  const practiced = data.items.filter(card => state.cards[card.id]).length;
  return `
    <h1>Einstellungen</h1>
    <section class="card">
      <label for="tolerance"><strong>Tippfehler-Toleranz bei Freitext</strong></label>
      <select id="tolerance" data-setting="typoTolerance">${options}</select>
      <p class="muted small">Groß-/Kleinschreibung, Satzzeichen und fehlende Akzente werden immer verziehen. Zusätzlich sind je nach Stufe Tippfehler erlaubt – bei „Normal“ zum Beispiel 2 Fehler in einer Antwort mit 10 Buchstaben.</p>
    </section>
    <section class="card">
      <p><strong>Lernstand</strong></p>
      <p class="muted small">${practiced} von ${data.items.length} Karten geübt. Der Lernstand liegt nur in diesem Browser auf diesem Gerät.</p>
      <button type="button" class="btn danger" data-action="reset">Lernstand zurücksetzen</button>
    </section>`;
}

// ---------- Ereignisse ----------

const actions = {
  tab(el) {
    view = { name: el.dataset.tab };
    render();
  },
  'practice-today'() {
    const plan = planSession(state, data, dateKey());
    startVocabSession(plan.due.concat(plan.fresh), 'Heute üben');
  },
  'practice-category'(el) {
    const category = data.categories.find(c => c.id === el.dataset.id);
    startVocabSession(planCategorySession(state, data, category.id, dateKey()), category.name_de);
  },
  'open-topic'(el) {
    view = { name: 'topic', tab: 'grammar', id: el.dataset.id };
    render();
  },
  'start-grammar'(el) {
    startGrammarSession(findTopic(el.dataset.id));
  },
  quit() {
    view = session && session.kind === 'grammar'
      ? { name: 'topic', tab: 'grammar', id: session.topic.id }
      : { name: 'home' };
    session = null;
    render();
  },
  choose(el) {
    const question = session.current;
    question.chosen = Number(el.dataset.index);
    const correct = question.options[question.chosen].correct;
    question.result = { correct, exact: correct };
    question.phase = 'feedback';
    render();
  },
  flip() {
    session.current.phase = 'flipped';
    render();
  },
  self(el) {
    commitAnswer(el.dataset.correct === '1');
  },
  'give-up'() {
    const question = session.current;
    question.typed = '';
    question.result = { correct: false, exact: false };
    question.phase = 'feedback';
    render();
  },
  next() {
    commitAnswer(session.current.result.correct);
  },
  override() {
    commitAnswer(true);
  },
  reset() {
    if (!confirm('Wirklich den gesamten Lernstand löschen? Streak, Fortschritt und Freischaltungen gehen verloren.')) return;
    const settings = state.settings;
    state = defaultState();
    state.settings = settings;
    saveState(state);
    render();
  },
};

// ---------- Start ----------

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function init() {
  try {
    [data, grammar] = await Promise.all([loadJson('data/vocab-seed.json'), loadJson('data/grammar.json')]);
  } catch (err) {
    document.getElementById('app').innerHTML = `
      <p class="error">Die Lerndaten konnten nicht geladen werden.</p>
      <p class="muted">Die App muss über einen Webserver geöffnet werden (nicht per Doppelklick auf index.html).</p>`;
    return;
  }

  document.addEventListener('click', event => {
    const el = event.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el);
  });
  document.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.dataset.form === 'answer') submitAnswer(new FormData(event.target).get('answer'));
  });
  document.addEventListener('change', event => {
    if (event.target.dataset.setting === 'typoTolerance') {
      state.settings.typoTolerance = Number(event.target.value);
      saveState(state);
    }
  });

  render();

  // Offline-Fähigkeit; funktioniert nur über HTTPS oder localhost
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

// Die Tests laden nur die Logik, ohne Oberfläche
if (document.getElementById('app')) init();

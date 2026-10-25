const $ = (id) => document.getElementById(id);
const app = $('app');
const isPreview = new URLSearchParams(location.search).has('preview');

let data = null;
let colors = {};
let conflicts = {};
let liveTimer = null;

async function load() {
  try {
    if (isPreview) {
      const draft = readDraft();
      data = normalizeData(draft && draft.data);
      $('preview-note').hidden = false;
    } else {
      data = await fetchPublished();
    }
  } catch {
    app.innerHTML = `
      <div class="state">
        <p>ما قدرنا نحمّل الجدول. تأكد من الإنترنت وجرّب كمان مرة.</p>
        <button class="btn btn-primary" type="button" data-action="retry">إعادة المحاولة</button>
      </div>`;
    return;
  }
  $('title').textContent = data.title;
  $('subtitle').textContent = data.subtitle;
  $('subtitle').hidden = !data.subtitle;
  document.title = data.subtitle ? `${data.title} · ${data.subtitle}` : data.title;
  $('updated').textContent = isPreview ? '' : formatUpdated(data.updatedAt);
  render();
  clearInterval(liveTimer);
  liveTimer = setInterval(updateLive, 30000);
}

function hourLabel(h) {
  return `${h % 12 || 12} ${h < 12 ? 'ص' : 'م'}`;
}

function clock(t) {
  const total = toMinutes(t);
  return `${Math.floor(total / 60) % 12 || 12}:${String(total % 60).padStart(2, '0')}`;
}

/* المحاضرات المتداخلة بنفس اليوم بتنقسم جنب بعض */
function layoutDay(items) {
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    cluster.forEach((it) => {
      let i = lanes.findIndex((end) => end <= it.start);
      if (i === -1) { i = lanes.length; lanes.push(0); }
      lanes[i] = it.end;
      it.lane = i;
    });
    cluster.forEach((it) => { it.lanes = lanes.length; });
    out.push(...cluster);
    cluster = [];
  };
  items.forEach((it) => {
    if (cluster.length && it.start >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  });
  if (cluster.length) flush();
  return out;
}

const QUIZ_COLOR = '#F59E0B';
let weekDates = {};   // يوم الأسبوع ← تاريخه بهالأسبوع
let renderedWeek = '';
let lectureQuiz = {}; // محاضرة ← كويز بهالأسبوع بنفس وقتها

function render() {
  const lectures = data.lectures;
  const now = new Date();
  const ws = weekStart(now);
  renderedWeek = dateKey(ws);
  weekDates = Object.fromEntries(DAYS.map((d, i) => [d.key, dateKey(addDays(ws, i))]));
  colors = subjectColors([...lectures, ...data.quizzes]);
  conflicts = findConflicts(lectures);
  renderUpcomingQuizzes(now);

  // كويزات هالأسبوع: إذا وقتها جوّا محاضرة لنفس المادة بتطلع علامة عليها، وإلا بتطلع لحالها بالجدول
  const thisWeek = Object.values(weekDates);
  lectureQuiz = {};
  const loose = [];
  data.quizzes.filter((q) => thisWeek.includes(q.date)).forEach((q) => {
    const day = dayKeyOf(q.date);
    const host = lectures.find((l) => l.day === day && l.subject === q.subject
      && toMinutes(l.from) < toMinutes(q.to) && toMinutes(q.from) < toMinutes(l.to));
    if (host && !lectureQuiz[host.id]) lectureQuiz[host.id] = q;
    else loose.push({ ...q, day });
  });

  const items = [
    ...lectures.map((l) => ({ kind: 'lec', l })),
    ...loose.map((q) => ({ kind: 'quiz', l: q })),
  ];
  if (!items.length) {
    app.innerHTML = '<p class="state">لسا ما انضافت محاضرات للجدول.</p>';
    $('now').hidden = true;
    return;
  }

  // أيام الدوام من السبت للخميس دايماً ظاهرة، والجمعة بس إذا فيها شي
  const days = DAYS.filter((d) => d.key !== 'fri' || items.some((it) => it.l.day === 'fri'));
  const startHour = Math.floor(Math.min(...items.map((it) => toMinutes(it.l.from))) / 60);
  let endHour = Math.ceil(Math.max(...items.map((it) => toMinutes(it.l.to))) / 60);
  if (endHour - startHour < 4) endHour = Math.min(24, startHour + 4);
  const hours = endHour - startHour;
  const rangeStart = startHour * 60;
  const total = hours * 60;
  const pct = (m) => `${((m - rangeStart) / total) * 100}%`;

  const head = days.map((d) => `
    <div class="day-head" data-day="${d.key}">
      <span class="full">${d.name}</span><span class="short">${d.short}</span>
      <span class="day-date">${shortDate(weekDates[d.key])}</span>
    </div>`).join('');

  const axis = Array.from({ length: hours }, (_, i) => `<span style="top:${(i / hours) * 100}%">${hourLabel(startHour + i)}</span>`).join('');

  const block = ({ kind, l, start, end, lane, lanes }) => {
    const pos = `top:${pct(start)};height:${((end - start) / total) * 100}%;inset-inline-start:${(lane / lanes) * 100}%;width:${100 / lanes}%`;
    const time = `<span class="lec-time">${clock(l.from)}<span class="lec-to"> – ${clock(l.to)}</span></span>`;
    if (kind === 'quiz') {
      return `
      <button type="button" class="lec is-quiz" data-quiz="${l.id}" data-from="${start}" data-to="${end}" style="--c:${QUIZ_COLOR};${pos}">
        <span class="lec-name"><span class="quiz-badge">كويز</span> ${escapeHtml(l.subject)}</span>
        ${time}
      </button>`;
    }
    const classes = ['lec', conflicts[l.id] && 'has-clash', lectureQuiz[l.id] && 'has-quiz'].filter(Boolean).join(' ');
    return `
      <button type="button" class="${classes}" data-id="${l.id}" data-from="${start}" data-to="${end}" style="--c:${colors[l.subject]};${pos}">
        ${conflicts[l.id] ? '<span class="clash-dot" aria-label="في تعارض"></span>' : ''}
        <span class="lec-name">${escapeHtml(l.subject)}</span>
        ${lectureQuiz[l.id]
          ? `<span class="lec-time">${clock(l.from)} <span class="quiz-badge">كويز</span></span>`
          : time}
        ${l.room ? `<span class="lec-room">${escapeHtml(l.room)}</span>` : ''}
      </button>`;
  };

  const cols = days.map((d) => {
    const dayItems = layoutDay(items
      .filter((it) => it.l.day === d.key)
      .map((it) => ({ ...it, start: toMinutes(it.l.from), end: toMinutes(it.l.to) }))
      .sort((a, b) => a.start - b.start));
    return `<div class="day-col" data-day="${d.key}">${dayItems.map(block).join('')}<div class="now-line" hidden></div></div>`;
  }).join('');

  app.innerHTML = `
    <div class="board-scroll" id="board-scroll">
    <div class="board" style="--days:${days.length};--hours:${hours}" data-start="${rangeStart}" data-total="${total}">
      <div class="board-head"><div class="corner"></div>${head}</div>
      <div class="board-body"><div class="axis">${axis}</div>${cols}</div>
    </div>
    </div>
    <p class="board-hint">اضغط على أي محاضرة لتشوف تفاصيلها</p>`;
  updateLive();
  scrollToToday();
}

function renderUpcomingQuizzes(now) {
  const upcoming = data.quizzes.filter((q) => !quizEnded(q, now)).slice(0, 6);
  const el = $('quizzes');
  el.hidden = !upcoming.length;
  if (!upcoming.length) return;
  el.innerHTML = `
    <h2 class="quiz-card-title">الكويزات الجاية</h2>
    ${upcoming.map((q) => {
      const n = daysUntil(q.date, now);
      return `
      <button type="button" class="quiz-row${n <= 1 ? ' is-soon' : ''}" data-quiz="${q.id}">
        <span class="quiz-date"><b>${DAYS.find((d) => d.key === dayKeyOf(q.date)).name}</b><small>${shortDate(q.date)}</small></span>
        <span class="quiz-info"><strong>${escapeHtml(q.subject)}</strong><span>الساعة ${timeText(q.from)}${q.note ? ` · ${escapeHtml(q.note)}` : ''}</span></span>
        <span class="quiz-when">${daysUntilText(q.date, now)}</span>
      </button>`;
    }).join('')}`;
}

/* على الجوال الجدول بينسحب لجنب؛ نخلّي عمود اليوم أول عمود جنب الساعات */
function scrollToToday() {
  const sc = $('board-scroll');
  const col = sc && sc.querySelector('.day-col.is-today');
  if (!col || sc.scrollWidth <= sc.clientWidth) return;
  const axis = sc.querySelector('.axis').getBoundingClientRect();
  sc.scrollLeft += col.getBoundingClientRect().right - axis.left;
}

/* يحدّد المحاضرة الحالية أو الجاية حسب ساعة الجهاز */
function computeStatus(now) {
  const lectures = data.lectures;
  const tk = todayKey(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = lectures.filter((l) => l.day === tk);

  const current = today.find((l) => toMinutes(l.from) <= mins && mins < toMinutes(l.to));
  if (current) return { type: 'now', lecture: current, left: toMinutes(current.to) - mins };

  const next = today.find((l) => toMinutes(l.from) > mins);
  if (next) return { type: 'next', lecture: next, wait: toMinutes(next.from) - mins };

  const ti = DAY_ORDER[tk];
  for (let k = 1; k <= 7; k++) {
    const day = DAYS[(ti + k) % 7].key;
    const first = lectures.find((l) => l.day === day);
    if (first) return { type: today.length ? 'done' : 'free', lecture: first, offset: k };
  }
  return null;
}

function zoomButton(subject, extraClass = '') {
  const z = data.zoom[subject];
  if (!z) return '';
  return `<a class="btn btn-zoom ${extraClass}" href="${escapeHtml(z.url)}" target="_blank" rel="noopener"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM17 10l4-2.5v9L17 14z"/></svg>افتح رابط الزوم</a>`;
}

/* الكويز الجاي لمادة معيّنة (بأي أسبوع) */
function nextQuizFor(subject, now = new Date()) {
  return data.quizzes.find((q) => q.subject === subject && !quizEnded(q, now));
}

function nowHtml(st, now) {
  const l = st.lecture;
  const subject = escapeHtml(l.subject);
  const place = l.room ? ` · ${escapeHtml(l.room)}` : '';
  const att = l.attendance === 'required' ? ' · الحضور إجباري' : '';
  const quiz = nextQuizFor(l.subject, now);
  const quizToday = quiz && quiz.date === dateKey(now) && st.type !== 'done' && st.type !== 'free'
    ? '<span class="now-quiz">فيها كويز</span>' : '';
  if (st.type === 'now') {
    return `
      <span class="now-label"><i class="pulse"></i>هلأ عندك</span>
      <strong class="now-title">${subject}${quizToday}</strong>
      <span class="now-meta">بتخلص ${timeText(l.to)} · باقي ${durationText(st.left)}${place}${att}</span>
      ${zoomButton(l.subject, 'now-zoom')}`;
  }
  if (st.type === 'next') {
    return `
      <span class="now-label">المحاضرة الجاية اليوم</span>
      <strong class="now-title">${subject}${quizToday}</strong>
      <span class="now-meta">الساعة ${timeText(l.from)} · بعد ${durationText(st.wait)}${place}${att}</span>
      ${zoomButton(l.subject, 'now-zoom')}`;
  }
  const when = st.offset === 1 ? 'بكرة' : `يوم ${dayName(l.day)}`;
  return `
    <span class="now-label">${st.type === 'done' ? 'خلصت محاضرات اليوم' : 'ما في محاضرات اليوم'} · الجاية</span>
    <strong class="now-title">${subject}</strong>
    <span class="now-meta">${when} الساعة ${timeText(l.from)}${place}${att}</span>`;
}

function updateLive() {
  if (!data) return;
  const now = new Date();
  // بلش أسبوع جديد والصفحة مفتوحة: نعيد الرسم بتواريخ الأسبوع الجديد
  if (renderedWeek && dateKey(weekStart(now)) !== renderedWeek) return render();
  renderUpcomingQuizzes(now);
  if (!data.lectures.length) return;
  const tk = todayKey(now);
  const mins = now.getHours() * 60 + now.getMinutes();

  const st = computeStatus(now);
  $('now').hidden = !st;
  if (st) $('now').innerHTML = nowHtml(st, now);

  const board = app.querySelector('.board');
  if (!board) return;
  const start = Number(board.dataset.start);
  const total = Number(board.dataset.total);
  board.querySelectorAll('[data-day]').forEach((el) => el.classList.toggle('is-today', el.dataset.day === tk));
  board.querySelectorAll('.day-col').forEach((col) => {
    const isToday = col.dataset.day === tk;
    col.querySelectorAll('.lec').forEach((b) => {
      b.classList.toggle('is-now', isToday && Number(b.dataset.from) <= mins && mins < Number(b.dataset.to));
      b.classList.toggle('is-past', isToday && mins >= Number(b.dataset.to));
    });
    const line = col.querySelector('.now-line');
    const inRange = isToday && mins >= start && mins <= start + total;
    line.hidden = !inRange;
    if (inRange) line.style.top = `${((mins - start) / total) * 100}%`;
  });
}

function factsHtml(facts) {
  return `<dl class="facts">${facts.filter(Boolean).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

function zoomHtml(subject) {
  const z = data.zoom[subject];
  if (!z) return '';
  return `${zoomButton(subject, 'btn-block')}
    <p class="zoom-when">${z.updatedAt ? `آخر تحديث للرابط: ${timeAgo(z.updatedAt)}` : ''}</p>`;
}

function openDetails(id) {
  const l = data.lectures.find((x) => x.id === id);
  if (!l) return;
  const quiz = nextQuizFor(l.subject);
  $('details-body').innerHTML = `
    <span class="sheet-handle" aria-hidden="true"></span>
    <p class="sheet-tag" style="--c:${colors[l.subject]}"><i></i>محاضرة</p>
    <h2 id="details-title">${escapeHtml(l.subject)}</h2>
    ${conflicts[l.id] ? `<p class="clash-note"><i class="clash-dot" aria-hidden="true"></i>${conflictHtml(conflicts[l.id])}</p>` : ''}
    ${quiz ? `<p class="quiz-note"><b>كويز ${daysUntilText(quiz.date)}</b> · ${longDate(quiz.date)} الساعة ${timeText(quiz.from)}${quiz.note ? ` · ${escapeHtml(quiz.note)}` : ''}</p>` : ''}
    ${factsHtml([
      ['اليوم', dayName(l.day)],
      ['الوقت', `${timeText(l.from)} – ${timeText(l.to)}`],
      ['المدة', durationText(toMinutes(l.to) - toMinutes(l.from))],
      l.attendance && ['الحضور', `<span class="att-tag att-${l.attendance}">${ATTENDANCE[l.attendance]}</span>`],
      l.room && ['القاعة', escapeHtml(l.room)],
      l.doctor && ['المحاضر', escapeHtml(l.doctor)],
      l.note && ['ملاحظة', escapeHtml(l.note)],
    ])}
    ${zoomHtml(l.subject)}
    <button class="btn btn-block" type="button" data-action="close-details">تمام</button>`;
  $('details').showModal();
}

function openQuizDetails(id) {
  const q = data.quizzes.find((x) => x.id === id);
  if (!q) return;
  const ended = quizEnded(q);
  $('details-body').innerHTML = `
    <span class="sheet-handle" aria-hidden="true"></span>
    <p class="sheet-tag" style="--c:${QUIZ_COLOR}"><i></i>كويز ${ended ? '· خلص' : daysUntilText(q.date)}</p>
    <h2 id="details-title">${escapeHtml(q.subject)}</h2>
    ${factsHtml([
      ['التاريخ', longDate(q.date)],
      ['الوقت', `${timeText(q.from)} – ${timeText(q.to)}`],
      ['المدة', durationText(toMinutes(q.to) - toMinutes(q.from))],
      q.note && ['ملاحظة', escapeHtml(q.note)],
    ])}
    ${zoomHtml(q.subject)}
    <button class="btn btn-block" type="button" data-action="close-details">تمام</button>`;
  $('details').showModal();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('dialog')) return;
  const quiz = e.target.closest('[data-quiz]');
  if (quiz) return openQuizDetails(quiz.dataset.quiz);
  const lec = e.target.closest('.lec[data-id]');
  if (lec) return openDetails(lec.dataset.id);
  if (e.target.closest('[data-action="retry"]')) load();
});

$('details').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-action="close-details"]')) $('details').close();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateLive();
});

load();

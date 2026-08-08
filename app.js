const views = ['loading', 'offline', 'start', 'quiz', 'result'];
const state = { apiBase: '', quiz: null, current: 0, answers: {}, startedAt: 0 };

const element = (id) => document.getElementById(id);

function showView(name) {
  for (const view of views) element(`${view}-view`).classList.toggle('hidden', view !== name);
}

function setConnection(kind, label) {
  const status = element('connection-status');
  status.className = `status status-${kind}`;
  status.lastElementChild.textContent = label;
}

async function request(path, options = {}) {
  const response = await fetch(`${state.apiBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
  return response.json();
}

async function connect() {
  showView('loading');
  setConnection('loading', 'Connecting');
  try {
    const discoveryResponse = await fetch(`api.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    if (!discoveryResponse.ok) throw new Error('Could not load the backend address.');
    const discovery = await discoveryResponse.json();
    if (!discovery.online || !discovery.apiBase) throw new Error('The WSL backend is currently offline.');
    state.apiBase = discovery.apiBase.replace(/\/$/, '');
    await request('/health');
    state.quiz = await request('/api/quiz');
    element('quiz-title').textContent = state.quiz.title;
    element('quiz-description').textContent = state.quiz.description;
    setConnection('online', 'WSL online');
    showView('start');
  } catch (error) {
    setConnection('offline', 'Offline');
    element('offline-message').textContent = error.message || 'The backend could not be reached.';
    showView('offline');
  }
}

function startQuiz() {
  state.current = 0;
  state.answers = {};
  state.startedAt = Date.now();
  renderQuestion();
  showView('quiz');
}

function renderQuestion() {
  const question = state.quiz.questions[state.current];
  const total = state.quiz.questions.length;
  element('question-count').textContent = `Question ${state.current + 1} of ${total}`;
  element('score-preview').textContent = `${Object.keys(state.answers).length} answered`;
  element('progress-bar').style.width = `${(state.current / total) * 100}%`;
  element('question-category').textContent = question.category;
  element('question-text').textContent = question.prompt;
  element('next-button').textContent = state.current === total - 1 ? 'See my score' : 'Next question';
  element('next-button').disabled = state.answers[question.id] === undefined;

  const list = element('answer-list');
  list.replaceChildren(...question.options.map((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `answer${state.answers[question.id] === index ? ' selected' : ''}`;
    button.innerHTML = `<span class="answer-letter">${String.fromCharCode(65 + index)}</span><span></span>`;
    button.lastElementChild.textContent = option;
    button.addEventListener('click', () => {
      state.answers[question.id] = index;
      renderQuestion();
    });
    return button;
  }));
}

async function nextQuestion() {
  if (state.current < state.quiz.questions.length - 1) {
    state.current += 1;
    renderQuestion();
    return;
  }
  element('next-button').disabled = true;
  element('next-button').textContent = 'Scoring…';
  try {
    const result = await request('/api/attempts', {
      method: 'POST',
      body: JSON.stringify({
        name: element('player-name').value.trim() || 'Anonymous',
        answers: state.answers,
        elapsedSeconds: Math.max(1, Math.round((Date.now() - state.startedAt) / 1000))
      })
    });
    renderResults(result);
    showView('result');
  } catch (error) {
    element('next-button').disabled = false;
    element('next-button').textContent = 'Try scoring again';
    alert(error.message);
  }
}

function renderResults(result) {
  const percent = Math.round((result.score / result.total) * 100);
  element('score-value').textContent = `${result.score}/${result.total}`;
  element('score-ring').style.setProperty('--score-angle', `${percent * 3.6}deg`);
  element('result-heading').textContent = percent === 100 ? 'Flawless run.' : percent >= 60 ? 'Nicely done.' : 'Good first pass.';
  element('result-copy').textContent = `You scored ${percent}% in ${result.elapsedSeconds} seconds.`;

  element('review-list').replaceChildren(...result.review.map((item) => {
    const row = document.createElement('div');
    row.className = `review-item${item.correct ? ' correct' : ''}`;
    const title = document.createElement('strong');
    title.textContent = `${item.correct ? '✓' : '×'} ${item.prompt}`;
    const copy = document.createElement('p');
    copy.textContent = item.explanation;
    row.append(title, copy);
    return row;
  }));

  const board = element('leaderboard');
  board.replaceChildren(...result.leaderboard.map((entry) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    const score = document.createElement('strong');
    name.textContent = entry.name;
    score.textContent = `${entry.score}/${entry.total}`;
    row.append(name, score);
    return row;
  }));
}

element('retry-button').addEventListener('click', connect);
element('start-button').addEventListener('click', startQuiz);
element('next-button').addEventListener('click', nextQuestion);
element('again-button').addEventListener('click', () => showView('start'));
connect();

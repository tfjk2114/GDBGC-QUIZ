const state = { apiBase: '', token: localStorage.getItem('gdbgc-host-token') || '', game: null, timer: null };
const element = (id) => document.getElementById(id);

function setConnection(kind, label) {
  const status = element('connection-status');
  status.className = `status status-${kind}`;
  status.lastElementChild.textContent = label;
}

function showLogin(error = '') {
  element('login-view').classList.remove('hidden');
  element('panel-view').classList.add('hidden');
  element('logout-button').classList.add('hidden');
  element('login-error').textContent = error;
}

function showPanel() {
  element('login-view').classList.add('hidden');
  element('panel-view').classList.remove('hidden');
  element('logout-button').classList.remove('hidden');
}

function message(text, isError = false) {
  const box = element('host-message');
  box.textContent = text;
  box.className = `host-message${isError ? ' error' : ''}`;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => box.classList.add('hidden'), 3500);
}

async function request(path, options = {}) {
  const response = await fetch(`${state.apiBase}${path}`, {
    ...options,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(8000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Грешка от сървъра (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function connect() {
  clearInterval(state.timer);
  setConnection('loading', 'Свързване');
  try {
    const response = await fetch(`api.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    const discovery = await response.json();
    if (!discovery.online || !discovery.apiBase) throw new Error('WSL сървърът е офлайн.');
    state.apiBase = discovery.apiBase.replace(/\/$/, '');
    setConnection('online', 'Сървърът е онлайн');
    if (!state.token) return showLogin();
    await refresh(true);
    state.timer = setInterval(() => refresh(false), 1200);
  } catch (error) {
    setConnection('offline', 'Офлайн');
    showLogin(error.message);
  }
}

async function refresh(forceRender) {
  try {
    const game = await request('/api/host/state');
    const focused = document.activeElement?.matches('input, select, textarea');
    const changed = !state.game || state.game.version !== game.version;
    state.game = game;
    if (forceRender || (changed && !focused)) render();
    showPanel();
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem('gdbgc-host-token');
      state.token = '';
      showLogin('Ключът за водещия не е валиден.');
    } else {
      setConnection('offline', 'Връзката е прекъсната');
      message(error.message, true);
    }
  }
}

async function post(path, payload) {
  try {
    state.game = await request(path, { method: 'POST', body: JSON.stringify(payload) });
    render();
    message('Промяната е запазена и изпратена към екраните на играчите.');
    return true;
  } catch (error) {
    message(error.message, true);
    return false;
  }
}

function isPregame(phase) {
  return ['lobby', 'test_question', 'test_result'].includes(phase);
}

function render() {
  const game = state.game;
  const pregame = isPregame(game.phase);
  element('host-question-counter').classList.toggle('hidden', pregame);
  if (pregame) {
    element('host-kicker').textContent = `${game.playerCount} от 16 играчи са се присъединили`;
    element('host-title').textContent = 'Игрално фоайе';
  } else {
    element('host-kicker').textContent = `${game.category.name} · Въпроси ${game.category.start}–${game.category.end}`;
    element('host-title').textContent = game.phase === 'finished' ? 'Финално класиране' : game.category.name;
    element('host-question').textContent = game.questionNumber;
  }
  const phaseNames = {
    lobby: 'фоайе', test_question: 'тестов въпрос', test_result: 'тест завършен', category_start: 'нова категория',
    betting: 'залози', question: 'въпрос', results: 'резултати', finished: 'край'
  };
  element('phase-badge').textContent = phaseNames[game.phase] || game.phase;
  element('roster-count').textContent = `${game.playerCount}/16 заети места. Новите играчи се разпределят автоматично между отборите.`;
  renderRound(game);
  renderTeams(game);
  renderPoints(game);
}

function teamCard(team, content) {
  const card = document.createElement('div');
  card.className = 'round-team';
  const title = document.createElement('strong'); title.textContent = team.name;
  card.append(title, content);
  return card;
}

function renderRound(game) {
  const controls = element('round-controls');
  controls.replaceChildren();
  const titleByPhase = {
    lobby: 'Подготовка на играта', test_question: 'Проверка с един играч', test_result: 'Резултат от проверката',
    category_start: 'Избор на нови капитани', betting: 'Събиране на залозите', question: 'Оценяване на отговорите',
    results: 'Преглед на резултата', finished: 'Играта приключи'
  };
  element('round-title').textContent = titleByPhase[game.phase] || 'Управление на играта';

  if (game.phase === 'lobby') return renderLobby(game, controls);
  if (game.phase === 'test_question') return renderTestQuestion(game, controls);
  if (game.phase === 'test_result') return renderTestResult(game, controls);
  if (game.phase === 'category_start') {
    controls.innerHTML = '<p class="helper">Системата ще избере на случаен принцип по един от четиримата играчи във всеки отбор за капитан на следващите десет въпроса.</p>';
    controls.append(actionButton('Избери капитани и започни категорията', () => post('/api/host/category/start', {})));
    return;
  }

  const captainGrid = document.createElement('div');
  captainGrid.className = 'captain-grid';
  captainGrid.replaceChildren(...game.teams.map((team) => {
    const text = document.createElement('span');
    text.className = 'captain-name';
    text.textContent = team.captain?.name || 'Все още няма избор';
    return teamCard(team, text);
  }));
  controls.append(captainGrid);

  if (game.phase === 'betting') renderBetting(game, controls);
  if (game.phase === 'question') renderScoring(game, controls);
  if (game.phase === 'results') renderResults(game, controls);
  if (game.phase === 'finished') {
    const copy = document.createElement('p');
    copy.className = 'helper';
    copy.textContent = 'Всички 100 въпроса приключиха. При нужда използвайте ръчната корекция на точки.';
    controls.append(copy);
  }
}

function renderLobby(game, controls) {
  const copy = document.createElement('p');
  copy.className = 'helper';
  copy.textContent = 'Играчите трябва да въведат имената си от публичния екран. Преди истинската викторина пуснете задължителния тест с един случаен играч и един въпрос.';
  const status = document.createElement('div');
  status.className = 'lobby-status';
  status.innerHTML = `<strong>${game.playerCount}/16 играчи</strong><span>${game.testCompleted ? '✓ Тестът е завършен' : 'Тестът още не е проведен'}</span>`;
  const actions = document.createElement('div');
  actions.className = 'control-actions';
  const testButton = actionButton('Пусни тест с един играч', () => post('/api/host/test/start', {}));
  testButton.disabled = game.playerCount < 1;
  actions.append(testButton);
  if (game.testCompleted) {
    const startButton = actionButton('Започни истинската викторина', () => post('/api/host/game/start', {}));
    startButton.disabled = game.playerCount !== 16;
    actions.append(startButton);
  }
  controls.append(copy, status, actions);
}

function testPreview(test) {
  const box = document.createElement('div');
  box.className = 'question-preview';
  const label = document.createElement('span'); label.className = 'eyebrow'; label.textContent = `Тест за ${test.playerName} · ${test.teamName}`;
  const prompt = document.createElement('p'); prompt.textContent = test.prompt;
  box.append(label, prompt);
  return box;
}

function renderTestQuestion(game, controls) {
  const copy = document.createElement('p');
  copy.className = 'helper';
  copy.textContent = 'Само избраният играч отговаря. Този тест не променя точките.';
  const actions = document.createElement('div'); actions.className = 'control-actions';
  actions.append(
    actionButton('Верен отговор', () => post('/api/host/test/score', { correct: true })),
    actionButton('Грешен отговор', () => post('/api/host/test/score', { correct: false }), 'button-danger')
  );
  controls.append(copy, testPreview(game.test), actions);
}

function renderTestResult(game, controls) {
  const result = document.createElement('p');
  result.className = game.test.result ? 'test-success' : 'test-failure';
  result.textContent = game.test.result ? '✓ Тестовият отговор е отбелязан като верен.' : '× Тестовият отговор е отбелязан като грешен.';
  const actions = document.createElement('div'); actions.className = 'control-actions';
  actions.append(
    actionButton('Проведи теста отново', () => post('/api/host/test/start', {})),
    actionButton('Върни се във фоайето', () => post('/api/host/test/reset', {}), 'button-secondary')
  );
  const startButton = actionButton('Започни истинската викторина', () => post('/api/host/game/start', {}));
  startButton.disabled = game.playerCount !== 16;
  actions.append(startButton);
  controls.append(testPreview(game.test), result, actions);
}

function renderBetting(game, controls) {
  const help = document.createElement('p'); help.className = 'helper';
  help.textContent = 'Въведете по едно неизползвано цяло число от 1 до 100 за всеки отбор. Залозите се изразходват при показване на въпроса.';
  const grid = document.createElement('div'); grid.className = 'wager-grid';
  for (const team of game.teams) {
    const wrapper = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.required = true; input.dataset.betTeam = team.id; input.placeholder = '1–100';
    const used = document.createElement('div'); used.className = 'used-wagers';
    used.textContent = team.usedWagers.length ? `Използвани: ${team.usedWagers.join(', ')}` : 'Все още няма използвани залози';
    wrapper.append(input, used); grid.append(teamCard(team, wrapper));
  }
  const reveal = actionButton('Заключи залозите и покажи въпроса', async () => {
    const bets = {};
    document.querySelectorAll('[data-bet-team]').forEach((input) => { bets[input.dataset.betTeam] = Number(input.value); });
    await post('/api/host/question/reveal', { bets });
  });
  controls.append(help, grid, reveal);
}

function questionPreview(game) {
  const box = document.createElement('div'); box.className = 'question-preview';
  const label = document.createElement('span'); label.className = 'eyebrow'; label.textContent = `Въпрос ${game.question.number}`;
  const prompt = document.createElement('p'); prompt.textContent = game.question.prompt;
  box.append(label, prompt); return box;
}

function renderScoring(game, controls) {
  controls.append(questionPreview(game));
  const help = document.createElement('p'); help.className = 'helper';
  help.textContent = 'Изберете резултат за всеки отбор. Верният отговор печели заключения залог, а грешният носи нула точки.';
  const grid = document.createElement('div'); grid.className = 'result-grid';
  for (const team of game.teams) {
    const select = document.createElement('select'); select.dataset.resultTeam = team.id;
    select.innerHTML = '<option value="">Изберете резултат…</option><option value="true">Верен</option><option value="false">Грешен</option>';
    const wrap = document.createElement('div');
    const bet = document.createElement('small'); bet.textContent = `Залог: ${team.bet}`;
    wrap.append(bet, select); grid.append(teamCard(team, wrap));
  }
  const score = actionButton('Оцени въпроса', async () => {
    const results = {};
    document.querySelectorAll('[data-result-team]').forEach((select) => { if (select.value !== '') results[select.dataset.resultTeam] = select.value === 'true'; });
    await post('/api/host/question/score', { results });
  });
  controls.append(help, grid, score);
}

function renderResults(game, controls) {
  controls.append(questionPreview(game));
  const grid = document.createElement('div'); grid.className = 'result-grid';
  for (const team of game.teams) {
    const text = document.createElement('span'); text.className = team.correct ? 'result-correct' : 'result-wrong';
    text.textContent = team.correct ? `Верен · +${team.bet}` : 'Грешен · +0';
    grid.append(teamCard(team, text));
  }
  const nextLabel = game.questionNumber % 10 === 0 ? 'Завърши категорията и избери нови капитани' : 'Премини към следващия въпрос';
  controls.append(grid, actionButton(nextLabel, () => post('/api/host/question/next', {})));
}

function actionButton(label, handler, extraClass = '') {
  const button = document.createElement('button');
  button.className = `button button-primary ${extraClass}`.trim();
  button.type = 'button'; button.textContent = label;
  button.addEventListener('click', async () => { button.disabled = true; try { await handler(); } finally { button.disabled = false; } });
  return button;
}

function renderTeams(game) {
  const cards = game.teams.map((team, teamIndex) => {
    const card = document.createElement('div'); card.className = 'team-edit-card';
    const teamName = document.createElement('input');
    teamName.value = team.name; teamName.dataset.teamName = teamIndex; teamName.setAttribute('aria-label', `Име на отбор ${teamIndex + 1}`);
    const players = document.createElement('div'); players.className = 'player-fields';
    for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
      const input = document.createElement('input');
      input.value = team.players[playerIndex] || '';
      input.placeholder = `Свободно място ${playerIndex + 1}`;
      input.dataset.teamPlayer = `${teamIndex}:${playerIndex}`;
      input.setAttribute('aria-label', `${team.name}, играч ${playerIndex + 1}`);
      players.append(input);
    }
    card.append(teamName, players); return card;
  });
  element('team-editor').replaceChildren(...cards);
}

function renderPoints(game) {
  element('points-editor').replaceChildren(...game.teams.map((team) => {
    const row = document.createElement('div'); row.className = 'point-row';
    const name = document.createElement('span'); name.textContent = team.name;
    const input = document.createElement('input'); input.type = 'number'; input.value = team.points;
    const button = document.createElement('button'); button.className = 'button button-primary'; button.textContent = 'Задай';
    button.addEventListener('click', () => post('/api/host/points', { teamId: team.id, points: Number(input.value) }));
    row.append(name, input, button); return row;
  }));
}

element('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.token = element('host-token').value.trim();
  localStorage.setItem('gdbgc-host-token', state.token);
  await refresh(true);
  if (state.token) state.timer = setInterval(() => refresh(false), 1200);
});

element('logout-button').addEventListener('click', () => {
  clearInterval(state.timer);
  localStorage.removeItem('gdbgc-host-token');
  state.token = '';
  element('host-token').value = '';
  showLogin();
});

element('save-teams').addEventListener('click', async () => {
  const teams = state.game.teams.map((team, teamIndex) => ({
    name: document.querySelector(`[data-team-name="${teamIndex}"]`).value,
    players: [0, 1, 2, 3].map((playerIndex) => document.querySelector(`[data-team-player="${teamIndex}:${playerIndex}"]`).value)
  }));
  await post('/api/host/teams', { teams });
});

element('reset-button').addEventListener('click', async () => {
  if (!confirm('Да бъдат ли изтрити всички играчи, точки, залози, капитани и прогрес?')) return;
  await post('/api/host/reset', { confirmation: 'RESET' });
});

connect();

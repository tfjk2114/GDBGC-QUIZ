const state = { apiBase: '', token: localStorage.getItem('gdbgc-host-token') || '', game: null, timer: null, questionFilter: 'all' };
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
    const error = new Error(body.error || `Server error (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function connect() {
  clearInterval(state.timer);
  setConnection('loading', 'Connecting');
  try {
    const response = await fetch(`api.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    const discovery = await response.json();
    if (!discovery.online || !discovery.apiBase) throw new Error('The WSL backend is offline.');
    state.apiBase = discovery.apiBase.replace(/\/$/, '');
    setConnection('online', 'Backend online');
    if (!state.token) return showLogin();
    await refresh(true);
    state.timer = setInterval(() => refresh(false), 1200);
  } catch (error) {
    setConnection('offline', 'Offline');
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
      showLogin('That host access key is not valid.');
    } else {
      setConnection('offline', 'Connection lost');
      message(error.message, true);
    }
  }
}

async function post(path, payload) {
  try {
    state.game = await request(path, { method: 'POST', body: JSON.stringify(payload) });
    render();
    message('Saved and broadcast to the player screens.');
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
    element('host-kicker').textContent = `${game.playerCount} of 16 players joined`;
    element('host-title').textContent = 'Game lobby';
  } else {
    element('host-kicker').textContent = `${game.category.name} · Questions ${game.category.start}–${game.category.end}`;
    element('host-title').textContent = game.phase === 'finished' ? 'Final standings' : game.category.name;
    element('host-question').textContent = game.questionNumber;
  }
  const phaseNames = {
    lobby: 'lobby', test_question: 'test question', test_result: 'test complete', category_start: 'new category',
    betting: 'wagers', question: 'question', results: 'results', finished: 'finished'
  };
  element('phase-badge').textContent = phaseNames[game.phase] || game.phase;
  element('roster-count').textContent = `${game.playerCount}/16 seats filled. New players are distributed automatically across the teams.`;
  renderRound(game);
  renderTeams(game);
  renderPoints(game);
  renderQuestionBank(game);
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
    lobby: 'Prepare the game', test_question: 'One-player system test', test_result: 'System test result',
    category_start: 'Draw new captains', betting: 'Captain wagers', question: 'Judge the answers',
    results: 'Review the result', finished: 'Game complete'
  };
  element('round-title').textContent = titleByPhase[game.phase] || 'Game control';

  if (game.phase === 'lobby') return renderLobby(game, controls);
  if (game.phase === 'test_question') return renderTestQuestion(game, controls);
  if (game.phase === 'test_result') return renderTestResult(game, controls);
  if (game.phase === 'category_start') {
    controls.innerHTML = '<p class="helper">The system randomly selects one of the four players on every team as captain for the next ten questions.</p>';
    controls.append(actionButton('Draw captains and start category', () => post('/api/host/category/start', {})));
    return;
  }

  const captainGrid = document.createElement('div');
  captainGrid.className = 'captain-grid';
  captainGrid.replaceChildren(...game.teams.map((team) => {
    const text = document.createElement('span');
    text.className = 'captain-name';
    text.textContent = team.captain?.name || 'Not selected yet';
    return teamCard(team, text);
  }));
  controls.append(captainGrid);

  if (game.phase === 'betting') renderBetting(game, controls);
  if (game.phase === 'question') renderScoring(game, controls);
  if (game.phase === 'results') renderResults(game, controls);
  if (game.phase === 'finished') {
    const copy = document.createElement('p');
    copy.className = 'helper';
    copy.textContent = 'All 100 questions are complete. Use the manual score controls for any final adjustments.';
    controls.append(copy);
  }
}

function renderLobby(game, controls) {
  const copy = document.createElement('p');
  copy.className = 'helper';
  copy.textContent = 'Players join from the public screen. Before the real quiz, run the required one-player, one-question system test.';
  const status = document.createElement('div');
  status.className = 'lobby-status';
  status.innerHTML = `<strong>${game.playerCount}/16 players</strong><span>${game.testCompleted ? '✓ System test completed' : 'System test not run yet'}</span>`;
  const actions = document.createElement('div');
  actions.className = 'control-actions';
  const testButton = actionButton('Run one-player system test', () => post('/api/host/test/start', {}));
  testButton.disabled = game.playerCount < 1;
  actions.append(testButton);
  if (game.testCompleted) {
    const startButton = actionButton('Start the real quiz', () => post('/api/host/game/start', {}));
    startButton.disabled = game.playerCount !== 16;
    actions.append(startButton);
  }
  controls.append(copy, status, actions);
}

function testPreview(test) {
  const box = document.createElement('div');
  box.className = 'question-preview';
  const label = document.createElement('span'); label.className = 'eyebrow'; label.textContent = `Test for ${test.playerName} · ${test.teamName}`;
  const prompt = document.createElement('p'); prompt.textContent = test.prompt;
  box.append(label, prompt);
  return box;
}

function renderTestQuestion(game, controls) {
  const copy = document.createElement('p');
  copy.className = 'helper';
  copy.textContent = 'Only the selected player answers. This test does not affect scores.';
  const actions = document.createElement('div'); actions.className = 'control-actions';
  actions.append(
    actionButton('Correct answer', () => post('/api/host/test/score', { correct: true })),
    actionButton('Incorrect answer', () => post('/api/host/test/score', { correct: false }), 'button-danger')
  );
  controls.append(copy, testPreview(game.test), actions);
}

function renderTestResult(game, controls) {
  const result = document.createElement('p');
  result.className = game.test.result ? 'test-success' : 'test-failure';
  result.textContent = game.test.result ? '✓ The test answer was marked correct.' : '× The test answer was marked incorrect.';
  const actions = document.createElement('div'); actions.className = 'control-actions';
  actions.append(
    actionButton('Run the test again', () => post('/api/host/test/start', {})),
    actionButton('Return to lobby', () => post('/api/host/test/reset', {}), 'button-secondary')
  );
  const startButton = actionButton('Start the real quiz', () => post('/api/host/game/start', {}));
  startButton.disabled = game.playerCount !== 16;
  actions.append(startButton);
  controls.append(testPreview(game.test), result, actions);
}

function renderBetting(game, controls) {
  const help = document.createElement('p'); help.className = 'helper';
  help.textContent = 'Each captain chooses an unused number from their private panel. Reveal the question after all four wagers arrive.';
  const grid = document.createElement('div'); grid.className = 'wager-grid';
  for (const team of game.teams) {
    const wrapper = document.createElement('div');
    const submission = document.createElement('strong');
    const pending = game.pendingBets[team.id];
    submission.className = pending ? 'wager-submitted' : 'wager-waiting';
    submission.textContent = pending ? `Submitted: ${pending}` : 'Waiting for captain…';
    const used = document.createElement('div'); used.className = 'used-wagers';
    used.textContent = team.usedWagers.length ? `Used: ${team.usedWagers.join(', ')}` : 'No wagers used yet';
    wrapper.append(submission, used); grid.append(teamCard(team, wrapper));
  }
  const reveal = actionButton('Lock captain wagers and reveal question', () => post('/api/host/question/reveal', {}));
  reveal.disabled = Object.keys(game.pendingBets).length !== 4;
  controls.append(help, grid, reveal);
}

function questionPreview(game) {
  const box = document.createElement('div'); box.className = 'question-preview';
  const label = document.createElement('span'); label.className = 'eyebrow'; label.textContent = `Question ${game.question.number}`;
  const prompt = document.createElement('p'); prompt.textContent = game.question.prompt;
  box.append(label, prompt);
  const answer = document.createElement('div'); answer.className = 'question-answer';
  const answerLabel = document.createElement('span'); answerLabel.textContent = 'Answer';
  const answerText = document.createElement('strong'); answerText.textContent = game.question.answer || 'Not provided yet';
  answer.append(answerLabel, answerText); box.append(answer); return box;
}

function renderQuestionBank(game) {
  const filter = element('question-category-filter');
  if (filter.options.length === 1) {
    game.categories.forEach((category, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${category.name} · ${category.start}–${category.end}`;
      filter.append(option);
    });
  }
  filter.value = state.questionFilter;
  const questions = (game.questionBank || []).filter((question) => state.questionFilter === 'all' || question.categoryIndex === Number(state.questionFilter));
  element('question-bank-count').textContent = String(questions.length);
  element('question-bank-list').replaceChildren(...questions.map((question) => {
    const item = document.createElement('article');
    const isCurrent = !isPregame(game.phase) && question.number === game.questionNumber;
    const isComplete = question.number < game.questionNumber && !isPregame(game.phase);
    item.className = `question-bank-item${isCurrent ? ' current' : ''}${isComplete ? ' complete' : ''}`;
    const number = document.createElement('span'); number.className = 'question-bank-number'; number.textContent = String(question.number);
    const copy = document.createElement('div');
    const category = game.categories[question.categoryIndex];
    const meta = document.createElement('small'); meta.textContent = category?.name || `Category ${question.categoryIndex + 1}`;
    const prompt = document.createElement('p'); prompt.textContent = question.prompt;
    const answer = document.createElement('strong'); answer.className = 'bank-answer'; answer.textContent = question.answer || 'Not provided yet';
    copy.append(meta, prompt, answer); item.append(number, copy); return item;
  }));
}

function renderScoring(game, controls) {
  controls.append(questionPreview(game));
  const help = document.createElement('p'); help.className = 'helper';
  help.textContent = 'Choose a verdict for every team. A correct answer earns the locked wager; an incorrect answer earns zero.';
  const grid = document.createElement('div'); grid.className = 'result-grid';
  for (const team of game.teams) {
    const select = document.createElement('select'); select.dataset.resultTeam = team.id;
    select.innerHTML = '<option value="">Choose verdict…</option><option value="true">Correct</option><option value="false">Incorrect</option>';
    const wrap = document.createElement('div');
    const bet = document.createElement('small'); bet.textContent = `Wager: ${team.bet}`;
    wrap.append(bet, select); grid.append(teamCard(team, wrap));
  }
  const score = actionButton('Score question', async () => {
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
    text.textContent = team.correct ? `Correct · +${team.bet}` : 'Incorrect · +0';
    grid.append(teamCard(team, text));
  }
  const nextLabel = game.questionNumber % 10 === 0 ? 'Finish category and draw new captains' : 'Move to next question';
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
    teamName.value = team.name; teamName.dataset.teamName = teamIndex; teamName.setAttribute('aria-label', `Team ${teamIndex + 1} name`);
    const players = document.createElement('div'); players.className = 'player-fields';
    for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
      const input = document.createElement('input');
      input.value = team.players[playerIndex] || '';
      input.placeholder = `Open seat ${playerIndex + 1}`;
      input.dataset.teamPlayer = `${teamIndex}:${playerIndex}`;
      input.setAttribute('aria-label', `${team.name}, player ${playerIndex + 1}`);
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
    const button = document.createElement('button'); button.className = 'button button-primary'; button.textContent = 'Set';
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
  if (!confirm('Reset all players, scores, wagers, captains, and progress?')) return;
  await post('/api/host/reset', { confirmation: 'RESET' });
});

element('question-category-filter').addEventListener('change', (event) => {
  state.questionFilter = event.target.value;
  if (state.game) renderQuestionBank(state.game);
});

connect();

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
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(8000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
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
    message('Saved and broadcast to the player screen.');
  } catch (error) {
    message(error.message, true);
    throw error;
  }
}

function render() {
  const game = state.game;
  element('host-kicker').textContent = `${game.category.name} · Questions ${game.category.start}–${game.category.end}`;
  element('host-title').textContent = game.phase === 'finished' ? 'Final standings' : game.category.name;
  element('host-question').textContent = game.questionNumber;
  element('phase-badge').textContent = game.phase.replace('_', ' ');
  renderRound(game);
  renderTeams(game);
  renderPoints(game);
}

function teamCard(team, content) {
  const card = document.createElement('div');
  card.className = 'round-team';
  const title = document.createElement('strong');
  title.textContent = team.name;
  card.append(title, content);
  return card;
}

function renderRound(game) {
  const controls = element('round-controls');
  controls.replaceChildren();
  const titleByPhase = {
    category_start: 'Draw new captains', betting: 'Collect team wagers', question: 'Judge the answers', results: 'Review the result', finished: 'Game complete'
  };
  element('round-title').textContent = titleByPhase[game.phase] || 'Game control';

  if (game.phase === 'category_start') {
    controls.innerHTML = '<p class="helper">This randomly selects one of the four players on every team as captain for the next ten questions.</p>';
    controls.append(actionButton('Randomize captains and start category', () => post('/api/host/category/start', {})));
    return;
  }

  const captainGrid = document.createElement('div');
  captainGrid.className = 'captain-grid';
  captainGrid.replaceChildren(...game.teams.map((team) => {
    const text = document.createElement('span');
    text.className = 'captain-name';
    text.textContent = team.captain?.name || 'Not selected';
    return teamCard(team, text);
  }));
  controls.append(captainGrid);

  if (game.phase === 'betting') renderBetting(game, controls);
  if (game.phase === 'question') renderScoring(game, controls);
  if (game.phase === 'results') renderResults(game, controls);
  if (game.phase === 'finished') {
    const copy = document.createElement('p');
    copy.className = 'helper';
    copy.textContent = 'All 100 questions are complete. Use the points editor for any final adjustments.';
    controls.append(copy);
  }
}

function renderBetting(game, controls) {
  const help = document.createElement('p');
  help.className = 'helper';
  help.textContent = 'Enter one unused whole number from 1 to 100 for every team. Wagers are consumed as soon as the question is revealed.';
  const grid = document.createElement('div');
  grid.className = 'wager-grid';
  for (const team of game.teams) {
    const wrapper = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.max = '100'; input.required = true; input.dataset.betTeam = team.id;
    input.placeholder = '1–100';
    const used = document.createElement('div');
    used.className = 'used-wagers';
    used.textContent = team.usedWagers.length ? `Used: ${team.usedWagers.join(', ')}` : 'No wagers used yet';
    wrapper.append(input, used);
    grid.append(teamCard(team, wrapper));
  }
  const reveal = actionButton('Lock all wagers and reveal question', async () => {
    const bets = {};
    document.querySelectorAll('[data-bet-team]').forEach((input) => { bets[input.dataset.betTeam] = Number(input.value); });
    await post('/api/host/question/reveal', { bets });
  });
  controls.append(help, grid, reveal);
}

function questionPreview(game) {
  const box = document.createElement('div');
  box.className = 'question-preview';
  const label = document.createElement('span');
  label.className = 'eyebrow';
  label.textContent = `Question ${game.question.number}`;
  const prompt = document.createElement('p');
  prompt.textContent = game.question.prompt;
  box.append(label, prompt);
  return box;
}

function renderScoring(game, controls) {
  controls.append(questionPreview(game));
  const help = document.createElement('p');
  help.className = 'helper';
  help.textContent = 'Choose a verdict for every team. Correct answers gain the locked wager; incorrect answers gain zero.';
  const grid = document.createElement('div');
  grid.className = 'result-grid';
  for (const team of game.teams) {
    const select = document.createElement('select');
    select.dataset.resultTeam = team.id;
    select.innerHTML = '<option value="">Choose verdict…</option><option value="true">Correct</option><option value="false">Incorrect</option>';
    const wrap = document.createElement('div');
    const bet = document.createElement('small');
    bet.textContent = `Wager: ${team.bet}`;
    wrap.append(bet, select);
    grid.append(teamCard(team, wrap));
  }
  const score = actionButton('Score question', async () => {
    const results = {};
    document.querySelectorAll('[data-result-team]').forEach((select) => {
      if (select.value !== '') results[select.dataset.resultTeam] = select.value === 'true';
    });
    await post('/api/host/question/score', { results });
  });
  controls.append(help, grid, score);
}

function renderResults(game, controls) {
  controls.append(questionPreview(game));
  const grid = document.createElement('div');
  grid.className = 'result-grid';
  for (const team of game.teams) {
    const text = document.createElement('span');
    text.className = team.correct ? 'result-correct' : 'result-wrong';
    text.textContent = team.correct ? `Correct · +${team.bet}` : 'Incorrect · +0';
    grid.append(teamCard(team, text));
  }
  const nextLabel = game.questionNumber % 10 === 0 ? 'Finish category and draw new captains' : 'Move to next question';
  controls.append(grid, actionButton(nextLabel, () => post('/api/host/question/next', {})));
}

function actionButton(label, handler) {
  const button = document.createElement('button');
  button.className = 'button button-primary';
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await handler(); } finally { button.disabled = false; }
  });
  return button;
}

function renderTeams(game) {
  const cards = game.teams.map((team, teamIndex) => {
    const card = document.createElement('div');
    card.className = 'team-edit-card';
    const teamName = document.createElement('input');
    teamName.value = team.name;
    teamName.dataset.teamName = teamIndex;
    teamName.setAttribute('aria-label', `Team ${teamIndex + 1} name`);
    const players = document.createElement('div');
    players.className = 'player-fields';
    for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
      const input = document.createElement('input');
      input.value = team.players[playerIndex];
      input.dataset.teamPlayer = `${teamIndex}:${playerIndex}`;
      input.setAttribute('aria-label', `${team.name} player ${playerIndex + 1}`);
      players.append(input);
    }
    card.append(teamName, players);
    return card;
  });
  element('team-editor').replaceChildren(...cards);
}

function renderPoints(game) {
  element('points-editor').replaceChildren(...game.teams.map((team) => {
    const row = document.createElement('div');
    row.className = 'point-row';
    const name = document.createElement('span'); name.textContent = team.name;
    const input = document.createElement('input'); input.type = 'number'; input.value = team.points;
    const button = document.createElement('button'); button.className = 'button button-primary'; button.textContent = 'Set';
    button.addEventListener('click', () => post('/api/host/points', { teamId: team.id, points: Number(input.value) }));
    row.append(name, input, button);
    return row;
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
  if (!confirm('Reset all quiz progress, scores, wagers, and captains? Team names will be kept.')) return;
  await post('/api/host/reset', { confirmation: 'RESET' });
});

connect();

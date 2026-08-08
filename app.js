const state = {
  apiBase: '',
  token: localStorage.getItem('gdbgc-player-token') || '',
  player: null,
  game: null,
  timer: null
};
const element = (id) => document.getElementById(id);

function setView(name) {
  for (const view of ['loading', 'offline', 'join', 'game']) {
    element(`${view}-view`).classList.toggle('hidden', view !== name);
  }
  element('leaderboard-dock').classList.toggle('hidden', name !== 'game');
}

function setConnection(kind, label) {
  const status = element('connection-status');
  status.className = `status status-${kind}`;
  status.lastElementChild.textContent = label;
}

async function request(path, options = {}, playerAuth = false) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (playerAuth && state.token) headers.Authorization = `Player ${state.token}`;
  const response = await fetch(`${state.apiBase}${path}`, {
    ...options,
    cache: 'no-store',
    headers,
    signal: AbortSignal.timeout(7000)
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
  setView('loading');
  setConnection('loading', 'Свързване');
  try {
    const response = await fetch(`api.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    const discovery = await response.json();
    if (!discovery.online || !discovery.apiBase) throw new Error('Водещият още не е отворил игралната зала.');
    state.apiBase = discovery.apiBase.replace(/\/$/, '');
    state.game = await request('/api/game');
    if (state.token) {
      try {
        state.player = await request('/api/player/status', {}, true);
      } catch (error) {
        if (error.status !== 401) throw error;
        clearPlayer();
      }
    }
    setConnection('online', 'На живо');
    if (state.player) enterWaitingRoom();
    else showJoin();
  } catch (error) {
    goOffline(error);
  }
}

function showJoin() {
  element('join-count').textContent = `${state.game.playerCount} от 16 места са заети`;
  setView('join');
}

function enterWaitingRoom() {
  element('player-label').textContent = `${state.player.name} · ${state.player.teamName}`;
  element('player-identity').classList.remove('hidden');
  renderGame();
  setView('game');
  clearInterval(state.timer);
  state.timer = setInterval(refresh, 1200);
}

async function refresh() {
  try {
    const game = await request('/api/game');
    if (!state.game || game.version !== state.game.version) {
      state.game = game;
      renderGame();
    }
    setConnection('online', 'На живо');
  } catch (error) {
    goOffline(error);
  }
}

function goOffline(error) {
  clearInterval(state.timer);
  setConnection('offline', 'Офлайн');
  element('offline-message').textContent = error.message || 'Сървърът на водещия не отговаря.';
  setView('offline');
}

function clearPlayer() {
  localStorage.removeItem('gdbgc-player-token');
  state.token = '';
  state.player = null;
  element('player-identity').classList.add('hidden');
}

function isPregame(phase) {
  return ['lobby', 'test_question', 'test_result'].includes(phase);
}

function renderGame() {
  const game = state.game;
  const pregame = isPregame(game.phase);
  element('question-counter').classList.toggle('hidden', pregame);
  element('game-progress-track').classList.toggle('hidden', pregame);
  element('category-strip').classList.toggle('hidden', pregame);
  if (pregame) {
    element('category-kicker').textContent = `${game.playerCount} от 16 играчи са готови`;
    element('category-name').textContent = 'Игрално фоайе';
  } else {
    element('category-kicker').textContent = `${game.category.name} · Въпроси ${game.category.start}–${game.category.end}`;
    element('category-name').textContent = game.category.name;
    element('question-number').textContent = game.questionNumber;
    element('game-progress').style.width = `${Math.min(100, game.questionNumber)}%`;
  }
  renderStage(game);
  renderTeams(game);
  renderLeaderboard(game.teams);
  if (!pregame) renderCategories(game);
}

function renderStage(game) {
  const questionBox = element('question-box');
  const test = game.test;
  const visibleQuestion = game.question || (game.phase === 'test_question' || game.phase === 'test_result' ? { number: 'Тест', prompt: test?.prompt } : null);
  questionBox.classList.toggle('hidden', !visibleQuestion);
  if (visibleQuestion) {
    element('question-label').textContent = visibleQuestion.number === 'Тест' ? 'Тестов въпрос' : `Въпрос ${visibleQuestion.number}`;
    element('question-text').textContent = visibleQuestion.prompt;
  }

  const copy = {
    lobby: ['Изчакване', 'Добре дошъл в играта.', `Изчакай водещия. В залата са ${game.playerCount} от 16 играчи.`],
    test_question: ['Проверка на системата', `${test?.playerName}, това е твоят тестов въпрос.`, `Водещият ще отбележи отговора. Тестът не носи точки.`],
    test_result: ['Проверката приключи', test?.result ? 'Тестът е успешен.' : 'Тестът е отчетен като грешен.', 'Изчакайте водещия да стартира истинската викторина.'],
    category_start: ['Нова категория', 'Избираме капитани.', 'Водещият ще избере на случаен принцип капитан за всеки отбор.'],
    betting: ['Време за залог', 'Капитани, изберете число.', 'Всеки отбор трябва да заключи неизползван залог от 1 до 100 преди въпросът да се покаже.'],
    question: ['Въпросът е открит', 'Отбори, заключете отговора си.', 'Водещият ще отбележи кои отбори са отговорили правилно.'],
    results: ['Точките са обновени', 'Резултатът е ясен.', 'Верните отбори получават залога си. Грешните не получават точки.'],
    finished: ['Край на играта', 'Това беше последният въпрос.', 'Класирането показва финалните резултати.']
  }[game.phase] || ['Статус', 'Изчакваме водещия.', ''];
  element('stage-kicker').textContent = copy[0];
  element('stage-title').textContent = copy[1];
  element('stage-copy').textContent = copy[2];
}

function renderTeams(game) {
  const cards = game.teams.map((team, index) => {
    const card = document.createElement('article');
    card.className = `card team-card team-${index + 1}`;
    const top = document.createElement('div');
    top.className = 'team-card-top';
    const title = document.createElement('h3'); title.textContent = team.name;
    const points = document.createElement('strong'); points.className = 'team-points'; points.textContent = `${team.points} т.`;
    top.append(title, points);

    const captain = document.createElement('p');
    captain.className = 'captain';
    captain.textContent = team.captain ? `Капитан: ${team.captain.name}` : 'Капитан: очаква избор';

    const players = document.createElement('div');
    players.className = 'player-chips';
    for (const [playerIndex, player] of team.players.entries()) {
      const chip = document.createElement('span');
      chip.textContent = player || 'Свободно място';
      if (!player) chip.classList.add('empty-seat');
      if (team.captain?.playerIndex === playerIndex) chip.classList.add('is-captain');
      if (state.player?.teamId === team.id && state.player?.playerIndex === playerIndex) chip.classList.add('is-me');
      players.append(chip);
    }

    const footer = document.createElement('div');
    footer.className = 'team-round';
    const used = document.createElement('span'); used.textContent = `${team.usedWagerCount}/100 използвани залога`;
    footer.append(used);
    if (team.bet !== undefined) {
      const bet = document.createElement('strong'); bet.textContent = `Залог ${team.bet}`;
      if (game.phase === 'results') {
        bet.className = team.correct ? 'result-correct' : 'result-wrong';
        bet.textContent = team.correct ? `+${team.bet}` : '+0';
      }
      footer.append(bet);
    }
    card.append(top, captain, players, footer);
    return card;
  });
  element('team-grid').replaceChildren(...cards);
}

function renderLeaderboard(teams) {
  const sorted = [...teams].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'bg'));
  element('leaderboard-list').replaceChildren(...sorted.map((team) => {
    const row = document.createElement('li');
    const name = document.createElement('span'); name.textContent = team.name;
    const points = document.createElement('strong'); points.textContent = team.points;
    row.append(name, points);
    return row;
  }));
}

function renderCategories(game) {
  element('category-strip').replaceChildren(...game.categories.map((category, index) => {
    const item = document.createElement('span');
    item.className = index < game.categoryIndex ? 'complete' : index === game.categoryIndex ? 'active' : '';
    item.textContent = index + 1;
    item.title = category.name;
    return item;
  }));
}

element('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = element('join-button');
  button.disabled = true;
  element('join-error').textContent = '';
  try {
    const joined = await request('/api/players/join', { method: 'POST', body: JSON.stringify({ name: element('join-name').value.trim() }) });
    state.token = joined.token;
    state.player = joined.player;
    state.game = joined.game;
    localStorage.setItem('gdbgc-player-token', state.token);
    enterWaitingRoom();
  } catch (error) {
    element('join-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

element('leave-button').addEventListener('click', async () => {
  if (!confirm('Сигурни ли сте, че искате да освободите мястото си?')) return;
  try {
    const response = await request('/api/players/leave', { method: 'POST', body: '{}' }, true);
    state.game = response.game;
    clearPlayer();
    clearInterval(state.timer);
    showJoin();
  } catch (error) {
    alert(error.message);
  }
});

element('retry-button').addEventListener('click', connect);
connect();

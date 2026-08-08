const state = { apiBase: '', game: null, timer: null };
const element = (id) => document.getElementById(id);

function setView(name) {
  element('loading-view').classList.toggle('hidden', name !== 'loading');
  element('offline-view').classList.toggle('hidden', name !== 'offline');
  element('game-view').classList.toggle('hidden', name !== 'game');
}

function setConnection(kind, label) {
  const status = element('connection-status');
  status.className = `status status-${kind}`;
  status.lastElementChild.textContent = label;
}

async function api(path) {
  const response = await fetch(`${state.apiBase}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`Game server returned ${response.status}`);
  return response.json();
}

async function connect() {
  clearInterval(state.timer);
  setView('loading');
  setConnection('loading', 'Connecting');
  try {
    const response = await fetch(`api.json?ts=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    const discovery = await response.json();
    if (!discovery.online || !discovery.apiBase) throw new Error('The host has not opened the game room yet.');
    state.apiBase = discovery.apiBase.replace(/\/$/, '');
    await refresh();
    state.timer = setInterval(refresh, 1200);
  } catch (error) {
    goOffline(error);
  }
}

async function refresh() {
  try {
    const game = await api('/api/game');
    if (!state.game || game.version !== state.game.version) {
      state.game = game;
      renderGame();
    }
    setConnection('online', 'Live');
    setView('game');
  } catch (error) {
    goOffline(error);
  }
}

function goOffline(error) {
  clearInterval(state.timer);
  setConnection('offline', 'Offline');
  element('offline-message').textContent = error.message || 'The host backend cannot be reached.';
  setView('offline');
}

function renderGame() {
  const game = state.game;
  const category = game.category;
  element('category-kicker').textContent = `${category.name} · Questions ${category.start}–${category.end}`;
  element('category-name').textContent = category.name;
  element('question-number').textContent = game.questionNumber;
  element('game-progress').style.width = `${Math.min(100, game.questionNumber)}%`;
  renderStage(game);
  renderTeams(game);
  renderLeaderboard(game.teams);
  renderCategories(game);
}

function renderStage(game) {
  const questionBox = element('question-box');
  questionBox.classList.toggle('hidden', !game.question);
  if (game.question) {
    element('question-label').textContent = `Question ${game.question.number}`;
    element('question-text').textContent = game.question.prompt;
  }

  const copy = {
    category_start: ['New category', 'Captains incoming.', 'The host will randomly choose one captain for every team before the category begins.'],
    betting: ['Wager phase', 'Captains, choose your number.', 'Each team must lock one unused wager from 1 to 100 before the question is revealed.'],
    question: ['Question revealed', 'Teams, lock in your answer.', 'The host will decide which teams answered correctly.'],
    results: ['Scores updated', 'The verdict is in.', 'Correct teams receive their wager. Incorrect teams gain no points this round.'],
    finished: ['Game complete', 'That’s the final question.', 'The leaderboard shows the final standings.']
  }[game.phase] || ['Game status', 'Waiting for the host.', ''];
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
    const title = document.createElement('h3');
    title.textContent = team.name;
    const points = document.createElement('strong');
    points.className = 'team-points';
    points.textContent = `${team.points} pts`;
    top.append(title, points);

    const captain = document.createElement('p');
    captain.className = 'captain';
    captain.textContent = team.captain ? `Captain: ${team.captain.name}` : 'Captain: waiting for draw';

    const players = document.createElement('div');
    players.className = 'player-chips';
    for (const [playerIndex, player] of team.players.entries()) {
      const chip = document.createElement('span');
      chip.textContent = player;
      if (team.captain?.playerIndex === playerIndex) chip.classList.add('is-captain');
      players.append(chip);
    }

    const footer = document.createElement('div');
    footer.className = 'team-round';
    const used = document.createElement('span');
    used.textContent = `${team.usedWagerCount}/100 wagers used`;
    footer.append(used);
    if (team.bet !== undefined) {
      const bet = document.createElement('strong');
      bet.textContent = `Wager ${team.bet}`;
      if (game.phase === 'results') {
        bet.className = team.correct ? 'result-correct' : 'result-wrong';
        bet.textContent = team.correct ? `+${team.bet}` : `+0`;
      }
      footer.append(bet);
    }
    card.append(top, captain, players, footer);
    return card;
  });
  element('team-grid').replaceChildren(...cards);
}

function renderLeaderboard(teams) {
  const sorted = [...teams].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  element('leaderboard-list').replaceChildren(...sorted.map((team) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    const points = document.createElement('strong');
    name.textContent = team.name;
    points.textContent = team.points;
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

element('retry-button').addEventListener('click', connect);
connect();

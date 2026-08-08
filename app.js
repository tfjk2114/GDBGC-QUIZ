const state = {
  apiBase: '',
  token: localStorage.getItem('gdbgc-player-token') || '',
  player: null,
  game: null,
  timer: null,
  activePanel: null,
  betPanelOpen: false
};
const element = (id) => document.getElementById(id);
const bgTeamName = (name) => name.replace(/^Team (\d+)$/, 'Отбор $1');
const bgCategoryName = (name) => name.replace(/^Category (\d+)$/, 'Категория $1');

function setView(name) {
  for (const view of ['loading', 'offline', 'join', 'game']) {
    element(`${view}-view`).classList.toggle('hidden', view !== name);
  }
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
  element('join-count').textContent = `${state.game.playerCount} от ${state.game.playerCapacity} места са заети${state.game.gameMode === 'duo' ? ' · Режим за двама' : ''}`;
  setView('join');
}

function enterWaitingRoom() {
  updatePlayerLabel();
  element('player-identity').classList.remove('hidden');
  renderGame();
  setView('game');
  clearInterval(state.timer);
  state.timer = setInterval(refresh, 1200);
}

async function refresh() {
  try {
    const [game, player] = await Promise.all([
      request('/api/game'),
      request('/api/player/status', {}, true)
    ]);
    state.game = game;
    state.player = player;
    updatePlayerLabel();
    if (!document.activeElement?.matches('input, textarea')) renderGame();
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

function updatePlayerLabel() {
  const role = state.player?.isCaptain ? ' · Капитан' : state.player?.isAnswerer ? ' · Отговаря' : '';
  element('player-label').textContent = `${state.player.name} · ${bgTeamName(state.player.teamName)}${role}`;
}

function activeTeams(game) {
  return game.teams.filter((team) => team.active !== false);
}

function renderGame() {
  const game = state.game;
  const pregame = isPregame(game.phase);
  element('question-counter').classList.toggle('hidden', pregame);
  element('game-progress-track').classList.toggle('hidden', pregame);
  element('category-strip').classList.toggle('hidden', pregame);
  if (pregame) {
    element('category-kicker').textContent = `${game.playerCount} от ${game.playerCapacity} играчи са готови`;
    element('category-name').textContent = game.gameMode === 'duo' ? 'Тестов режим за двама' : 'Игрално фоайе';
  } else {
    element('category-kicker').textContent = `${bgCategoryName(game.category.name)} · Въпроси ${game.category.start}–${game.category.end}`;
    element('category-name').textContent = bgCategoryName(game.category.name);
    element('question-number').textContent = game.questionNumber;
    element('game-progress').style.width = `${Math.min(100, game.questionNumber)}%`;
  }
  renderQuestionArea(game);
  renderCaptainVote(game);
  renderCaptainPanel(game);
  renderCommunicationTabs(game);
  renderTeams(game);
  if (!pregame) renderCategories(game);
}

function renderCommunicationTabs(game) {
  const open = game.phase === 'question';
  const captain = open && state.player?.isCaptain;
  const suggestionsTab = element('suggestions-tab');
  element('captain-answer-tab').classList.toggle('hidden', !captain);
  suggestionsTab.classList.toggle('hidden', !open);
  element('suggestions-tab-label').textContent = captain ? 'Съвети' : 'Предложи';
  const count = captain ? (state.player.suggestions || []).length : 0;
  element('suggestions-count').textContent = count;
  element('suggestions-count').classList.toggle('hidden', !count);
  if ((!open && ['answer', 'suggestions'].includes(state.activePanel)) || (!captain && state.activePanel === 'answer')) {
    state.activePanel = null;
  }
}

function renderCaptainPanel(game) {
  const panel = element('captain-panel');
  const action = element('captain-action');
  const available = game.phase === 'betting' && state.player?.isCaptain;
  if (!available) state.betPanelOpen = false;
  action.classList.toggle('hidden', !available);
  panel.classList.toggle('hidden', !available || !state.betPanelOpen);
  if (!available) return;

  const used = new Set(state.player.usedWagers || []);
  const selected = state.player.pendingBet;
  element('captain-wager-status').textContent = selected ? `Избран залог: ${selected}` : 'Няма избран залог';
  element('captain-button-status').textContent = selected ? `Текущ залог: ${selected}` : `${100 - used.size} свободни числа`;
  const buttons = [];
  for (let number = 1; number <= 100; number += 1) {
    if (used.has(number)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wager-number';
    button.textContent = number;
    if (selected === number) button.classList.add('selected');
    button.addEventListener('click', () => submitCaptainWager(number, button));
    buttons.push(button);
  }
  element('captain-number-grid').replaceChildren(...buttons);
}

async function submitCaptainWager(wager, button) {
  button.disabled = true;
  try {
    const response = await request('/api/captain/wager', { method: 'POST', body: JSON.stringify({ wager }) }, true);
    state.game = response.game;
    state.player.pendingBet = response.wager;
    state.player.usedWagers = response.usedWagers;
    state.betPanelOpen = false;
    renderGame();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderQuestionArea(game) {
  const questionBox = element('question-box');
  const test = game.test;
  const visibleQuestion = game.question || (game.phase === 'test_question' || game.phase === 'test_result' ? { number: 'Тест', prompt: test?.prompt } : null);
  questionBox.classList.toggle('hidden', !visibleQuestion);
  if (visibleQuestion) {
    element('question-label').textContent = visibleQuestion.number === 'Тест' ? 'Тестов въпрос' : `Въпрос ${visibleQuestion.number}`;
    const questionText = element('question-text');
    questionText.textContent = visibleQuestion.prompt || '';
    questionText.classList.toggle('hidden', !visibleQuestion.prompt);
    renderQuestionMedia(element('question-media'), visibleQuestion.media || []);
  } else {
    renderQuestionMedia(element('question-media'), []);
  }

  const answerPanel = element('answer-reveal-panel');
  answerPanel.classList.toggle('hidden', !['question', 'results'].includes(game.phase));
  answerPanel.classList.toggle('answer-is-revealed', game.phase === 'results');
  element('correct-answer-text').textContent = game.phase === 'results'
    ? (game.question?.answer || 'Няма предварително зададен отговор.')
    : 'Ще бъде разкрит след оценяването.';

  const responsesPanel = element('captain-responses-panel');
  responsesPanel.classList.toggle('hidden', game.phase !== 'results');
  if (game.phase === 'results') {
    element('captain-responses-grid').replaceChildren(...activeTeams(game).map((team) => {
      const response = document.createElement('article');
      response.className = `captain-response ${team.correct ? 'is-correct' : 'is-wrong'}`;
      const heading = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = bgTeamName(team.name);
      const verdict = document.createElement('span'); verdict.textContent = team.correct ? 'Вярно' : 'Грешно';
      const answer = document.createElement('p'); answer.textContent = game.teamAnswers?.[team.id] || 'Няма изпратен отговор';
      heading.append(name, verdict); response.append(heading, answer); return response;
    }));
  }
}

function renderCaptainVote(game) {
  const panel = element('captain-vote-panel');
  const voting = game.phase === 'captain_vote';
  panel.classList.toggle('hidden', !voting);
  if (!voting) return;
  const selected = state.player.captainVote;
  const candidates = state.player.captainCandidates || [];
  const buttons = candidates.map((candidate) => {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'captain-candidate';
    if (selected === candidate.playerIndex) button.classList.add('selected');
    const avatar = document.createElement('span'); avatar.textContent = candidate.name.slice(0, 1).toUpperCase();
    const name = document.createElement('strong'); name.textContent = candidate.name;
    const note = document.createElement('small'); note.textContent = candidate.playerIndex === state.player.playerIndex ? 'Това си ти' : 'Избери';
    button.append(avatar, name, note);
    button.addEventListener('click', () => submitCaptainVote(candidate.playerIndex, button));
    return button;
  });
  element('captain-candidate-grid').replaceChildren(...buttons);
  element('captain-vote-status').textContent = selected === undefined || selected === null
    ? 'Избери един от позволените играчи.'
    : 'Гласът ти е записан. Можеш да го промениш, докато всички гласуват.';
  element('captain-vote-progress').replaceChildren(...activeTeams(game).map((team) => {
    const item = document.createElement('span');
    item.textContent = `${bgTeamName(team.name)}: ${team.captainVoteCount}/${team.captainVoteRequired}`;
    if (team.captainVoteCount === team.captainVoteRequired) item.classList.add('complete');
    return item;
  }));
}

async function submitCaptainVote(playerIndex, button) {
  button.disabled = true;
  try {
    const response = await request('/api/player/captain-vote', { method: 'POST', body: JSON.stringify({ playerIndex }) }, true);
    state.player.captainVote = playerIndex;
    state.game = response.game;
    if (response.finalized) await refresh();
    else renderGame();
  } catch (error) {
    element('captain-vote-status').textContent = error.message;
    element('captain-vote-status').classList.add('error');
  } finally {
    button.disabled = false;
  }
}

function renderQuestionMedia(container, media) {
  const signature = JSON.stringify(media || []);
  if (container.dataset.mediaSignature === signature) return;
  container.dataset.mediaSignature = signature;
  container.replaceChildren(...(media || []).map((item) => {
    if (item.type === 'image') {
      const image = document.createElement('img');
      image.src = item.src; image.alt = item.alt || 'Прикачено изображение към въпроса';
      return image;
    }
    if (item.type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = item.src; audio.controls = true; audio.preload = 'metadata';
      audio.setAttribute('aria-label', 'Аудио към въпроса');
      return audio;
    }
    const link = document.createElement('a');
    link.href = item.src; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = item.label || 'Отвори прикачения файл';
    return link;
  }));
  container.classList.toggle('hidden', !(media || []).length);
}

function renderTeams(game) {
  const visibleTeams = activeTeams(game);
  const grid = element('team-grid');
  grid.classList.toggle('team-chat-open', state.activePanel === 'suggestions');
  document.querySelectorAll('[data-player-panel]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.playerPanel === state.activePanel)));
  grid.classList.toggle('hidden', !state.activePanel);
  if (!state.activePanel) return;

  if (state.activePanel === 'answer') {
    renderCaptainAnswer(grid);
    return;
  }

  if (state.activePanel === 'suggestions') {
    renderSuggestions(grid);
    return;
  }

  if (state.activePanel === 'points') {
    const sorted = [...visibleTeams].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'bg'));
    grid.replaceChildren(...sorted.map((team, index) => {
      const card = document.createElement('article'); card.className = `card info-card team-${game.teams.indexOf(team) + 1}`;
      const place = document.createElement('span'); place.className = 'info-rank'; place.textContent = `${index + 1}`;
      const name = document.createElement('strong'); name.textContent = bgTeamName(team.name);
      const points = document.createElement('b'); points.textContent = `${team.points} т.`;
      card.append(place, name, points); return card;
    }));
    return;
  }

  if (state.activePanel === 'bets') {
    grid.replaceChildren(...visibleTeams.map((team) => {
      const index = game.teams.indexOf(team);
      const card = document.createElement('article'); card.className = `card info-card bet-info-card team-${index + 1}`;
      const name = document.createElement('strong'); name.textContent = bgTeamName(team.name);
      const wager = document.createElement('b');
      if (team.bet !== undefined) wager.textContent = `Залог: ${team.bet}`;
      else if (game.phase === 'betting') wager.textContent = team.hasPendingBet ? 'Залогът е подаден' : 'Чака залог';
      else wager.textContent = 'Няма активен залог';
      const used = document.createElement('small'); used.textContent = `${team.usedWagerCount} използвани числа`;
      card.append(name, wager, used); return card;
    }));
    return;
  }

  const cards = visibleTeams.map((team) => {
    const index = game.teams.indexOf(team);
    const card = document.createElement('article');
    card.className = `card team-card team-${index + 1}`;
    const top = document.createElement('div');
    top.className = 'team-card-top';
    const title = document.createElement('h3'); title.textContent = bgTeamName(team.name);
    const points = document.createElement('strong'); points.className = 'team-points'; points.textContent = `${team.points} т.`;
    top.append(title, points);

    const captain = document.createElement('p');
    captain.className = 'captain';
    captain.textContent = team.captain ? `Капитан: ${team.captain.name}` : 'Капитан: очаква избор';
    if (game.gameMode === 'duo' && team.answerer) captain.textContent += ` · Отговаря: ${team.answerer.name}`;

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
    if (game.phase === 'betting') {
      const readiness = document.createElement('strong');
      readiness.className = team.hasPendingBet ? 'wager-ready' : 'wager-pending';
      readiness.textContent = team.hasPendingBet ? 'Залогът е подаден' : 'Чака капитана';
      footer.append(readiness);
    }
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
  grid.replaceChildren(...cards);
}

function communicationCard(title, copy) {
  const card = document.createElement('article');
  card.className = 'card communication-card';
  const heading = document.createElement('h3'); heading.textContent = title;
  const helper = document.createElement('p'); helper.className = 'communication-help'; helper.textContent = copy;
  card.append(heading, helper);
  return card;
}

function renderCaptainAnswer(grid) {
  const card = communicationCard('Отговорът на отбора', 'Само ти и водещият виждате официалния отговор. Можеш да го редактираш, докато въпросът е отворен.');
  const form = document.createElement('form'); form.className = 'communication-form';
  const textarea = document.createElement('textarea');
  textarea.maxLength = 500; textarea.rows = 4; textarea.required = true;
  textarea.placeholder = 'Напиши окончателния отговор…'; textarea.value = state.player.teamAnswer || '';
  textarea.setAttribute('aria-label', 'Официален отговор на отбора');
  const button = document.createElement('button'); button.className = 'button button-primary'; button.type = 'submit';
  button.textContent = state.player.teamAnswer ? 'Обнови отговора' : 'Изпрати отговора';
  const status = document.createElement('p'); status.className = 'communication-status';
  status.textContent = state.player.teamAnswer ? 'Отговорът е записан и може да бъде обновен.' : 'Все още няма изпратен отговор.';
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); button.disabled = true;
    try {
      const response = await request('/api/captain/answer', { method: 'POST', body: JSON.stringify({ answer: textarea.value }) }, true);
      state.player.teamAnswer = response.answer; renderCaptainAnswer(grid);
    } catch (error) { status.textContent = error.message; status.classList.add('error'); }
    finally { button.disabled = false; }
  });
  form.append(textarea, button, status); card.append(form); grid.replaceChildren(card);
}

function renderSuggestions(grid) {
  if (state.player.isCaptain) {
    const suggestions = state.player.suggestions || [];
    const card = communicationCard('Съвети от отбора', 'Тези известия са лични за капитана на твоя отбор.');
    const list = document.createElement('div'); list.className = 'suggestion-list';
    if (!suggestions.length) {
      const empty = document.createElement('p'); empty.className = 'empty-suggestions'; empty.textContent = 'Все още няма предложения.'; list.append(empty);
    } else {
      for (const suggestion of [...suggestions].reverse()) {
        const item = document.createElement('article'); item.className = 'suggestion-notification';
        const name = document.createElement('strong'); name.textContent = suggestion.name;
        const text = document.createElement('p'); text.textContent = suggestion.text;
        item.append(name, text); list.append(item);
      }
    }
    card.append(list); grid.replaceChildren(card); return;
  }

  const card = communicationCard('Предложи отговор', 'Предложението се изпраща само до капитана на твоя отбор.');
  const form = document.createElement('form'); form.className = 'communication-form';
  const textarea = document.createElement('textarea'); textarea.maxLength = 300; textarea.rows = 3; textarea.required = true;
  textarea.placeholder = 'Напиши идея или възможен отговор…'; textarea.setAttribute('aria-label', 'Предложение към капитана');
  const button = document.createElement('button'); button.className = 'button button-primary'; button.type = 'submit'; button.textContent = 'Изпрати предложение';
  const status = document.createElement('p'); status.className = 'communication-status';
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); button.disabled = true;
    try {
      const response = await request('/api/player/suggestion', { method: 'POST', body: JSON.stringify({ suggestion: textarea.value }) }, true);
      state.player.ownSuggestions = [...(state.player.ownSuggestions || []), response.suggestion];
      textarea.value = ''; status.textContent = 'Предложението е изпратено до капитана.'; status.classList.remove('error');
    } catch (error) { status.textContent = error.message; status.classList.add('error'); }
    finally { button.disabled = false; }
  });
  form.append(textarea, button, status);
  const sent = document.createElement('div'); sent.className = 'own-suggestions';
  for (const suggestion of [...(state.player.ownSuggestions || [])].reverse()) {
    const item = document.createElement('p'); item.textContent = suggestion.text; sent.append(item);
  }
  card.append(form, sent); grid.replaceChildren(card);
}

function renderCategories(game) {
  element('category-strip').replaceChildren(...game.categories.map((category, index) => {
    const item = document.createElement('span');
    item.className = index < game.categoryIndex ? 'complete' : index === game.categoryIndex ? 'active' : '';
    item.textContent = index + 1;
    item.title = bgCategoryName(category.name);
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

document.querySelectorAll('[data-player-panel]').forEach((button) => button.addEventListener('click', () => {
  state.activePanel = state.activePanel === button.dataset.playerPanel ? null : button.dataset.playerPanel;
  if (state.game) renderTeams(state.game);
}));

element('captain-wager-button').addEventListener('click', () => {
  state.betPanelOpen = true;
  if (state.game) renderCaptainPanel(state.game);
});

element('captain-panel-close').addEventListener('click', () => {
  state.betPanelOpen = false;
  if (state.game) renderCaptainPanel(state.game);
});

element('captain-panel').addEventListener('click', (event) => {
  if (event.target === element('captain-panel')) element('captain-panel-close').click();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.betPanelOpen) element('captain-panel-close').click();
});
connect();

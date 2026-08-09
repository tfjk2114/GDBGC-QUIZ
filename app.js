const state = {
  apiBase: '',
  token: localStorage.getItem('gdbgc-player-token') || '',
  player: null,
  game: null,
  timer: null,
  timerTicker: null,
  activePanel: null,
  betPanelOpen: false,
  finaleVersion: null,
  finaleDismissed: false
};
const element = (id) => document.getElementById(id);
const bgTeamName = (name) => name.replace(/^Team (\d+)$/, 'Отбор $1');
const bgCategoryName = (name) => name.replace(/^Category (\d+)$/, 'Категория $1').toLocaleUpperCase('bg');

function setView(name) {
  for (const view of ['loading', 'offline', 'join', 'game']) {
    element(`${view}-view`).classList.toggle('hidden', view !== name);
  }
}

function setConnection(kind, label) {
  const status = element('connection-status');
  if (!status) return;
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
  if (!state.timerTicker) state.timerTicker = setInterval(updatePlayerTimer, 250);
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
    if (!document.activeElement?.matches('input, textarea')) {
      renderGame();
    } else if (state.activePanel === 'suggestions') {
      renderCommunicationTabs(game);
      renderTeamChatMessages(document.querySelector('.team-chat-list'));
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
    element('category-name').textContent = game.gameMode === 'duo' ? 'Двубой за двама' : 'Игрално фоайе';
  } else {
    element('category-kicker').textContent = `${bgCategoryName(game.category.name)} · Въпроси ${game.category.start}–${game.category.end}`;
    element('category-name').textContent = bgCategoryName(game.category.name);
    element('question-number').textContent = game.questionNumber;
    element('game-progress').style.width = `${Math.min(100, game.questionNumber)}%`;
  }
  renderQuestionArea(game);
  renderCaptainVote(game);
  updatePlayerTimer();
  renderCaptainPanel(game);
  renderCommunicationTabs(game);
  renderTeams(game);
  renderFinale(game);
  if (!pregame) renderCategories(game);
}

function renderFinale(game) {
  const overlay = element('finale-overlay');
  if (game.phase !== 'finished') {
    overlay.classList.add('hidden');
    state.finaleDismissed = false;
    state.finaleVersion = null;
    return;
  }
  if (state.finaleDismissed) {
    overlay.classList.add('hidden'); return;
  }
  overlay.classList.remove('hidden');
  if (state.finaleVersion === game.version) return;
  state.finaleVersion = game.version;
  const ranked = [...activeTeams(game)].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, 'bg'));
  element('finale-winner').textContent = `${bgTeamName(ranked[0].name)} ПЕЧЕЛИ С ${ranked[0].points} ТОЧКИ!`;

  const revealDelay = { 1: '2.8s', 2: '1.5s', 3: '.4s' };
  const podiumOrder = [ranked[2], ranked[0], ranked[1]].filter(Boolean);
  element('finale-podium').replaceChildren(...podiumOrder.map((team) => {
    const rank = ranked.indexOf(team) + 1;
    const slot = document.createElement('article');
    slot.className = `podium-slot podium-rank-${rank} team-${game.teams.indexOf(team) + 1}`;
    slot.style.setProperty('--reveal-delay', revealDelay[rank]);
    const medal = document.createElement('span'); medal.className = 'podium-medal'; medal.textContent = rank === 1 ? '🏆' : rank === 2 ? '🥈' : '🥉';
    const name = document.createElement('strong'); name.textContent = bgTeamName(team.name);
    const points = document.createElement('small'); points.textContent = `${team.points} ТОЧКИ`;
    const step = document.createElement('div'); step.className = 'podium-step'; step.textContent = rank;
    slot.append(medal, name, points, step); return slot;
  }));

  element('finale-ranking').replaceChildren(...ranked.map((team, index) => {
    const row = document.createElement('div');
    const place = document.createElement('strong'); place.textContent = `${index + 1}. ${bgTeamName(team.name)}`;
    const points = document.createElement('span'); points.textContent = `${team.points} ТОЧКИ`;
    row.append(place, points); return row;
  }));

  element('finale-confetti').replaceChildren(...Array.from({ length: 48 }, (_, index) => {
    const piece = document.createElement('i');
    piece.style.setProperty('--x', `${(index * 37) % 101}vw`);
    piece.style.setProperty('--delay', `${(index % 16) * .11}s`);
    piece.style.setProperty('--fall', `${3.2 + (index % 7) * .28}s`);
    piece.style.setProperty('--color', ['#42e8ff', '#18f065', '#f4fdff', '#ff313b'][index % 4]);
    return piece;
  }));
}

function renderCommunicationTabs(game) {
  const open = game.phase === 'question';
  const captain = open && state.player?.isCaptain;
  const suggestionsTab = element('suggestions-tab');
  element('captain-answer-tab').classList.toggle('hidden', !captain);
  suggestionsTab.classList.toggle('hidden', !open);
  element('suggestions-tab-label').textContent = 'Отборен чат';
  const count = (state.player?.teamChat || []).length;
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
  answerPanel.classList.toggle('hidden', !['question', 'review', 'results'].includes(game.phase));
  answerPanel.classList.toggle('answer-is-revealed', game.phase === 'results');
  element('correct-answer-text').textContent = game.phase === 'results'
    ? (game.question?.answer || 'Няма предварително зададен отговор.').toLocaleUpperCase('bg')
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
      const answer = document.createElement('p'); answer.textContent = (game.teamAnswers?.[team.id] || 'Няма изпратен отговор').toLocaleUpperCase('bg');
      heading.append(name, verdict); response.append(heading, answer);
      if (!team.correct) {
        const wanted = document.createElement('small'); wanted.className = 'wanted-answer';
        wanted.textContent = `ЖЕЛАН ОТГОВОР: (${(game.question?.answer || 'НЯМА ЗАДАДЕН ОТГОВОР').toLocaleUpperCase('bg')})`;
        response.append(wanted);
      }
      return response;
    }));
  }
}

function updatePlayerTimer() {
  const timer = state.game?.timer;
  const panel = element('global-timer');
  if (!timer || (!timer.running && !timer.expired)) {
    panel.classList.add('hidden'); return;
  }
  panel.classList.remove('hidden');
  const remaining = timer.running && timer.deadline ? Math.max(0, Math.ceil((timer.deadline - Date.now()) / 1000)) : 0;
  element('global-timer-value').textContent = remaining;
  element('global-timer-label').textContent = remaining > 0 ? 'ОСТАВАЩО ВРЕМЕ' : 'ВРЕМЕТО ИЗТЕЧЕ';
  panel.classList.toggle('timer-expired', remaining === 0);
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

    const players = document.createElement('div');
    players.className = 'player-chips';
    for (const [playerIndex, player] of team.players.slice(0, team.requiredPlayers ?? 4).entries()) {
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
  const card = communicationCard('Отборен чат', 'Всички в твоя отбор, включително капитанът, могат да четат и пишат тук.');
  const list = document.createElement('div'); list.className = 'suggestion-list team-chat-list';
  renderTeamChatMessages(list);

  const form = document.createElement('form'); form.className = 'communication-form team-chat-form';
  const textarea = document.createElement('textarea'); textarea.maxLength = 300; textarea.rows = 3; textarea.required = true;
  textarea.placeholder = 'Напиши съобщение до отбора…'; textarea.setAttribute('aria-label', 'Съобщение до отбора');
  const button = document.createElement('button'); button.className = 'button button-primary'; button.type = 'submit'; button.textContent = 'Изпрати';
  const status = document.createElement('p'); status.className = 'communication-status';
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); button.disabled = true;
    try {
      const response = await request('/api/player/chat', { method: 'POST', body: JSON.stringify({ message: textarea.value }) }, true);
      state.player.teamChat = [...(state.player.teamChat || []), response.message];
      renderSuggestions(grid);
    } catch (error) { status.textContent = error.message; status.classList.add('error'); }
    finally { button.disabled = false; }
  });
  form.append(textarea, button, status);
  card.append(list, form); grid.replaceChildren(card);
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function renderTeamChatMessages(list) {
  if (!list) return;
  const messages = state.player?.teamChat || [];
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  const previousLastId = list.lastElementChild?.dataset.messageId;
  const nextLastId = messages.at(-1)?.id;
  const signature = `${messages.length}:${nextLastId || 'empty'}`;
  if (list.dataset.chatSignature === signature) return;
  list.dataset.chatSignature = signature;
  list.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('p'); empty.className = 'empty-suggestions'; empty.textContent = 'Чатът е празен. Започни разговора.'; list.append(empty);
  } else {
    for (const message of messages) {
      const item = document.createElement('article');
      item.className = `suggestion-notification${message.playerIndex === state.player.playerIndex ? ' is-mine' : ''}`;
      item.dataset.messageId = message.id;
      const heading = document.createElement('div'); heading.className = 'team-chat-message-heading';
      const name = document.createElement('strong'); name.textContent = message.name;
      heading.append(name);
      if (message.sentAt) {
        const time = document.createElement('time');
        time.dateTime = new Date(message.sentAt).toISOString();
        time.textContent = new Date(message.sentAt).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
        heading.append(time);
      }
      const text = document.createElement('p'); text.textContent = message.text;
      item.append(heading, text); list.append(item);
    }
  }
  if (wasNearBottom || !previousLastId) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
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

element('finale-close').addEventListener('click', () => {
  state.finaleDismissed = true;
  element('finale-overlay').classList.add('hidden');
  state.activePanel = 'points';
  if (state.game) renderTeams(state.game);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.betPanelOpen) element('captain-panel-close').click();
});
connect();

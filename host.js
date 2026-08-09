const state = { apiBase: '', token: localStorage.getItem('gdbgc-host-token') || '', game: null, renderedVersion: null, timer: null, questionFilter: 'all', activePanel: null, revealedAnswerFor: null, browserQuestionNumber: null, browserAnswerRevealed: false };
const element = (id) => document.getElementById(id);

function setConnection(kind, label) {
  const status = element('connection-status');
  if (!status) return;
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
    const changed = state.renderedVersion !== game.version;
    state.game = game;
    if (forceRender || (changed && !focused)) {
      render();
    } else if (changed) {
      refreshSubmittedAnswers(game);
      updateHostTimerClock();
    }
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

function activeTeams(game) {
  return game.teams.filter((team) => team.active !== false);
}

function render() {
  const game = state.game;
  state.renderedVersion = game.version;
  const pregame = isPregame(game.phase);
  element('host-question-counter').classList.toggle('hidden', pregame);
  if (pregame) {
    element('host-kicker').textContent = `${game.playerCount} of ${game.playerCapacity} players joined`;
    element('host-title').textContent = game.gameMode === 'duo' ? 'Two-player head-to-head lobby' : 'Game lobby';
  } else {
    element('host-kicker').textContent = `${game.category.name} · Questions ${game.category.start}–${game.category.end}`;
    element('host-title').textContent = game.phase === 'finished' ? 'Final standings' : game.category.name;
    element('host-question').textContent = game.questionNumber;
  }
  const phaseNames = {
    lobby: 'lobby', test_question: 'test question', test_result: 'test complete', category_start: 'new category', captain_vote: 'captain vote',
    betting: 'wagers', question: 'question', review: 'answer review', results: 'results', finished: 'finished'
  };
  element('phase-badge').textContent = phaseNames[game.phase] || game.phase;
  const modeButton = element('game-mode-button');
  modeButton.textContent = game.gameMode === 'duo' ? 'Use team mode' : 'Enable 2-player head-to-head';
  modeButton.disabled = game.phase !== 'lobby' || (game.gameMode !== 'duo' && game.playerCount > 2);
  modeButton.title = game.phase !== 'lobby' ? 'Reset or return to the lobby to change modes' : modeButton.disabled ? 'Remove players until no more than two remain' : '';
  element('roster-title').textContent = game.gameMode === 'duo' ? 'Two players on two teams' : 'Adjustable team sizes';
  element('roster-count').textContent = game.gameMode === 'duo' ? `${game.playerCount}/2 seats filled. Each player has a separate team.` : `${game.playerCount}/${game.playerCapacity} required seats filled. ${game.queueCount || 0} waiting. The quiz can still start early.`;
  renderRound(game);
  renderTeams(game);
  renderPlayerQueue(game);
  renderPoints(game);
  renderHostBets(game);
  renderQuestionBank(game);
  renderHostLiveQuestion(game);
  renderHostTimer(game);
  renderHostPanels();
}

function renderHostTimer(game) {
  const input = element('host-timer-seconds');
  if (document.activeElement !== input) input.value = game.timer?.duration || 30;
  element('stop-timer-button').disabled = !game.timer?.running;
  updateHostTimerClock();
}

function updateHostTimerClock() {
  const timer = state.game?.timer;
  if (!timer) return;
  const remaining = timer.running && timer.deadline ? Math.max(0, Math.ceil((timer.deadline - Date.now()) / 1000)) : timer.expired ? 0 : timer.duration;
  const clock = element('host-timer-clock');
  clock.textContent = timer.expired ? 'Expired' : `${remaining}s`;
  clock.classList.toggle('timer-expired', Boolean(timer.expired));
}

function renderHostLiveQuestion(game) {
  const panel = element('host-live-question');
  panel.classList.toggle('hidden', !game.question);
  if (!game.question) {
    renderQuestionMedia(element('host-live-question-media'), []);
    return;
  }
  const questionKey = game.question.id || game.question.number;
  const answerRevealed = state.revealedAnswerFor === questionKey;
  element('host-live-question-label').textContent = `Question ${game.question.number} · ${game.category.name}`;
  const questionText = element('host-live-question-text');
  questionText.textContent = game.question.prompt || '';
  questionText.classList.toggle('hidden', !game.question.prompt);
  renderQuestionMedia(element('host-live-question-media'), game.question.media || []);
  element('host-live-answer-text').textContent = answerRevealed ? (game.question.answer || 'Not provided yet') : 'Hidden until revealed';
  element('host-live-answer-text').classList.toggle('answer-concealed', !answerRevealed);
  element('host-live-answer-text').closest('.host-live-answer').classList.toggle('is-revealed', answerRevealed);
  element('reveal-answer-button').textContent = answerRevealed ? 'Hide answer' : 'Reveal answer';
  element('reveal-answer-button').setAttribute('aria-pressed', String(answerRevealed));
  const next = element('host-next-question');
  next.disabled = game.phase !== 'results';
  next.textContent = game.questionNumber % 10 === 0 ? 'Finish category' : 'Next question';
  next.title = game.phase === 'results' ? '' : 'Score the question before continuing';
}

function renderHostPanels() {
  document.querySelectorAll('[data-host-panel]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.hostPanel === state.activePanel)));
  document.querySelectorAll('[data-host-section]').forEach((section) => section.classList.toggle('hidden', section.dataset.hostSection !== state.activePanel));
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
    category_start: 'Open captain voting', captain_vote: 'Captain election', betting: 'Captain wagers', question: 'Judge the answers', review: 'Review locked answers',
    results: 'Review the result', finished: 'Game complete'
  };
  element('round-title').textContent = titleByPhase[game.phase] || 'Game control';

  if (game.phase === 'lobby') return renderLobby(game, controls);
  if (game.phase === 'test_question') return renderTestQuestion(game, controls);
  if (game.phase === 'test_result') return renderTestResult(game, controls);
  if (game.phase === 'category_start') {
    controls.innerHTML = '<p class="helper">Open the team vote before this category begins.</p>';
    controls.append(actionButton('Open captain voting', () => post('/api/host/category/start', {})));
    return;
  }

  if (game.phase === 'captain_vote') {
    const help = document.createElement('p'); help.className = 'helper';
    help.textContent = game.gameMode === 'duo'
      ? 'Each player remains captain of their own team in head-to-head mode.'
      : 'Every player votes inside their team. The two most recent captains are ineligible when team size permits; self-votes are allowed.';
    const grid = document.createElement('div'); grid.className = 'captain-grid';
    grid.replaceChildren(...activeTeams(game).map((team) => {
      const progress = document.createElement('div'); progress.className = 'team-roles';
      const count = document.createElement('span'); count.className = 'captain-name'; count.textContent = `${team.captainVoteCount}/${team.captainVoteRequired} votes submitted`;
      const note = document.createElement('small'); note.textContent = team.captainVoteCount === team.captainVoteRequired ? 'Voting complete' : 'Waiting for team members';
      progress.append(count, note); return teamCard(team, progress);
    }));
    const startAnyway = actionButton('Start round anyway', () => post('/api/host/captain-vote/finish', {}));
    startAnyway.title = 'Submitted votes count; teams with no votes receive a valid captain automatically.';
    controls.append(help, grid, startAnyway);
    return;
  }

  const captainGrid = document.createElement('div');
  captainGrid.className = 'captain-grid';
  captainGrid.replaceChildren(...activeTeams(game).map((team) => {
    const roles = document.createElement('div'); roles.className = 'team-roles';
    const captain = document.createElement('span'); captain.className = 'captain-name'; captain.textContent = `Captain: ${team.captain?.name || 'Not selected yet'}`;
    roles.append(captain);
    return teamCard(team, roles);
  }));
  controls.append(captainGrid);

  if (game.phase === 'betting') renderBetting(game, controls);
  if (game.phase === 'question') renderScoring(game, controls);
  if (game.phase === 'review') renderScoring(game, controls);
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
  status.innerHTML = `<strong>${game.playerCount}/${game.playerCapacity} players</strong><span>${game.gameMode === 'duo' ? 'Two-player head-to-head' : 'Team mode · early start allowed'}</span><span>${game.testCompleted ? '✓ System test completed' : 'System test not run yet'}</span>`;
  const actions = document.createElement('div');
  actions.className = 'control-actions';
  const testButton = actionButton('Run one-player system test', () => post('/api/host/test/start', {}));
  testButton.disabled = game.playerCount < 1;
  actions.append(testButton);
  if (game.testCompleted) {
    const startButton = actionButton(game.gameMode === 'duo' ? 'Start head-to-head match' : 'Start captain vote', () => post('/api/host/game/start', {}));
    startButton.disabled = game.gameMode === 'duo' ? game.playerCount !== 2 : game.playerCount < 1;
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
  startButton.textContent = game.gameMode === 'duo' ? 'Start head-to-head match' : 'Start captain vote';
  startButton.disabled = game.gameMode === 'duo' ? game.playerCount !== 2 : game.playerCount < 1;
  actions.append(startButton);
  controls.append(testPreview(game.test), result, actions);
}

function renderBetting(game, controls) {
  const help = document.createElement('p'); help.className = 'helper';
  help.textContent = game.gameMode === 'duo' ? 'Each player chooses an unused number for their own team. Reveal the question after both wagers arrive.' : 'Each participating team captain chooses an unused number. Reveal the question after every active team submits.';
  const grid = document.createElement('div'); grid.className = 'wager-grid';
  for (const team of activeTeams(game)) {
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
  reveal.disabled = Object.keys(game.pendingBets).length !== activeTeams(game).length;
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
  const questions = filteredBrowserQuestions(game);
  if (!questions.some((question) => question.number === state.browserQuestionNumber)) {
    const active = questions.find((question) => question.number === game.questionNumber);
    state.browserQuestionNumber = (active || questions[0])?.number || null;
    state.browserAnswerRevealed = false;
  }
  const position = Math.max(0, questions.findIndex((question) => question.number === state.browserQuestionNumber));
  const question = questions[position];
  element('question-bank-count').textContent = question ? `${position + 1}/${questions.length}` : '0';
  if (!question) return;
  element('browser-question-number').textContent = String(question.number);
  element('browser-question-category').textContent = game.categories[question.categoryIndex]?.name || `Category ${question.categoryIndex + 1}`;
  const prompt = element('browser-question-text');
  prompt.textContent = question.prompt || '';
  prompt.classList.toggle('hidden', !question.prompt);
  renderQuestionMedia(element('browser-question-media'), question.media || []);
  const answer = element('browser-answer-text');
  answer.textContent = state.browserAnswerRevealed ? (question.answer || 'No intended answer provided') : 'Hidden until revealed';
  answer.classList.toggle('answer-concealed', !state.browserAnswerRevealed);
  element('browser-reveal').textContent = state.browserAnswerRevealed ? 'Hide answer' : 'Reveal answer';
  element('browser-previous').disabled = position === 0;
  element('browser-next').disabled = position === questions.length - 1;
}

function filteredBrowserQuestions(game) {
  return (game.questionBank || []).filter((question) => state.questionFilter === 'all' || question.categoryIndex === Number(state.questionFilter));
}

function moveBrowserQuestion(direction) {
  const questions = filteredBrowserQuestions(state.game);
  const position = questions.findIndex((question) => question.number === state.browserQuestionNumber);
  const next = questions[position + direction];
  if (!next) return;
  state.browserQuestionNumber = next.number;
  state.browserAnswerRevealed = false;
  renderQuestionBank(state.game);
}

function renderQuestionMedia(container, media) {
  const signature = JSON.stringify(media || []);
  if (container.dataset.mediaSignature === signature) return;
  container.dataset.mediaSignature = signature;
  container.replaceChildren(...(media || []).map((item) => {
    if (item.type === 'image') {
      const image = document.createElement('img'); image.src = item.src; image.alt = item.alt || 'Question attachment'; return image;
    }
    if (item.type === 'audio') {
      const audio = document.createElement('audio'); audio.src = item.src; audio.controls = true; audio.preload = 'metadata'; audio.setAttribute('aria-label', 'Question audio'); return audio;
    }
    const link = document.createElement('a'); link.href = item.src; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.label || 'Open question attachment'; return link;
  }));
  container.classList.toggle('hidden', !(media || []).length);
}

function renderScoring(game, controls) {
  const help = document.createElement('p'); help.className = 'helper';
  help.textContent = 'Choose a verdict for every team. A correct answer earns the locked wager; an incorrect answer earns zero.';
  const grid = document.createElement('div'); grid.className = 'result-grid';
  for (const team of activeTeams(game)) {
    const select = document.createElement('select'); select.dataset.resultTeam = team.id;
    select.innerHTML = '<option value="">Choose verdict…</option><option value="true">Correct</option><option value="false">Incorrect</option>';
    const wrap = document.createElement('div');
    const bet = document.createElement('small'); bet.textContent = `Wager: ${team.bet}`;
    const submitted = document.createElement('p'); submitted.className = 'submitted-team-answer';
    submitted.dataset.teamAnswer = team.id;
    submitted.setAttribute('aria-live', 'polite');
    updateSubmittedAnswer(submitted, game.teamAnswers?.[team.id]);
    wrap.append(bet, submitted, select); grid.append(teamCard(team, wrap));
  }
  const score = actionButton('Score question', async () => {
    const results = {};
    document.querySelectorAll('[data-result-team]').forEach((select) => { if (select.value !== '') results[select.dataset.resultTeam] = select.value === 'true'; });
    await post('/api/host/question/score', { results });
  });
  controls.append(help, grid, score);
}

function updateSubmittedAnswer(element, answer) {
  const received = Boolean(answer);
  element.textContent = received ? answer : 'Waiting for captain…';
  element.classList.toggle('is-received', received);
}

function refreshSubmittedAnswers(game) {
  document.querySelectorAll('[data-team-answer]').forEach((answer) => {
    updateSubmittedAnswer(answer, game.teamAnswers?.[answer.dataset.teamAnswer]);
  });
}

function renderResults(game, controls) {
  const grid = document.createElement('div'); grid.className = 'result-grid';
  for (const team of activeTeams(game)) {
    const text = document.createElement('span'); text.className = team.correct ? 'result-correct' : 'result-wrong';
    text.textContent = team.correct ? `Correct · +${team.bet}` : 'Incorrect · +0';
    grid.append(teamCard(team, text));
  }
  const help = document.createElement('p'); help.className = 'helper';
  help.textContent = 'Use the Next question button in the pinned question card when you are ready to continue.';
  controls.append(grid, help);
}

function actionButton(label, handler, extraClass = '') {
  const button = document.createElement('button');
  button.className = `button button-primary ${extraClass}`.trim();
  button.type = 'button'; button.textContent = label;
  button.addEventListener('click', async () => { button.disabled = true; try { await handler(); } finally { button.disabled = false; } });
  return button;
}

function renderTeams(game) {
  const canChangePlayers = isPregame(game.phase);
  const cards = game.teams.map((team, teamIndex) => {
    const card = document.createElement('div'); card.className = 'team-edit-card';
    card.dataset.teamIndex = teamIndex;
    card.dataset.requiredPlayers = game.gameMode === 'duo' ? 1 : (team.requiredPlayers || 4);
    if (game.gameMode === 'duo' && team.active === false) card.classList.add('hidden');
    const teamName = document.createElement('input');
    teamName.value = team.name; teamName.dataset.teamName = teamIndex; teamName.setAttribute('aria-label', `Team ${teamIndex + 1} name`);
    const heading = document.createElement('div'); heading.className = 'team-edit-heading';
    const sizeControl = document.createElement('div'); sizeControl.className = 'team-size-control';
    const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', `Reduce required players for ${team.name}`);
    const required = document.createElement('strong'); required.className = 'team-required-count';
    const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', `Increase required players for ${team.name}`);
    sizeControl.append(minus, required, plus); heading.append(teamName, sizeControl);
    const players = document.createElement('div'); players.className = 'player-fields';
    for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
      const row = document.createElement('div'); row.className = 'player-field-row'; row.dataset.playerSeat = playerIndex;
      const input = document.createElement('input');
      input.value = team.players[playerIndex] || '';
      input.placeholder = `Open seat ${playerIndex + 1}`;
      input.dataset.teamPlayer = `${teamIndex}:${playerIndex}`;
      input.setAttribute('aria-label', `${team.name}, player ${playerIndex + 1}`);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-player'; remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove player from ${team.name}, seat ${playerIndex + 1}`);
      remove.disabled = !canChangePlayers || !input.value;
      input.addEventListener('input', () => { remove.disabled = !canChangePlayers || !input.value; });
      remove.addEventListener('click', () => { input.value = ''; remove.disabled = true; input.focus(); });
      row.append(input, remove);
      if (game.gameMode === 'full' && (team.connectedPlayers || []).includes(playerIndex)) {
        const moveControls = document.createElement('div'); moveControls.className = 'move-player-controls';
        const target = document.createElement('select');
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Move to…'; target.append(placeholder);
        for (const candidate of game.teams.filter((item) => item.id !== team.id && (canChangePlayers || item.active !== false))) {
          const option = document.createElement('option'); option.value = candidate.id; option.textContent = candidate.name; target.append(option);
        }
        const move = document.createElement('button'); move.type = 'button'; move.className = 'move-player'; move.textContent = 'Move';
        move.disabled = game.phase === 'captain_vote';
        move.addEventListener('click', async () => {
          if (!target.value) return message('Choose a destination team.', true);
          move.disabled = true;
          try { await post('/api/host/players/move', { sourceTeamId: team.id, playerIndex, targetTeamId: target.value }); }
          finally { move.disabled = false; }
        });
        moveControls.append(target, move); row.append(moveControls);
      }
      players.append(row);
    }
    const resize = (delta) => {
      const current = Number(card.dataset.requiredPlayers);
      const next = Math.max(1, Math.min(4, current + delta));
      if (next === current) return;
      if (delta < 0) {
        const removedSeat = card.querySelector(`[data-team-player="${teamIndex}:${current - 1}"]`);
        if (removedSeat?.value) return message('Remove the player from the last seat before reducing the team size.', true);
      }
      card.dataset.requiredPlayers = next;
      updateTeamSizeCard(card, game.gameMode, canChangePlayers);
      if (delta > 0) card.querySelector(`[data-team-player="${teamIndex}:${next - 1}"]`)?.focus();
    };
    minus.addEventListener('click', () => resize(-1)); plus.addEventListener('click', () => resize(1));
    card.append(heading, players);
    updateTeamSizeCard(card, game.gameMode, canChangePlayers);
    return card;
  });
  element('team-editor').replaceChildren(...cards);
}

function renderPlayerQueue(game) {
  const container = element('player-queue');
  if (!container) return;
  const queue = game.playerQueue || [];
  if (game.gameMode !== 'full' || !queue.length) {
    const empty = document.createElement('p'); empty.className = 'helper queue-empty';
    empty.textContent = game.gameMode === 'full' ? 'No players are waiting.' : 'The waiting queue is disabled in 2-player mode.';
    container.replaceChildren(empty); return;
  }
  const eligibleTeams = game.teams.filter((team) => team.active !== false && team.players.slice(0, team.requiredPlayers || 4).some((name) => !name));
  container.replaceChildren(...queue.map((queued, index) => {
    const row = document.createElement('div'); row.className = 'queue-player-row';
    const name = document.createElement('strong'); name.textContent = `${index + 1}. ${queued.name}`;
    const actions = document.createElement('div'); actions.className = 'queue-team-actions';
    for (const team of eligibleTeams) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Add to ${team.name}`;
      button.addEventListener('click', () => post('/api/host/players/assign', { queueId: queued.id, targetTeamId: team.id }));
      actions.append(button);
    }
    if (!eligibleTeams.length) {
      const full = document.createElement('small'); full.textContent = 'No participating team has an open required seat.'; actions.append(full);
    }
    row.append(name, actions); return row;
  }));
}

function updateTeamSizeCard(card, mode, canChangePlayers) {
  const required = Number(card.dataset.requiredPlayers);
  card.querySelector('.team-required-count').textContent = `${required} required`;
  const [minus, plus] = card.querySelectorAll('.team-size-control button');
  minus.disabled = mode === 'duo' || !canChangePlayers || required <= 1;
  plus.disabled = mode === 'duo' || !canChangePlayers || required >= 4;
  card.querySelectorAll('[data-player-seat]').forEach((row) => row.classList.toggle('hidden', Number(row.dataset.playerSeat) >= required));
}

function renderPoints(game) {
  element('points-editor').replaceChildren(...activeTeams(game).map((team) => {
    const row = document.createElement('div'); row.className = 'point-row';
    const name = document.createElement('span'); name.textContent = team.name;
    const input = document.createElement('input'); input.type = 'number'; input.value = team.points;
    const button = document.createElement('button'); button.className = 'button button-primary'; button.textContent = 'Set';
    button.addEventListener('click', () => post('/api/host/points', { teamId: team.id, points: Number(input.value) }));
    row.append(name, input, button); return row;
  }));
}

function renderHostBets(game) {
  element('host-bets-view').replaceChildren(...activeTeams(game).map((team) => {
    const row = document.createElement('article'); row.className = 'host-bet-row';
    const heading = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = team.name;
    const captain = document.createElement('small'); captain.textContent = team.captain?.name ? `Captain: ${team.captain.name}` : 'No captain selected';
    heading.append(name, captain);
    const current = document.createElement('b');
    const wager = game.pendingBets[team.id] ?? team.bet;
    current.textContent = wager === undefined ? 'No wager' : `Wager ${wager}`;
    const used = document.createElement('p');
    used.textContent = team.usedWagers.length ? `Used: ${team.usedWagers.join(', ')}` : 'No used numbers';
    row.append(heading, current, used); return row;
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
    players: [0, 1, 2, 3].map((playerIndex) => document.querySelector(`[data-team-player="${teamIndex}:${playerIndex}"]`).value),
    requiredPlayers: Number(document.querySelector(`[data-team-index="${teamIndex}"]`).dataset.requiredPlayers)
  }));
  await post('/api/host/teams', { teams });
});

element('randomize-players').addEventListener('click', async () => {
  if (!confirm('Randomize all joined players across the four teams?')) return;
  await post('/api/host/players/randomize', {});
});

element('game-mode-button').addEventListener('click', async () => {
  if (state.game?.phase !== 'lobby') return;
  await post('/api/host/mode', { mode: state.game.gameMode === 'duo' ? 'full' : 'duo' });
});

element('reset-button').addEventListener('click', async () => {
  if (!confirm('Reset all players, scores, wagers, captains, and progress?')) return;
  await post('/api/host/reset', { confirmation: 'RESET' });
});

element('question-category-filter').addEventListener('change', (event) => {
  state.questionFilter = event.target.value;
  state.browserQuestionNumber = null;
  state.browserAnswerRevealed = false;
  if (state.game) renderQuestionBank(state.game);
});

element('browser-previous').addEventListener('click', () => moveBrowserQuestion(-1));
element('browser-next').addEventListener('click', () => moveBrowserQuestion(1));
element('browser-reveal').addEventListener('click', () => {
  state.browserAnswerRevealed = !state.browserAnswerRevealed;
  if (state.game) renderQuestionBank(state.game);
});

element('reveal-answer-button').addEventListener('click', () => {
  if (!state.game?.question) return;
  const questionKey = state.game.question.id || state.game.question.number;
  state.revealedAnswerFor = state.revealedAnswerFor === questionKey ? null : questionKey;
  render();
});

element('host-next-question').addEventListener('click', async () => {
  if (state.game?.phase !== 'results') return;
  await post('/api/host/question/next', {});
});

element('start-timer-button').addEventListener('click', async () => {
  const seconds = Number(element('host-timer-seconds').value);
  await post('/api/host/timer', { action: 'start', seconds });
});

element('stop-timer-button').addEventListener('click', async () => {
  const seconds = Number(element('host-timer-seconds').value);
  await post('/api/host/timer', { action: 'stop', seconds });
});

document.querySelectorAll('[data-host-panel]').forEach((button) => button.addEventListener('click', () => {
  state.activePanel = state.activePanel === button.dataset.hostPanel ? null : button.dataset.hostPanel;
  renderHostPanels();
}));

setInterval(updateHostTimerClock, 250);
connect();

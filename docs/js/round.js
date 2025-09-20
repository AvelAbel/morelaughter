import { supabase } from './supabaseClient.js';
import { state, el } from './state.js';

let answersSub = null;
let roundsSub = null;
let roomsSub = null;
let votesSub = null;
async function resubscribeAnswersRealtime() {
  if (answersSub) { try { await supabase.removeChannel(answersSub); } catch {} }
  if (!state.currentRoundId) return;
  answersSub = supabase
    .channel(`answers-${state.currentRoundId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'answers',
      filter: `round_id=eq.${state.currentRoundId}`
    }, () => refreshRoomState())
    .subscribe();
}

async function resubscribeVotesRealtime() {
  if (votesSub) { try { await supabase.removeChannel(votesSub); } catch {} }
  if (!state.currentRoundId) return;
  votesSub = supabase
    .channel(`votes-${state.currentRoundId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'votes',
      filter: `round_id=eq.${state.currentRoundId}`
    }, () => refreshRoomState())
    .subscribe();
}

async function resubscribeRoomRealtime() {
  // Подписка на старт раунда (INSERT в rounds текущей комнаты)
  if (roundsSub) { try { await supabase.removeChannel(roundsSub); } catch {} }
  if (!state.currentRoomId) return;
  roundsSub = supabase
    .channel(`rounds-room-${state.currentRoomId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'rounds',
      filter: `room_id=eq.${state.currentRoomId}`
    }, (payload) => {
      // Раунд создан хостом → перейти на шаг 4, если автопереход разрешён
      state.currentRoundId = payload?.new?.id || state.currentRoundId;
      if (state.autoJumpToRound) import('./state.js').then(({ showStep }) => showStep(4));
      refreshRoomState();
    })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'rounds',
      filter: `room_id=eq.${state.currentRoomId}`
    }, () => {
      // Любое обновление раунда (смена фазы и т.п.)
      refreshRoomState();
    })
    .subscribe();

  // Подписка на смену статуса комнаты (из lobby в in_progress)
  if (roomsSub) { try { await supabase.removeChannel(roomsSub); } catch {} }
  roomsSub = supabase
    .channel(`rooms-${state.currentRoomId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'rooms',
      filter: `id=eq.${state.currentRoomId}`
    }, (payload) => {
      if (payload?.new?.status && payload.new.status !== 'lobby') {
        if (state.autoJumpToRound) import('./state.js').then(({ showStep }) => showStep(4));
        refreshRoomState();
      }
    })
    .subscribe();
}

export function cleanupSubscriptions() {
  try { if (answersSub) { supabase.removeChannel(answersSub); answersSub = null; } } catch {}
  try { if (votesSub)   { supabase.removeChannel(votesSub);   votesSub   = null; } } catch {}
  try { if (roundsSub)  { supabase.removeChannel(roundsSub);  roundsSub  = null; } } catch {}
  try { if (roomsSub)   { supabase.removeChannel(roomsSub);   roomsSub   = null; } } catch {}
}

export async function refreshRoomState() {
  if (!state.currentRoomId) {
    console.log('No currentRoomId, skipping refresh');
    return;
  }
  // гарантируем подписки на события комнаты
  resubscribeRoomRealtime();
  
  console.log('Refreshing room state for room:', state.currentRoomId);
  console.log("refreshRoomState: state.currentRoundId =", state.currentRoundId);
  
  const { data: players, error: playersError } = await supabase
    .from('room_players').select('player_id, nickname, score, is_host, is_active, last_seen_at')
    .eq('room_id', state.currentRoomId)
    .order('score', { ascending: false });
  // fallback повторный запрос, если первый вдруг вернул пусто при наличии кеша
  if ((!players || players.length === 0) && Object.keys(state.roomPlayersCache || {}).length > 0) {
    try {
      const retry = await supabase
        .from('room_players').select('player_id, nickname, score, is_host, is_active, last_seen_at')
        .eq('room_id', state.currentRoomId)
        .order('score', { ascending: false });
      if (retry?.data) {
        // eslint-disable-next-line no-unused-vars
      }
    } catch {}
  }
    
  console.log('Players query result:', { players, playersError });
    
  const { data: roomInfo, error: roomError } = await supabase
    .from('rooms').select('status, owner_id, target_score, question_seconds, question_source').eq('id', state.currentRoomId).single();
    
  console.log('Room info query result:', { roomInfo, roomError });
    
  const { data: rounds } = await supabase
    .from('rounds')
    .select('id, phase, question_id, author_id, compose_deadline, question_text, started_at, ended_at')
    .eq('room_id', state.currentRoomId).order('started_at', { ascending: false }).limit(1);
  const latest = rounds?.[0] || null;
  const prevRoundId = state.currentRoundId;
  state.currentRoundId = latest?.id || null;
  if (state.currentRoundId && state.currentRoundId !== prevRoundId) {
    // Сброс локальных флагов при переходе на новый раунд (для всех клиентов)
    state.mySubmitted = false;
    state.myVoted = false;
    state.selectedAnswerId = null;
    const container = el('answers-list'); if (container) container.innerHTML = '';
    resubscribeAnswersRealtime();   // подписка на ответы текущего раунда
    resubscribeVotesRealtime();     // подписка на голоса текущего раунда
  }
  // Гарантируем подписки, если roundId уже был установлен ранее (случай хоста)
  if (state.currentRoundId) {
    if (!answersSub) resubscribeAnswersRealtime();
    if (!votesSub) resubscribeVotesRealtime();
  }
  const isLobby = (roomInfo?.status === 'lobby') || (!roomInfo && !latest);
  let questionText = latest?.question_text || '';
  if (!questionText && latest?.question_id) {
    const { data: q } = await supabase.from('questions').select('text').eq('id', latest.question_id).single();
    questionText = q?.text || '';
  }
  const roomStateEl = el('room-state');
  if (roomStateEl) {
    // Скрываем строку "Players:", чтобы не дублировать "Игроки:"
    roomStateEl.innerHTML = '';
  }

  // Обновляем код фазы
  const phaseCode2 = el('phase-code-2');
  if (phaseCode2) phaseCode2.textContent = latest ? latest.phase : '—';

  // Подставляем текущее значение порога очков в лобби
  try {
    const ti = document.getElementById('target-score');
    if (ti) {
      if (!ti.dataset._init) {
        ti.addEventListener('input', () => { ti.dataset.dirty = '1'; });
        ti.dataset._init = '1';
      }
      if (roomInfo) {
        const dbVal = Number(roomInfo.target_score || 0);
        const isDirty = ti.dataset.dirty === '1';
        if (!isDirty && document.activeElement !== ti && dbVal > 0) {
          ti.value = String(dbVal);
        }
      }
    }
  } catch {}

  // Подставляем время на вопрос из БД с защитой от перезаписи пользовательского ввода
  try {
    const qs = document.getElementById('question-seconds');
    if (qs) {
      if (!qs.dataset._init) {
        ['input','change'].forEach(ev => qs.addEventListener(ev, () => { qs.dataset.dirty = '1'; }));
        qs.dataset._init = '1';
      }
      if (roomInfo) {
        const dbVal = Number(roomInfo.question_seconds || 0);
        const isDirty = qs.dataset.dirty === '1';
        if (!isDirty && document.activeElement !== qs && dbVal > 0) {
          qs.value = String(dbVal);
        }
      }
    }
  } catch {}

  // Подставляем источник вопросов
  try {
    const rbPreset = document.getElementById('qsrc-preset');
    const rbPlayers = document.getElementById('qsrc-players');
    const rowQS = document.getElementById('row-question-seconds');
    if (rbPreset && !rbPreset.dataset._init) {
      ['change','input','click'].forEach(ev =>
        rbPreset.addEventListener(ev, () => { rbPreset.dataset.dirty='1'; if (rbPlayers) rbPlayers.dataset.dirty='1'; if (rowQS) rowQS.classList.add('hidden'); })
      );
      rbPreset.dataset._init = '1';
    }
    if (rbPlayers && !rbPlayers.dataset._init) {
      ['change','input','click'].forEach(ev =>
        rbPlayers.addEventListener(ev, () => { if (rbPreset) rbPreset.dataset.dirty='1'; rbPlayers.dataset.dirty='1'; if (rowQS) rowQS.classList.remove('hidden'); })
      );
      rbPlayers.dataset._init = '1';
    }

    const isDirty = (rbPreset?.dataset.dirty === '1' || rbPlayers?.dataset.dirty === '1');
    if (roomInfo?.question_source && rbPreset && rbPlayers && !isDirty && document.activeElement?.name !== 'qsrc') {
      rbPreset.checked  = roomInfo.question_source === 'preset';
      rbPlayers.checked = roomInfo.question_source === 'players';
      if (rowQS) rowQS.classList.toggle('hidden', roomInfo.question_source !== 'players');
    }
  } catch {}

  // Режим players: фаза придумывания вопроса
  const composeMsg = el('compose-message');
  const composeTimer = el('compose-timer');
  const composeRowMsg = document.getElementById('compose-row-message');
  const composeRowInput = document.getElementById('compose-row-input');
  // reset compose UI
  if (composeRowMsg) composeRowMsg.classList.add('hidden');
  if (composeRowInput) composeRowInput.classList.add('hidden');

  // Обновляем текст вопроса над полем ответа
  const qText = el('question-text');
  if (qText) qText.textContent = questionText || '—';

  // Фиксация фазы и поведение UI по фазам
  const prevPhase = state.currentPhase;
  state.currentPhase = latest?.phase || null;
  // На входе в answering сбрасываем локальные флаги и гарантируем показ инпута
  if (state.currentPhase === 'answering' && prevPhase !== 'answering') {
    state.mySubmitted = false;
    state.myVoted = false;
    state.selectedAnswerId = null;
    const answerInputOnEnter = el('answer-text'); if (answerInputOnEnter) answerInputOnEnter.classList.remove('hidden');
    const submitBtnOnEnter = el('submit-answer'); if (submitBtnOnEnter) submitBtnOnEnter.classList.remove('hidden');
    // Переподписка на ответы/голоса для надёжности, если roundId уже известен
    try { if (state.currentRoundId) { resubscribeAnswersRealtime(); resubscribeVotesRealtime(); } } catch {}
  }
  // Предварительно узнаём, проголосовал ли текущий пользователь (чтобы не мигал UI)
  if (state.currentPhase === 'voting' && state.currentRoundId) {
    try {
      const { data: vEarly } = await supabase
        .from('votes')
        .select('voter_id')
        .eq('round_id', state.currentRoundId);
      const votedEarlyMap = new Map((vEarly || []).map(v => [v.voter_id, true]));
      const myIdEarly = state.currentUser?.id;
      if (myIdEarly) state.myVoted = !!votedEarlyMap.get(myIdEarly);
    } catch {}
  }
  // Узнаем, ответил ли текущий пользователь
  let myAnswered = false;
  try {
    if (state.currentPhase === 'answering' && state.currentRoundId && state.currentUser?.id) {
      const { data: myAns } = await supabase
        .from('answers')
        .select('id')
        .eq('round_id', state.currentRoundId)
        .eq('author_id', state.currentUser.id)
        .maybeSingle();
      myAnswered = !!myAns;
    }
  } catch {}
  if (state.mySubmitted) myAnswered = true;
  if (state.currentPhase === 'voting') {
    // Показать список ответов и кнопку голосования только во время голосования
    const answersContainer = el('answers-list');
    if (answersContainer) answersContainer.classList.remove('hidden');
    const voteBtn = el('vote');
    if (voteBtn) {
      voteBtn.classList.toggle('hidden', !!state.myVoted);
      voteBtn.disabled = !!state.myVoted;
    }
    // Скрыть ввод ответа во время голосования
    const answerInput = el('answer-text'); if (answerInput) answerInput.classList.add('hidden');
    const submitBtn = el('submit-answer'); if (submitBtn) submitBtn.classList.add('hidden');
    // Кнопка следующего раунда в голосовании скрыта
    const nextBtnVoting = el('next-round'); if (nextBtnVoting) nextBtnVoting.classList.add('hidden');
    // Загружаем варианты только на входе в фазу
    if (prevPhase !== 'voting') {
      try { await loadAnswers(); } catch (e) { console.error('loadAnswers on voting phase failed:', e); }
    }
    // На каждом обновлении: восстановить выбор и применить disabled по myVoted
    const contNow = el('answers-list');
    if (contNow) {
      const prevSel = state.selectedAnswerId || (contNow.querySelector('input[name="vote-answer"]:checked')?.value || null);
      if (prevSel) {
        const node = contNow.querySelector(`input[name="vote-answer"][value="${prevSel}"]`);
        if (node) node.checked = true;
      }
      contNow.querySelectorAll('input[name="vote-answer"]').forEach(inp => { inp.disabled = !!state.myVoted; });
      contNow.classList.toggle('muted', !!state.myVoted);
    }
  } else if (state.currentPhase === 'results') {
    // Показать результаты: ответы с количеством голосов (🔥)
    const answersContainer = el('answers-list');
    if (answersContainer) answersContainer.classList.remove('hidden');
    const voteBtn = el('vote'); if (voteBtn) { voteBtn.classList.add('hidden'); voteBtn.disabled = true; }
    const answerInput = el('answer-text'); if (answerInput) answerInput.classList.add('hidden');
    const submitBtn = el('submit-answer'); if (submitBtn) submitBtn.classList.add('hidden');
    // Загружаем результаты только на входе в фазу results
    if (prevPhase !== 'results') {
      try {
        const { data: ans } = await supabase.from('answers').select('id, text, author_id').eq('round_id', state.currentRoundId);
        const { data: votesAll } = await supabase.from('votes').select('answer_id').eq('round_id', state.currentRoundId);
        const counts = new Map();
        (votesAll || []).forEach(v => counts.set(v.answer_id, (counts.get(v.answer_id) || 0) + 1));
        const container = el('answers-list');
        if (container) {
          container.innerHTML = '';
          const wrap = document.createElement('div');
          (ans || []).forEach(a => {
            const flames = '🔥'.repeat(counts.get(a.id) || 0);
            const row = document.createElement('div');
            row.textContent = `${a.text} ${flames}`.trim();
            wrap.appendChild(row);
          });
          container.appendChild(wrap);
        }
      } catch (e) { console.error('render results failed:', e); }
    }
    // Проверка победителя по целевому числу очков
    let winner = null;
    try {
  const { data: rp } = await supabase
        .from('room_players')
        .select('player_id, nickname, score, is_host')
        .eq('room_id', state.currentRoomId)
        .order('score', { ascending: false });
      const targetScore = Number(roomInfo?.target_score || 0);
      if (targetScore > 0 && (rp || []).length) {
        const maxScore = Math.max(...(rp || []).map(r => Number(r.score || 0)));
        if (maxScore >= targetScore) {
          winner = (rp || []).find(r => Number(r.score || 0) === maxScore) || null;
        }
      }
    } catch {}
    const banner = el('winner-banner');
    const nextBtn = el('next-round');
    const endBtn = el('end-game');
    if (winner && banner) {
      banner.classList.remove('hidden');
      banner.textContent = `Победил игрок ${winner.nickname}`;
      if (nextBtn) nextBtn.classList.add('hidden');
      if (endBtn) endBtn.classList.remove('hidden');
    } else {
      if (banner) { banner.classList.add('hidden'); banner.textContent = ''; }
      // Кнопка следующего раунда: только хосту
      if (nextBtn) nextBtn.classList.toggle('hidden', !state.isHost);
      if (endBtn) endBtn.classList.add('hidden');
    }
  } else {
    // В других фазах очищаем и скрываем варианты, показ ввода зависит от myAnswered
    const container = el('answers-list');
    if (container) { container.innerHTML = ''; container.classList.add('hidden'); }
    const voteBtn = el('vote');
    if (voteBtn) { voteBtn.classList.add('hidden'); voteBtn.disabled = true; }
    // В других фазах скрываем кнопку следующего раунда
    const nextBtnOther = el('next-round'); if (nextBtnOther) nextBtnOther.classList.add('hidden');
    const answerInput = el('answer-text');
    const submitBtn = el('submit-answer');
    if (state.currentPhase === 'answering') {
      // Показываем поле всем, кто ещё не отправил ответ; если уже отправил — скрыто
      if (answerInput) answerInput.classList.remove('hidden');
      if (submitBtn) submitBtn.classList.remove('hidden');
      if (myAnswered) {
        if (answerInput) answerInput.classList.add('hidden');
        if (submitBtn) submitBtn.classList.add('hidden');
      }
    } else {
      if (answerInput) answerInput.classList.add('hidden');
      if (submitBtn) submitBtn.classList.add('hidden');
    }
  }

  // Глобальная проверка победителя (на случай, если фаза не results)
  try {
    if (targetScore > 0 && (rp || []).length) {
      const maxScore = Math.max(...(rp || []).map(r => Number(r.score || 0)));
      const winnerNow = (rp || []).find(r => Number(r.score || 0) === maxScore && maxScore >= targetScore) || null;
      const banner2 = el('winner-banner');
      const nextBtn2 = el('next-round');
      const endBtn2 = el('end-game');
      if (winnerNow && banner2) {
        banner2.classList.remove('hidden');
        banner2.textContent = `Победил игрок ${winnerNow.nickname}`;
        if (nextBtn2) nextBtn2.classList.add('hidden');
        if (endBtn2) endBtn2.classList.remove('hidden');
      }
    }
  } catch {}

  // players/composing UI
  if (roomInfo?.question_source === 'players' && latest?.phase === 'composing') {
    const isAuthor = latest.author_id && latest.author_id === state.currentUser?.id;
    if (composeRowMsg) composeRowMsg.classList.remove('hidden');
    if (composeMsg) composeMsg.textContent = isAuthor ? 'Придумайте вопрос'
      : `Игрок ${(players||[]).find(p=>p.player_id===latest.author_id)?.nickname || '—'} придумывает вопрос`;
    if (isAuthor && composeRowInput) composeRowInput.classList.remove('hidden');

    const deadlineMs = latest.compose_deadline ? Date.parse(latest.compose_deadline) : Date.now();
    const renderTimer = () => {
      const left = Math.max(0, Math.ceil((deadlineMs - Date.now())/1000));
      if (composeTimer) composeTimer.textContent = String(left).padStart(2,'0');
      return left;
    };
    renderTimer();
    try { if (state._composeTimerId) clearInterval(state._composeTimerId); } catch {}
    state._composeTimerId = setInterval(() => {
      const left = renderTimer();
      if (left <= 0) { clearInterval(state._composeTimerId); }
    }, 250);

    // Таймаут → fallback (только у хоста)
    if (state.isHost && deadlineMs <= Date.now() && !latest.question_text) {
      const { data: q } = await supabase.rpc('pick_question');
      const qid = q?.[0]?.id || null;
      await supabase.from('rounds')
        .update({ question_id: qid, phase: 'answering', question_source: 'preset' })
        .eq('id', state.currentRoundId);
    }
  }

  // Если комната вышла из лобби — переключаем всех на шаг 4 (раунды)
  if (!isLobby) {
    if (state.autoJumpToRound) import('./state.js').then(({ showStep }) => showStep(4));
  }

  // Обновление списков игроков (лобби и раунд)
  // Debug: ensure we see actual players payload right before render
  console.log("Players query result:", players, playersError);
  console.log('Lobby check:', { isLobby, roomStatus: roomInfo?.status, playersCount: players?.length });

  // Fallback список: всегда показываем текущего игрока
  const fallbackPlayers = [];
  if (state.currentUser && state.nickname) {
    fallbackPlayers.push({
      player_id: state.currentUser.id,
      nickname: state.nickname,
      score: 0,
      is_host: state.isHost
    });
  }

  // Работаем с активными игроками для логики фаз
  // Объединяем БД и локальный кеш, чтобы все клиенты видели полный список
  const cachePlayers = Object.values(state.roomPlayersCache || {});
  const mergeMap = new Map();
  for (const p of (players || [])) {
    mergeMap.set(p.player_id, { ...p });
  }
  for (const p of cachePlayers) {
    const existed = mergeMap.get(p.player_id) || {};
    mergeMap.set(p.player_id, {
      player_id: p.player_id,
      nickname: p.nickname ?? existed.nickname,
      // критично: доверяем БД приоритетно, кеш лишь дополняет
      score: (typeof existed.score === 'number') ? existed.score : (p.score ?? 0),
      is_host: (typeof existed.is_host === 'boolean') ? existed.is_host : !!p.is_host,
      is_active: (typeof existed.is_active === 'boolean') ? existed.is_active : (p.is_active !== false),
      last_seen_at: existed.last_seen_at || p.last_seen_at || null
    });
  }
  const mergedPlayers = Array.from(mergeMap.values());
  const activePlayers = mergedPlayers.filter(p => p.is_active);
  const listToRender = mergedPlayers.length > 0 ? mergedPlayers : fallbackPlayers;
  // Стабильная сортировка игроков: по очкам (desc), затем по нику (asc)
  const sortedPlayers = listToRender.slice().sort((a, b) => {
    const sa = Number(a.score || 0);
    const sb = Number(b.score || 0);
    if (sa !== sb) return sb - sa;
    const na = (a.nickname || '').toString();
    const nb = (b.nickname || '').toString();
    return na.localeCompare(nb);
  });
  const playersCount = (players || []).length;
  const activeCount = activePlayers.length;

  // Галочки: в answering — за отправку ответа; в voting — за совершённый голос
  let submittedMap = new Map();
  let votedMap = new Map();
  try {
    if (state.currentRoundId && latest?.phase === 'answering') {
      const { data: submitted } = await supabase
        .from('answers')
        .select('author_id')
        .eq('round_id', state.currentRoundId);
      submittedMap = new Map((submitted || []).map(a => [a.author_id, true]));
    }
    if (state.currentRoundId && latest?.phase === 'voting') {
      const { data: votes } = await supabase
        .from('votes')
        .select('voter_id')
        .eq('round_id', state.currentRoundId);
      votedMap = new Map((votes || []).map(v => [v.voter_id, true]));
    }
  } catch {}

  // В фазе голосования синхронизируем локальный флаг проголосовал/нет
  if (state.currentPhase === 'voting') {
    const myId = state.currentUser?.id;
    if (myId) state.myVoted = !!votedMap.get(myId);
  }

  // рендерим списки игроков: в лобби и в раунде (если есть оба)
  const targets = ['players-list', 'players-list-round'];
  for (const id of targets) {
    const ul = document.getElementById(id);
    if (!ul) continue;
    ul.innerHTML = '';
    try { ul.style.listStyleType = 'decimal'; } catch {}
    sortedPlayers.forEach((p) => {
      const li = document.createElement('li');
      const score = Number(p.score ?? 0);
      const markAnswered = submittedMap.get(p.player_id);
      const markVoted = votedMap.get(p.player_id);
      const check = (markAnswered || markVoted) ? ' ✅' : '';
      const afk = p.is_active === false ? ' (AFK)' : '';
      li.textContent = `${p.nickname}${p.is_host ? ' ⭐' : ''}${check}${afk} — очки: ${score}`;
      ul.appendChild(li);
    });
  }

  // Если пользователь уже проголосовал, скрываем кнопку и блокируем радио, и показываем "Голос учтён"
  if (state.currentPhase === 'voting' && state.myVoted) {
    const voteBtn2 = el('vote'); if (voteBtn2) { voteBtn2.classList.add('hidden'); voteBtn2.disabled = true; }
    const cont = el('answers-list');
    if (cont) {
      cont.classList.add('muted');
      cont.querySelectorAll('input[name="vote-answer"]').forEach(inp => { inp.disabled = true; });
    }
    const rs2 = el('round-state'); if (rs2) rs2.textContent = 'Голос учтён.';
  }
  // В остальных случаях очищаем строку статуса, чтобы она не висела постоянно
  if (!(state.currentPhase === 'voting' && state.myVoted)) {
    const rs3 = el('round-state'); if (rs3) rs3.textContent = '';
  }

  // Автопереход к голосованию: когда все ожидаемые игроки отправили ответ
  try {
    if (state.isHost && latest && latest.phase === 'answering') {
      const respondents = (roomInfo?.question_source === 'players') ? (listToRender || []) : activePlayers;
      if (respondents.length > 0) {
        const allAnswered = respondents.every(p => submittedMap.get(p.player_id));
        if (allAnswered) {
          await startVoting();
        }
      }
    }
  } catch (e) { console.error('Auto startVoting failed:', e); }

  // --- Авто-финализация: проголосовали все УЧАСТНИКИ (авторы ответов) ---
  try {
    if (latest?.phase === 'voting' && state.currentRoundId) {
      const [{ data: votes }, { data: ans }] = await Promise.all([
        supabase.from('votes').select('voter_id').eq('round_id', state.currentRoundId),
        supabase.from('answers').select('author_id').eq('round_id', state.currentRoundId)
      ]);
      const voters = new Set((votes || []).map(v => v.voter_id));
      const participants = new Set((ans || []).map(a => a.author_id));
      const amIHost = (players || []).some(p => p.player_id === state.currentUser?.id && p.is_host);
      if (participants.size > 0 && voters.size >= participants.size && amIHost && !state.finalizing) {
        await finalize();
      }
    }
  } catch (e) { console.error('Auto finalize failed:', e); }

  // Сброс UI победителя и кнопок при новом раунде/новой игре
  try {
    const banner0 = el('winner-banner');
    const next0 = el('next-round');
    const end0 = el('end-game');
    // если целевой порог не достигнут и фаза не results — скрыть баннер/кнопку завершения
    if (!(targetScore > 0 && (rp || []).some(r => Number(r.score||0) >= targetScore)) && state.currentPhase !== 'results') {
      if (banner0) { banner0.classList.add('hidden'); banner0.textContent = ''; }
      if (end0) end0.classList.add('hidden');
      if (next0) next0.classList.add('hidden');
    }
  } catch {}

  // Показ панели админа (кнопка начала игры) только для хоста
  const lobbyAdmin = el('lobby-admin');
  console.log('Lobby admin element found:', !!lobbyAdmin);
  console.log('Current user:', state.currentUser?.id);
  
  if (lobbyAdmin && state.currentUser) {
    const currentUserPlayer = (players || []).find(p => p.player_id === state.currentUser.id);
    // Хост определяется по owner_id / room_players / state.isHost (fallback)
    const isHost = (roomInfo?.owner_id === state.currentUser.id) || (currentUserPlayer && currentUserPlayer.is_host) || state.isHost;
    
    console.log('Host check detailed:', { 
      currentUserPlayer, 
      isHost, 
      userId: state.currentUser?.id, 
      isLobby,
      allPlayers: players 
    });
    
    // Show admin panel if user is host (независимо от статуса комнаты)
    if (isHost) {
      lobbyAdmin.classList.remove('hidden');
      console.log('Showing admin panel for host');
    } else {
      lobbyAdmin.classList.add('hidden');
      console.log('Hiding admin panel - user is not host');
    }
  } else {
    console.log('Cannot check host status:', { 
      hasLobbyAdmin: !!lobbyAdmin, 
      hasCurrentUser: !!state.currentUser 
    });
  }
}

export async function startRound() {
  if (!state.currentRoomId) return alert('Сначала комната');
  let qid = null;
  const { data: cfg } = await supabase
    .from('rooms').select('question_source, question_seconds').eq('id', state.currentRoomId).single();
  if ((cfg?.question_source || 'preset') === 'players') {
    const [{ data: players }, { count }] = await Promise.all([
      supabase.from('room_players')
        .select('player_id, nickname, joined_at')
        .eq('room_id', state.currentRoomId)
        .order('joined_at', { ascending: true }),
      supabase.from('rounds')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', state.currentRoomId)
    ]);
    const order = players || [];
    const idx = Number(count || 0) % (order.length || 1);
    const authorId = order[idx]?.player_id;
    const deadline = new Date(Date.now() + (Number(cfg?.question_seconds || 60) * 1000)).toISOString();
    const { data: round, error: e2 } = await supabase
      .from('rounds')
      .insert({ room_id: state.currentRoomId, phase: 'composing', question_source: 'players',
                author_id: authorId, compose_deadline: deadline })
      .select().single();
    if (e2) return alert(e2.message);
    state.currentRoundId = round.id;
    await refreshRoomState();
    return;
  }
  if ((cfg?.question_source || 'preset') === 'preset') {
    const { data: q, error } = await supabase.rpc('pick_question');
    if (error || !q?.length) return alert('Нет вопросов');
    qid = q[0].id;
  } else {
    return alert('Неизвестный режим вопросов');
  }
  const btnNext = el('next-round'); if (btnNext) btnNext.disabled = true;
  try {
    const { data: round, error: e2 } = await supabase
      .from('rounds').insert({ room_id: state.currentRoomId, question_id: qid, phase: 'answering', question_source: cfg?.question_source || 'preset' })
      .select().single();
    if (e2) return alert(e2.message);
    state.currentRoundId = round.id;
    state.mySubmitted = false;
    // Сброс клиентских флагов для нового раунда
    state.myVoted = false;
    state.selectedAnswerId = null;
    const container = el('answers-list'); if (container) container.innerHTML = '';
    try { await supabase.from('rooms').update({ status: 'in_progress' }).eq('id', state.currentRoomId); } catch {}
    // Широковещательный сигнал о старте раунда, чтобы у всех показалось поле ввода
    try {
      if (state.roomChannel) {
        state.roomChannel.send({ type: 'broadcast', event: 'round_started', payload: { round_id: state.currentRoundId } });
      }
    } catch {}
    await refreshRoomState();
  } finally {
    if (btnNext) btnNext.disabled = false;
  }
}

export async function submitAnswer() {
  console.log('[submitAnswer] click');
  if (!state.currentRoundId) { alert('Раунд не начат'); return; }
  console.log('[submitAnswer] roundId=', state.currentRoundId);
  const input = el('answer-text');
  if (!input) { alert('Поле ответа не найдено'); return; }
  const text = input.value.trim();
  if (!text) { alert('Введите ответ'); return; }

  // гарантия user.id
  let uid = state.currentUser?.id || null;
  if (!uid) {
    const { data: g } = await supabase.auth.getUser();
    uid = g?.user?.id || null;
    if (!uid) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) { alert('Auth error: ' + error.message); return; }
      uid = data.user.id;
    }
    state.currentUser = { id: uid };
  }
  console.log('[submitAnswer] uid=', uid);

  const btn = el('submit-answer');
  if (btn) btn.disabled = true;
  try {
    console.log('[submitAnswer] inserting answer...');
    const { error } = await supabase.from('answers').insert({
      round_id: state.currentRoundId,
      author_id: uid,
      text
    });
    if (error) {
      const msg = String(error.message || '').toLowerCase();
      const code = String(error.code || '');
      const isDuplicate = msg.includes('duplicate') || msg.includes('conflict') || code === '23505';
      if (isDuplicate) {
        console.warn('[submitAnswer] duplicate detected (already submitted)');
        state.mySubmitted = true;
        await refreshRoomState();
        return;
      }
      alert(error.message);
      return;
    }
    console.log('[submitAnswer] inserted successfully');
    input.value = '';
    state.mySubmitted = true;
    // Оповещаем других участников комнаты о новом ответе
    try {
      if (state.roomChannel) {
        state.roomChannel.send({ type: 'broadcast', event: 'answer_submitted', payload: { round_id: state.currentRoundId } });
      }
    } catch {}
    await refreshRoomState();
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function startVoting() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const { error } = await supabase.from('rounds').update({ phase: 'voting' }).eq('id', state.currentRoundId);
  if (error) return alert(error.message);
  await refreshRoomState();
  // Автоматически подгружаем ответы для голосования
  try {
    await loadAnswers();
  } catch (e) { console.error('Auto load answers failed:', e); }
}

export async function loadAnswers() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const prevSelected =
    state.selectedAnswerId ||
    (document.querySelector('input[name="vote-answer"]:checked')?.value || null);

  const { data: ans, error } = await supabase
    .from('answers')
    .select('id, text, author_id')
    .eq('round_id', state.currentRoundId);
  if (error) return alert(error.message);
  const container = el('answers-list');
  if (container) {
    container.innerHTML = '';
    const ul = document.createElement('div');
    (ans || []).forEach(a => {
      const li = document.createElement('div');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'vote-answer';
      input.value = a.id;
      input.checked = (a.id === prevSelected);
      input.addEventListener('change', () => { state.selectedAnswerId = a.id; });
      li.appendChild(input);
      li.appendChild(document.createTextNode(' ' + a.text));
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }
}

export async function submitCustomQuestion() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const text = (el('custom-question')?.value || '').trim();
  if (!text) return alert('Введите вопрос');
  await supabase.from('rounds')
    .update({ question_text: text, phase: 'answering' })
    .eq('id', state.currentRoundId);
  const inp = el('custom-question'); if (inp) inp.value = '';
  await refreshRoomState();
}

export async function vote() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const checked = document.querySelector('input[name="vote-answer"]:checked');
  const ansId = checked ? checked.value : '';
  if (!ansId) return alert('Выберите ответ');
  const { error } = await supabase.from('votes').insert({
    round_id: state.currentRoundId, voter_id: state.currentUser.id, answer_id: ansId
  });
  if (error) return alert(error.message);
  const rs = el('round-state'); if (rs) rs.textContent = 'Голос учтён.';
  // Локально помечаем, что игрок проголосовал; не скрываем варианты
  state.myVoted = true;
  // Оповещаем комнату о новом голосе, чтобы обновился UI у всех, в т.ч. у хоста
  try {
    if (state.roomChannel) {
      state.roomChannel.send({ type: 'broadcast', event: 'vote_submitted', payload: { round_id: state.currentRoundId } });
    }
  } catch {}
  // Отключаем радиокнопки и скрываем кнопку голосования у проголосовавшего
  const container = el('answers-list');
  if (container) {
    container.classList.add('muted');
    container.querySelectorAll('input[name="vote-answer"]').forEach(inp => {
      inp.disabled = true;
    });
  }
  const voteBtn = el('vote'); if (voteBtn) { voteBtn.classList.add('hidden'); voteBtn.disabled = true; }
  // Обновим состояние, чтобы появилась галочка у проголосовавшего
  await refreshRoomState();
}

export async function finalize() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const btn = el('finalize'); if (btn) btn.disabled = true;
  try {
    const { error } = await supabase.rpc('finalize_round', { p_round_id: state.currentRoundId });
    if (error) throw error;
  } catch (e) {
    alert(e?.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
  await refreshRoomState();
}
import { supabase } from './supabaseClient.js';
import { state, el } from './state.js';

let answersSub = null;
let roundsSub = null;
let roomsSub = null;
let votesSub = null;
let playersSub = null;

// Детеминированная случайная перестановка по seed (одинаковая для всех в раунде)
function seed32(s){ let h = 2166136261; for (const c of String(s||'')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(a){ return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function shuffleSeeded(arr, seed){ const r = rng(seed32(seed)); const out = arr.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }

// Автоподача голоса при таймауте, если пользователь выбрал вариант, но не нажал кнопку
async function autoSubmitPendingVote() {
  try {
    if (!state.currentRoundId) return;
    if (state.myVoted) return;
    const checkedBtn = document.querySelector('.vote-option[aria-checked="true"]');
    const ansId = state.selectedAnswerId || (checkedBtn ? checkedBtn.dataset.answerId : '');
    if (!ansId) return;
    let uid = state.currentUser?.id || null;
    if (!uid) {
      try {
        const { data: g } = await supabase.auth.getUser();
        uid = g?.user?.id || null;
        if (!uid) {
          const { data, error } = await supabase.auth.signInAnonymously();
          if (!error) uid = data?.user?.id || null;
        }
        if (uid && !state.currentUser) state.currentUser = { id: uid };
      } catch {}
    }
    if (!uid) return;
    try {
      await supabase.from('votes').insert({ round_id: state.currentRoundId, voter_id: uid, answer_id: ansId });
      state.myVoted = true;
    } catch {}
  } catch {}
}
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
  if (playersSub) { try { await supabase.removeChannel(playersSub); } catch {} }
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

  // Подписка на обновления очков игроков
  playersSub = supabase
    .channel(`room-players-${state.currentRoomId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'room_players',
      filter: `room_id=eq.${state.currentRoomId}`
    }, () => {
      refreshRoomState();
    })
    .subscribe();
}

export function cleanupSubscriptions() {
  try { if (answersSub) { supabase.removeChannel(answersSub); answersSub = null; } } catch {}
  try { if (votesSub)   { supabase.removeChannel(votesSub);   votesSub   = null; } } catch {}
  try { if (roundsSub)  { supabase.removeChannel(roundsSub);  roundsSub  = null; } } catch {}
  try { if (roomsSub)   { supabase.removeChannel(roomsSub);   roomsSub   = null; } } catch {}
  try { if (playersSub) { supabase.removeChannel(playersSub); playersSub = null; } } catch {}
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
  // Загружаем информацию о комнате (roomInfo)
  const { data: roomInfo, error: roomError } = await supabase
    .from('rooms')
    .select('id, owner_id, status, target_score, question_seconds, vote_seconds, question_source')
    .eq('id', state.currentRoomId)
    .single();
  console.log('Room info query result:', { roomInfo, roomError });
  // Определяем хоста для авто-действий по данным room_players
  const amIHost = (players || []).some(p => p.player_id === state.currentUser?.id && p.is_host);
  
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
    // Очистка поля ответа при начале нового раунда
    const answerInputNewRound = el('answer-text'); if (answerInputNewRound) answerInputNewRound.value = '';
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
  // Лобби: показать ожидание старта всем, кроме хоста
  try {
    const waitRow = document.getElementById('lobby-wait-row');
    const dots = document.getElementById('lobby-wait-dots');
    const hostNickEl = document.getElementById('host-nick-wait');
    if (waitRow) {
      const showWait = isLobby && !amIHost;
      waitRow.classList.toggle('hidden', !showWait);
      if (showWait && hostNickEl) {
        const hostPlayer = (players || []).find(p => p.is_host);
        hostNickEl.textContent = hostPlayer?.nickname || 'хост';
      }
      if (showWait && dots && !state._waitDotsTimer) {
        let n = 0;
        const render = () => { n = (n + 1) % 4; dots.textContent = '.'.repeat(n); };
        render();
        state._waitDotsTimer = setInterval(render, 500);
      } else if ((!showWait || !dots) && state._waitDotsTimer) {
        clearInterval(state._waitDotsTimer); state._waitDotsTimer = null; if (dots) dots.textContent = '';
      }
    }
  } catch {}

  // Обновляем код/лейбл фазы
  const phaseCode2 = el('phase-code-2');
  const phaseLabel = document.getElementById('phase-label');
  const phaseName = latest ? latest.phase : null;
  if (phaseCode2) phaseCode2.textContent = '';
  if (phaseLabel) {
    // Человекочитаемые подписи. Для answering/voting/results рендерим ниже специализировано, чтобы не мигало
    if (phaseName === 'answering' || phaseName === 'voting' || phaseName === 'results') {
      // Ничего здесь не перерисовываем — предотвратить перезапись и мигание
    } else {
      let labelText = '';
      if (phaseName === 'composing') labelText = 'Придумывание вопроса.';
      phaseLabel.innerHTML = labelText;
    }
  }

  // Подставляем текущее значение порога очков в лобби
  try {
    const ti = document.getElementById('target-score');
    if (ti) {
      if (!ti.dataset._init) {
        ti.addEventListener('input', () => { ti.dataset.dirty = '1'; });
        ti.addEventListener('change', () => {
          const val = Math.min(99, Math.max(1, Number(ti.value || 0)));
          ti.value = String(val);
        });
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
        qs.addEventListener('change', () => {
          const val = Math.min(999, Math.max(1, Number(qs.value || 0)));
          qs.value = String(val);
        });
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

  // Подставляем время на голосование из БД с защитой от перезаписи пользовательского ввода
  try {
    const vs = document.getElementById('vote-seconds');
    if (vs) {
      if (!vs.dataset._init) {
        ['input','change'].forEach(ev => vs.addEventListener(ev, () => { vs.dataset.dirty = '1'; }));
        vs.addEventListener('change', () => {
          const val = Math.min(999, Math.max(1, Number(vs.value || 0)));
          vs.value = String(val);
        });
        vs.dataset._init = '1';
      }
      if (roomInfo) {
        const dbVal = Number(roomInfo.vote_seconds || 0);
        const isDirty = vs.dataset.dirty === '1';
        if (!isDirty && document.activeElement !== vs && dbVal > 0) {
          vs.value = String(dbVal);
        }
      }
    }
  } catch {}

  // Подставляем источник вопросов
  try {
    const srcSelect = document.getElementById('qsrc-select');
    const rowQS = document.getElementById('row-question-seconds');
    if (srcSelect && !srcSelect.dataset._init) {
      ['change','input','click'].forEach(ev =>
        srcSelect.addEventListener(ev, () => { srcSelect.dataset.dirty='1'; /* question-seconds виден всегда */ })
      );
      srcSelect.dataset._init = '1';
    }
    const isDirty = (srcSelect?.dataset.dirty === '1');
    if (roomInfo?.question_source && srcSelect && !isDirty) {
      srcSelect.value = roomInfo.question_source === 'players' ? 'players' : 'preset';
      if (rowQS) rowQS.classList.remove('hidden');
    }
  } catch {}

  // Режим players: фаза придумывания вопроса
  const composeMsg = el('compose-message');
  const composeTimer = el('compose-timer');
  const composeRowMsg = document.getElementById('compose-row-message');
  const composeRowInput = document.getElementById('compose-row-input');
  const answeringRow = document.getElementById('answering-row-message');
  const answeringTimer = document.getElementById('answering-timer');
  // reset compose UI (answering timer не скрываем, если сейчас answering)
  if (composeRowMsg) composeRowMsg.classList.add('hidden');
  if (composeRowInput) composeRowInput.classList.add('hidden');
  if (answeringRow) answeringRow.classList.add('hidden');

  // Обновляем текст вопроса над полем ответа
  const qText = el('question-text');
  if (qText) qText.textContent = questionText || '';

  // Фиксация фазы и поведение UI по фазам
  const prevPhase = state.currentPhase;
  state.currentPhase = latest?.phase || null;
  // На входе в answering сбрасываем локальные флаги и гарантируем показ инпута
  if (state.currentPhase === 'answering' && prevPhase !== 'answering') {
    state.mySubmitted = false;
    state.myVoted = false;
    state.selectedAnswerId = null;
    const answerInputOnEnter = el('answer-text');
    if (answerInputOnEnter) {
      // Очистка поля при входе в answering новой фазы
      try { answerInputOnEnter.value = ''; } catch {}
      answerInputOnEnter.classList.remove('hidden');
    }
    const submitBtnOnEnter = el('submit-answer'); if (submitBtnOnEnter) submitBtnOnEnter.classList.remove('hidden');
    // Переподписка на ответы/голоса для надёжности, если roundId уже известен
    try { if (state.currentRoundId) { resubscribeAnswersRealtime(); resubscribeVotesRealtime(); } } catch {}

    // Таймер answering по rounds.ended_at — показываем прямо в phase-label
    const deadlineMsAns = latest?.ended_at ? Date.parse(latest.ended_at) : 0;
    if (deadlineMsAns > 0) {
      if (answeringRow) answeringRow.classList.add('hidden');
      const phaseLabelElAns = document.getElementById('phase-label');
      // Стабильная разметка для answering
      if (phaseLabelElAns && !phaseLabelElAns.querySelector('#phase-ans-left')) {
        phaseLabelElAns.innerHTML = 'Ответы игроков, осталось: <span id="phase-ans-left"></span>';
      }
      const renderAnsTimer = () => {
        const left = Math.max(0, Math.ceil((deadlineMsAns - Date.now())/1000));
        const leftEl = document.getElementById('phase-ans-left');
        if (leftEl) leftEl.textContent = String(left).padStart(2,'0');
        return left;
      };
      renderAnsTimer();
      try { if (state._answeringTimerId) clearInterval(state._answeringTimerId); } catch {}
      state._answeringTimerId = setInterval(async () => {
        const left = renderAnsTimer();
        if (left <= 0) {
          clearInterval(state._answeringTimerId);
          // Авто-отправка введённого ответа если не пустой и не отправляли
          try {
            if (!state.mySubmitted) {
              const inputEl = el('answer-text');
              const txt = (inputEl?.value || '').trim();
              if (txt) {
                // Локально отправим, как обычный submitAnswer, но без повторного таймера
                const btn = el('submit-answer'); if (btn) btn.disabled = true;
                try {
                  let uid = state.currentUser?.id || null;
                  if (!uid) {
                    try {
                      const { data: g } = await supabase.auth.getUser();
                      uid = g?.user?.id || null;
                      if (!uid) {
                        const { data, error } = await supabase.auth.signInAnonymously();
                        if (!error) uid = data?.user?.id || null;
                      }
                      if (uid && !state.currentUser) state.currentUser = { id: uid };
                    } catch {}
                  }
                  if (uid && state.currentRoundId) {
                    const { error } = await supabase.from('answers').insert({ round_id: state.currentRoundId, author_id: uid, text: txt });
                    if (!error) { state.mySubmitted = true; }
                  }
                } catch {}
                finally { const b = el('submit-answer'); if (b) b.disabled = false; }
              }
            }
          } catch {}
          // Переход к голосованию (только у хоста)
          try {
            if (state.isHost && state.currentRoundId) {
              await startVoting();
            }
          } catch (e) { console.error('Auto startVoting after answering timeout failed:', e); }
        }
      }, 250);
    }
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
    // Fallback: при входе в голосование после answering отправим набранный текст, если он не был отправлен
    if (prevPhase === 'answering') {
      try {
        if (!state.mySubmitted && state.currentRoundId) {
          const txt = (el('answer-text')?.value || '').trim();
          if (txt) {
            let uid = state.currentUser?.id || null;
            if (!uid) {
              try {
                const { data: g } = await supabase.auth.getUser();
                uid = g?.user?.id || null;
                if (!uid) {
                  const { data, error } = await supabase.auth.signInAnonymously();
                  if (!error) uid = data?.user?.id || null;
                }
                if (uid && !state.currentUser) state.currentUser = { id: uid };
              } catch {}
            }
            if (uid) {
              const { data: exists } = await supabase
                .from('answers')
                .select('id')
                .eq('round_id', state.currentRoundId)
                .eq('author_id', uid)
                .maybeSingle();
              if (!exists) {
                try { await supabase.from('answers').insert({ round_id: state.currentRoundId, author_id: uid, text: txt }); state.mySubmitted = true; }
                catch {}
              }
            }
          }
        }
      } catch {}
    }
    // Таймер голосования: убираем нижнюю строку и показываем внутри phase-label
    const votingRow = document.getElementById('voting-row-message');
    if (votingRow) votingRow.classList.add('hidden');
    const phaseLabelElVoting = document.getElementById('phase-label');
    // Инициализируем стабильную разметку внутри phase-label один раз
    if (phaseLabelElVoting && !phaseLabelElVoting.querySelector('#phase-vote-left')) {
      phaseLabelElVoting.innerHTML = 'Голосование, осталось: <span id="phase-vote-left"></span>';
    }
    const deadlineMsVoting = latest?.ended_at ? Date.parse(latest.ended_at) : 0;
    const renderVotingTimer = () => {
      const left = Math.max(0, Math.ceil((deadlineMsVoting - Date.now())/1000));
      const leftEl = document.getElementById('phase-vote-left');
      if (leftEl) leftEl.textContent = String(left).padStart(2,'0');
      return left;
    };
    if (deadlineMsVoting > 0) {
      const leftNow = renderVotingTimer();
      // Если дедлайн уже прошёл к моменту обновления UI — финализируем сразу (у хоста)
      if (leftNow <= 0) {
        // Немедленная автоподача выбранного голоса, если уже истёк дедлайн
        try { await autoSubmitPendingVote(); } catch {}
        try {
          if (amIHost && latest && latest.phase === 'voting' && state.currentRoundId && !state.finalizing) {
            state.finalizing = true;
            try { await finalize(); } finally { state.finalizing = false; }
          }
        } catch (e) { console.error('Immediate finalize on voting timeout failed:', e); }
      }
      try { if (state._votingTimerId) clearInterval(state._votingTimerId); } catch {}
      state._votingTimerId = setInterval(async () => {
        const left = renderVotingTimer();
        if (left <= 0) {
          clearInterval(state._votingTimerId);
          // Перед финализацией: если у игрока выбран вариант — отправляем его голос
          try { await autoSubmitPendingVote(); } catch {}
          // Таймаут голосования → финализация у хоста
          try {
            if (amIHost && latest && latest.phase === 'voting' && state.currentRoundId && !state.finalizing) {
              state.finalizing = true;
              try { await finalize(); } finally { state.finalizing = false; }
            }
          } catch (e) { console.error('Auto finalize on voting timeout failed:', e); }
        }
      }, 250);
    }
    // Показать список ответов и кнопку голосования только во время голосования
    const answersContainer = el('answers-list');
    if (answersContainer) answersContainer.classList.remove('hidden');
    const voteBtn = el('vote');
    if (voteBtn) {
      const shouldHide = !!state.myVoted;
      voteBtn.classList.toggle('hidden', shouldHide);
      voteBtn.disabled = shouldHide;
      if (!shouldHide) {
        // На входе в голосование у активной кнопки убираем серый стиль с прошлого раунда
        voteBtn.classList.remove('muted');
      }
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
      // Кнопки-переключатели: применяем запрет самоголоса при 3+ вариантах и disabled после голосования
      const btns = Array.from(contNow.querySelectorAll('.vote-option'));
      const disallowSelf = btns.length >= 3;
      const myUid = state.currentUser?.id || null;
      btns.forEach(btn => {
        const isOwn = myUid && btn.dataset.authorId === myUid;
        const shouldDisable = (!!state.myVoted) || (disallowSelf && isOwn && !state.myVoted);
        btn.disabled = shouldDisable;
        btn.classList.toggle('muted', disallowSelf && isOwn);
        if (disallowSelf && isOwn && btn.getAttribute('aria-checked') === 'true') {
          btn.setAttribute('aria-checked', 'false');
          if (state.selectedAnswerId === btn.dataset.answerId) state.selectedAnswerId = null;
        }
      });
      const prevSel = state.selectedAnswerId || (contNow.querySelector('.vote-option[aria-checked="true"]')?.dataset.answerId || null);
      if (prevSel) {
        contNow.querySelectorAll('.vote-option').forEach(b => b.setAttribute('aria-checked', String(b.dataset.answerId === prevSel)));
      }
      contNow.classList.toggle('muted', !!state.myVoted);
    }
  } else if (state.currentPhase === 'results') {
    // Скрываем таймер голосования
    try { if (state._votingTimerId) clearInterval(state._votingTimerId); } catch {}
    const votingRow2 = document.getElementById('voting-row-message'); if (votingRow2) votingRow2.classList.add('hidden');
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
        const ordered = shuffleSeeded(ans || [], state.currentRoundId);
        const { data: votesAll } = await supabase.from('votes').select('answer_id').eq('round_id', state.currentRoundId);
        const counts = new Map();
        (votesAll || []).forEach(v => counts.set(v.answer_id, (counts.get(v.answer_id) || 0) + 1));
        const container = el('answers-list');
        if (container) {
          container.innerHTML = '';
          const wrap = document.createElement('div');
          ordered.forEach(a => {
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
    // Вставка ожидания прямо в лейбл фазы (в одну строку) для не-хоста, если победителя ещё нет
    try {
      const phaseLabelEl = document.getElementById('phase-label');
      if (phaseLabelEl) {
        const haveWinner = !!winner;
        if (!amIHost && !haveWinner) {
          const hostPlayer = (players || []).find(p => p.is_host);
          const hostName = hostPlayer?.nickname || 'хост';
          phaseLabelEl.innerHTML = `<span class=\"muted\">Результат голосования. Ждём, когда <strong id=\"host-nick-next\">${hostName}</strong> начнёт следующий раунд<span id=\"wait-next-dots\"></span></span>`;
          const nextDots = document.getElementById('wait-next-dots');
          if (state._waitNextDotsTimer) { try { clearInterval(state._waitNextDotsTimer); } catch {} state._waitNextDotsTimer = null; }
          if (nextDots) {
            let n2 = 0;
            const render2 = () => { n2 = (n2 + 1) % 4; nextDots.textContent = '.'.repeat(n2); };
            render2();
            state._waitNextDotsTimer = setInterval(render2, 500);
          }
        } else {
          phaseLabelEl.textContent = 'Результат голосования.';
          if (state._waitNextDotsTimer) { clearInterval(state._waitNextDotsTimer); state._waitNextDotsTimer = null; }
        }
      }
    } catch {}
  } else {
    // Скрыть ожидание следующего раунда во всех прочих фазах
    try {
      const nextRow = document.getElementById('wait-next-row');
      const nextDots = document.getElementById('wait-next-dots');
      if (nextRow) nextRow.classList.add('hidden');
      if (state._waitNextDotsTimer) { clearInterval(state._waitNextDotsTimer); state._waitNextDotsTimer = null; }
      if (nextDots) nextDots.textContent = '';
    } catch {}
    // В других фазах очищаем и скрываем варианты, показ ввода зависит от myAnswered
    const container = el('answers-list');
    if (container) { container.innerHTML = ''; container.classList.add('hidden'); }
    const voteBtn = el('vote');
    if (voteBtn) { voteBtn.classList.add('hidden'); voteBtn.disabled = true; voteBtn.classList.remove('muted'); }
    // В других фазах скрываем кнопку следующего раунда
    const nextBtnOther = el('next-round'); if (nextBtnOther) nextBtnOther.classList.add('hidden');
    const answerInput = el('answer-text');
    const submitBtn = el('submit-answer');
    // Управление таймером answering: скрываем и останавливаем только если фаза НЕ answering
    if (state.currentPhase !== 'answering') {
      try { if (state._answeringTimerId) clearInterval(state._answeringTimerId); } catch {}
      if (answeringRow) answeringRow.classList.add('hidden');
    }
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
      : `Игрок ${(players||[]).find(p=>p.player_id===latest.author_id)?.nickname || ''} придумывает вопрос`;
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

  // Автопереход к голосованию: когда все игроки комнаты отправили ответ
  try {
    if (latest && latest.phase === 'answering' && amIHost) {
      const respondentsIds = (players || []).map(p => p.player_id);
      if (respondentsIds.length > 0) {
        const allAnswered = respondentsIds.every(id => submittedMap.get(id));
        if (allAnswered) {
          // Запускаем голосование только если раунд ещё в answering
          try { await startVoting(); } catch (e) { console.error('startVoting failed:', e); }
        }
      }
    }
  } catch (e) { console.error('Auto startVoting failed:', e); }

  // --- Авто-финализация: если проголосовали все ИГРОКИ (или, как минимум, все авторы ответов) ---
  try {
    if (latest?.phase === 'voting' && state.currentRoundId) {
      const [{ data: votes }, { data: ans }] = await Promise.all([
        supabase.from('votes').select('voter_id').eq('round_id', state.currentRoundId),
        supabase.from('answers').select('author_id').eq('round_id', state.currentRoundId)
      ]);
      const voters = new Set((votes || []).map(v => v.voter_id));
      const participants = new Set((ans || []).map(a => a.author_id));
      const allAuthorsVoted = participants.size > 0 && Array.from(participants).every(id => voters.has(id));
      const roomPlayerIds = (players || []).map(p => p.player_id);
      const allPlayersVoted = roomPlayerIds.length > 0 && roomPlayerIds.every(id => voters.has(id));
      if ((allPlayersVoted || allAuthorsVoted) && amIHost && !state.finalizing) {
        state.finalizing = true;
        try { await finalize(); } finally { state.finalizing = false; }
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
    // В results для не-хостов добавляем под "Фаза:" ожидание следующего раунда, если победитель не определён
    try {
      const phaseRow = document.getElementById('phase-row');
      const hostNickEl2 = document.getElementById('host-nick-next') || document.createElement('strong');
      const nextDotsId = 'wait-next-dots';
      const haveWinner = !!winner;
      const shouldShowWait = (!amIHost) && !haveWinner;
      // Создаём/находим контейнер ожидания рядом с фазой
      let waitInline = document.getElementById('wait-inline');
      if (!waitInline && phaseRow) {
        waitInline = document.createElement('div');
        waitInline.id = 'wait-inline';
        waitInline.className = 'muted';
        waitInline.style.display = 'block';
        waitInline.style.margin = '4px 0 0 0';
        waitInline.style.flexBasis = '100%';
        waitInline.style.width = '100%';
        phaseRow.appendChild(waitInline);
      }
      if (waitInline) {
        if (shouldShowWait) {
          const hostPlayer = (players || []).find(p => p.is_host);
          const hostName = hostPlayer?.nickname || 'хост';
          waitInline.innerHTML = `Ждём, когда <strong id="host-nick-next">${hostName}</strong> начнёт следующий раунд<span id="${nextDotsId}"></span>`;
          const nextDots = document.getElementById(nextDotsId);
          if (nextDots && !state._waitNextDotsTimer) {
            let n2 = 0;
            const render2 = () => { n2 = (n2 + 1) % 4; nextDots.textContent = '.'.repeat(n2); };
            render2();
            state._waitNextDotsTimer = setInterval(render2, 500);
          }
        } else {
          waitInline.innerHTML = '';
          if (state._waitNextDotsTimer) { clearInterval(state._waitNextDotsTimer); state._waitNextDotsTimer = null; }
        }
      }
    } catch {}
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
                author_id: authorId, compose_deadline: deadline, started_at: new Date().toISOString() })
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
    const answeringDeadline = new Date(Date.now() + Number(cfg?.question_seconds || 60) * 1000).toISOString();
    const { data: round, error: e2 } = await supabase
      .from('rounds').insert({ room_id: state.currentRoomId, question_id: qid, phase: 'answering', question_source: cfg?.question_source || 'preset', ended_at: answeringDeadline, started_at: new Date().toISOString() })
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
  // Устанавливаем дедлайн голосования на основе rooms.vote_seconds
  let voteSecs = 45;
  try {
    const { data: cfgRoom } = await supabase.from('rooms').select('vote_seconds').eq('id', state.currentRoomId).single();
    voteSecs = Number(cfgRoom?.vote_seconds || 45) || 45;
  } catch {}
  const deadline = new Date(Date.now() + voteSecs * 1000).toISOString();
  // Переводим в voting ТОЛЬКО из answering, чтобы не перезапускать голосование
  const { data: upd, error } = await supabase
    .from('rounds')
    .update({ phase: 'voting', ended_at: deadline })
    .eq('id', state.currentRoundId)
    .eq('phase', 'answering')
    .select('id');
  if (error) return alert(error.message);
  if (!upd || upd.length === 0) {
    // Фаза уже не answering — тихо выходим
    return;
  }
  await refreshRoomState();
  // Автоматически подгружаем ответы для голосования
  try {
    await loadAnswers();
  } catch (e) { console.error('Auto load answers failed:', e); }
}

export async function loadAnswers() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const prevSelected = state.selectedAnswerId || (document.querySelector('.vote-option[aria-checked="true"]')?.dataset.answerId || null);

  const { data: ans, error } = await supabase
    .from('answers')
    .select('id, text, author_id')
    .eq('round_id', state.currentRoundId);
  if (error) return alert(error.message);
  const ordered = shuffleSeeded(ans || [], state.currentRoundId);
  const myUid = state.currentUser?.id || null;
  const disallowSelf = (ordered.length >= 3);
  const container = el('answers-list');
  if (container) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    ordered.forEach(a => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-action vote-option';
      btn.dataset.answerId = a.id;
      btn.dataset.authorId = a.author_id || '';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(a.id === prevSelected));
      btn.textContent = a.text;
      if (disallowSelf && myUid && a.author_id === myUid) {
        btn.disabled = true;
        btn.classList.add('muted');
        btn.title = 'Нельзя голосовать за свой ответ при 3+ вариантах';
        if (state.selectedAnswerId === a.id) state.selectedAnswerId = null;
      }
      btn.onclick = () => {
        if (state.myVoted) return;
        if (btn.disabled) return;
        // Один выбор: сбрасываем остальные
        wrap.querySelectorAll('.vote-option').forEach(b => b.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        state.selectedAnswerId = a.id;
      };
      wrap.appendChild(btn);
    });
    container.appendChild(wrap);
  }
}

export async function submitCustomQuestion() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const text = (el('custom-question')?.value || '').trim();
  if (!text) return alert('Введите вопрос');
  // Устанавливаем дедлайн для answering после ввода автором
  let qSecs = 60;
  try {
    const { data: cfg } = await supabase.from('rooms').select('question_seconds').eq('id', state.currentRoomId).single();
    qSecs = Number(cfg?.question_seconds || 60) || 60;
  } catch {}
  const deadline = new Date(Date.now() + qSecs * 1000).toISOString();
  await supabase.from('rounds')
    .update({ question_text: text, phase: 'answering', ended_at: deadline })
    .eq('id', state.currentRoundId);
  const inp = el('custom-question'); if (inp) inp.value = '';
  await refreshRoomState();
}

export async function vote() {
  if (!state.currentRoundId) return alert('Раунд не начат');
  const voteBtnLock = el('vote');
  if (voteBtnLock) { voteBtnLock.disabled = true; voteBtnLock.classList.add('muted'); }
  const checkedBtn = document.querySelector('.vote-option[aria-checked="true"]');
  const ansId = checkedBtn ? checkedBtn.dataset.answerId : '';
  if (!ansId) { if (voteBtnLock) { voteBtnLock.disabled = false; voteBtnLock.classList.remove('muted'); } return alert('Выберите ответ'); }
  // Защита от самоголоса при 3+ ответах
  try {
    const inputs = Array.from(document.querySelectorAll('input[name="vote-answer"]'));
    if (inputs.length >= 3) {
      const myUid = state.currentUser?.id || null;
      const authorId = checked?.dataset?.authorId || '';
      if (myUid && authorId && myUid === authorId) {
        if (voteBtnLock) { voteBtnLock.disabled = false; voteBtnLock.classList.remove('muted'); }
        return alert('При 3+ вариантах нельзя голосовать за свой ответ');
      }
    }
  } catch {}
  const { error } = await supabase.from('votes').insert({
    round_id: state.currentRoundId, voter_id: state.currentUser.id, answer_id: ansId
  });
  if (error) { if (voteBtnLock) { voteBtnLock.disabled = false; voteBtnLock.classList.remove('muted'); } return alert(error.message); }
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
    container.querySelectorAll('.vote-option').forEach(btn => { btn.disabled = true; });
  }
  const voteBtn = el('vote'); if (voteBtn) { voteBtn.classList.add('hidden'); voteBtn.disabled = true; }
  // Обновим состояние, чтобы появилась галочка у проголосовавшего
  await refreshRoomState();
}

export async function finalize() {
  if (!state.currentRoundId && state.currentRoomId) {
    try {
      const { data } = await supabase
        .from('rounds').select('id')
        .eq('room_id', state.currentRoomId)
        .is('finalized_at', null)
        .in('phase', ['voting'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      state.currentRoundId = data?.id || null;
    } catch {}
  }
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
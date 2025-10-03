import { supabase } from './supabaseClient.js';
import { state, showStep } from './state.js';
import { updateInviteUI } from './ui.js';
import { refreshRoomState, startRound } from './round.js';

// Быстрая повторная синхронизация игроков при одновременном входе
let playersSyncInterval = null;
let playersSyncAttempts = 0;

function subscribeToRoomRealtime(roomId) {
  try {
    if (state.roomChannel) { supabase.removeChannel(state.roomChannel); state.roomChannel = null; }
    const channel = supabase.channel(`room-${roomId}`);
    channel
      // Получаем широковещательные события от клиентов (например, отправка ответа)
      .on('broadcast', { event: 'answer_submitted' }, (payload) => {
        try {
          const pid = payload?.payload?.player_id || null;
          if (pid && state.optimisticSubmittedIds) state.optimisticSubmittedIds.add(pid);
          // Мгновенно нарисуем галочку у игрока без ожидания загрузки
          if (pid) {
            const applyCheck = (ulId) => {
              const ul = document.getElementById(ulId);
              if (!ul) return;
              const items = Array.from(ul.children || []);
              items.forEach((li) => {
                try {
                  if (!li || li.dataset?.playerId !== pid) return;
                  const txt = String(li.textContent || '');
                  // Вставим ✅ перед " — очки:" если ещё нет
                  if (txt.includes('✅')) return;
                  const sep = ' — очки:';
                  const idx = txt.indexOf(sep);
                  if (idx >= 0) {
                    const left = txt.slice(0, idx).trimEnd();
                    const right = txt.slice(idx);
                    li.textContent = `${left} ✅${right}`;
                  } else {
                    li.textContent = `${txt} ✅`;
                  }
                } catch {}
              });
            };
            applyCheck('players-list');
            applyCheck('players-list-round');
          }
          // Хост: мгновенный переход к голосованию, если все активные отправили ответы
          try {
            if (state.isHost && state.currentRoundId) {
              const allPlayers = Object.values(state.roomPlayersCache || {});
              const activeIds = allPlayers.filter(p => p && p.is_active !== false).map(p => p.player_id);
              if (activeIds.length > 0) {
                const haveAll = activeIds.every(id => state.optimisticSubmittedIds && state.optimisticSubmittedIds.has(id));
                if (haveAll) {
                  import('./round.js').then(({ startVoting }) => { try { startVoting(); } catch {} });
                }
              }
            }
          } catch {}
        } catch {}
        // Обновляем состояние, чтобы у всех появилась галочка ✅
        refreshRoomState();
      })
      .on('broadcast', { event: 'player_joined' }, () => {
        // Обновление списка игроков при одновременном входе
        refreshRoomState();
      })
      .on('broadcast', { event: 'round_started' }, () => {
        // Переобновляем UI чтобы гарантированно показать поле ввода начала раунда
        refreshRoomState();
      })
      .on('broadcast', { event: 'round_starting' }, () => {
        // Мгновенное обновление UI до вставки раунда в БД
        try {
          const banner = document.getElementById('winner-banner'); if (banner) { banner.classList.add('hidden'); banner.textContent = ''; }
          const nextBtn = document.getElementById('next-round'); if (nextBtn) nextBtn.classList.add('hidden');
          const endBtn = document.getElementById('end-game'); if (endBtn) endBtn.classList.add('hidden');
          const answers = document.getElementById('answers-list'); if (answers) { answers.classList.add('hidden'); answers.innerHTML = ''; }
          const voteBtn = document.getElementById('vote'); if (voteBtn) { voteBtn.classList.add('hidden'); voteBtn.disabled = true; }
          const answer = document.getElementById('answer-text'); if (answer) { try { answer.value = ''; } catch {}; answer.classList.add('hidden'); }
          const submit = document.getElementById('submit-answer'); if (submit) submit.classList.add('hidden');
          const qText = document.getElementById('question-text'); if (qText) qText.textContent = '—';
          const phaseLabel = document.getElementById('phase-label'); if (phaseLabel) phaseLabel.textContent = 'Ответы игроков…';
          // Убираем галочки из списков игроков мгновенно
          const stripChecks = (ulId) => {
            const ul = document.getElementById(ulId);
            if (!ul) return;
            Array.from(ul.children || []).forEach((li) => {
              try {
                if (!li) return;
                const txt = String(li.textContent || '');
                if (txt.includes('✅')) li.textContent = txt.replace('✅', '').replace(/\s{2,}/g, ' ').replace(/\s+—/,' —').trim();
              } catch {}
            });
          };
          stripChecks('players-list');
          stripChecks('players-list-round');
        } catch {}
      })
      .on('broadcast', { event: 'vote_submitted' }, (payload) => {
        try {
          const pid = payload?.payload?.player_id || null;
          if (pid && state.optimisticVotedIds) state.optimisticVotedIds.add(pid);
        } catch {}
        // Обновление состояния при голосе любого игрока (включая для хоста)
        refreshRoomState();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` }, (payload) => {
        try {
          const r = payload?.new || {};
          if (r && r.room_id === roomId) {
            state.roomPlayersCache[r.player_id] = {
              player_id: r.player_id,
              nickname: r.nickname,
              score: r.score ?? 0,
              is_host: !!r.is_host,
              is_active: r.is_active !== false,
              last_seen_at: r.last_seen_at || null
            };
          }
        } catch {}
        refreshRoomState();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` }, (payload) => {
        try {
          const r = payload?.new || {};
          if (r && r.room_id === roomId) {
            const prev = state.roomPlayersCache[r.player_id] || {};
            state.roomPlayersCache[r.player_id] = {
              player_id: r.player_id,
              nickname: r.nickname ?? prev.nickname,
              score: r.score ?? prev.score ?? 0,
              is_host: (typeof r.is_host === 'boolean') ? r.is_host : !!prev.is_host,
              is_active: (typeof r.is_active === 'boolean') ? r.is_active : (prev.is_active !== false),
              last_seen_at: r.last_seen_at || prev.last_seen_at || null
            };
          }
        } catch {}
        refreshRoomState();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_players', filter: `room_id=eq.${roomId}` }, (payload) => {
        try {
          const r = payload?.old || {};
          if (r && r.room_id === roomId) {
            delete state.roomPlayersCache[r.player_id];
          }
        } catch {}
        refreshRoomState();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, () => { refreshRoomState(); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rounds', filter: `room_id=eq.${roomId}` }, () => { refreshRoomState(); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rounds', filter: `room_id=eq.${roomId}` }, () => { refreshRoomState(); })
      .subscribe();
    state.roomChannel = channel;
    // Триггерим несколько повторных обновлений в первые секунды, чтобы добрать пропущенные вставки
    refreshRoomState();
    if (playersSyncInterval) { clearInterval(playersSyncInterval); playersSyncInterval = null; }
    playersSyncAttempts = 0;
    playersSyncInterval = setInterval(() => {
      playersSyncAttempts += 1;
      refreshRoomState();
      if (playersSyncAttempts >= 5) { clearInterval(playersSyncInterval); playersSyncInterval = null; }
    }, 1000);
  } catch {}
}

export async function ensureUser() {
  if (!state.currentUser) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw new Error(error.message);
    state.currentUser = data.user;
    // На некоторых экранах main.js читает user сразу из auth.getUser — синхронизируем
    try {
      const g = await supabase.auth.getUser();
      if (g?.data?.user?.id && !state.currentUser?.id) {
        state.currentUser = g.data.user;
      }
    } catch {}
  }
  return state.currentUser;
}

function randomCode(len=4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function normalizeRoomCodeInput(raw) {
  const map = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
    'Р': 'P', 'С': 'S', 'Т': 'T', 'Х': 'X', 'У': 'Y'
  };
  let s = String(raw || '').trim().toUpperCase();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out += map[ch] || ch;
  }
  return out;
}

export async function createRoom() {
  const user = await ensureUser();
  if (!state.nickname) throw new Error('Введите ник');
  const code = randomCode(4);
  const initTarget = Math.min(99, Math.max(1, Number(document.getElementById('target-score')?.value || 10)));
  const initSecs = Math.min(999, Math.max(1, Number(document.getElementById('question-seconds')?.value || 60)));
  const initVoteSecs = Math.min(999, Math.max(1, Number(document.getElementById('vote-seconds')?.value || 45)));
  const sel = document.getElementById('qsrc-select');
  const initSrc = (sel && (sel.value === 'players' || sel.value === 'preset')) ? sel.value : 'preset';
  const { data: room, error } = await supabase
    .from('rooms').insert({ code, owner_id: user.id, status: 'lobby', target_score: initTarget, question_seconds: initSecs, vote_seconds: initVoteSecs, question_source: initSrc })
    .select().single();
  if (error) throw new Error(error.message);
  state.currentRoomId = room.id;
  state.currentRoomCode = room.code;
  state.isHost = true;
  state.roomPlayersCache = {};
  localStorage.setItem('last_room_code', state.currentRoomCode);
  state.autoJumpToRound = true;

  // Мгновенно показываем все поля лобби единым кадром
  try {
    showStep(3);
    const lobbyAdmin = document.getElementById('lobby-admin');
    if (lobbyAdmin) lobbyAdmin.classList.remove('hidden');
    const roomCodeEl = document.getElementById('room-code-lobby'); if (roomCodeEl) roomCodeEl.textContent = state.currentRoomCode || '';
    // Инициализируем значения инпутов из только что созданной комнаты
    const ti = document.getElementById('target-score'); if (ti) { ti.value = String(initTarget); ti.dataset.dirty = '1'; }
    const qs = document.getElementById('question-seconds'); if (qs) { qs.value = String(initSecs); qs.dataset.dirty = '1'; }
    const vs = document.getElementById('vote-seconds'); if (vs) { vs.value = String(initVoteSecs); vs.dataset.dirty = '1'; }
    const srcSel = document.getElementById('qsrc-select'); if (srcSel && (initSrc === 'players' || initSrc === 'preset')) srcSel.value = initSrc;
  } catch {}
  
  console.log('Creating room player entry:', { 
    player_id: user.id, 
    room_id: state.currentRoomId, 
    nickname: state.nickname, 
    is_host: true 
  });
  
  // Ensure membership exists (idempotent): select first, then insert if missing
  const { data: existingHost, error: hostSelErr } = await supabase
    .from('room_players')
    .select('player_id')
    .eq('room_id', state.currentRoomId)
    .eq('player_id', user.id)
    .maybeSingle();
  if (hostSelErr) {
    console.error('Error checking existing host membership:', hostSelErr);
  }
  if (!existingHost) {
    const { error: playerError } = await supabase.from('room_players').insert({
      player_id: user.id, room_id: state.currentRoomId, nickname: state.nickname, is_host: true
    });
    if (playerError) {
      console.error('Error adding player to room:', playerError);
      // Ignore duplicate insert attempts by code detection
      const msg = String(playerError.message || '');
      if (!msg.toLowerCase().includes('duplicate') && playerError.code !== '23505') {
        throw new Error(`Failed to add player: ${playerError.message}`);
      }
    }
  }
  
  console.log('Player added successfully, updating UI');
  // Обновляем локальный кеш игроков (включая себя)
  state.roomPlayersCache[user.id] = {
    player_id: user.id,
    nickname: state.nickname,
    score: 0,
    is_host: true,
    is_active: true,
    last_seen_at: null
  };
  try { await setActiveStatus(true); } catch {}
  updateInviteUI();
  showStep(3);
  await refreshRoomState();
  // Подписка на изменения в комнате
  subscribeToRoomRealtime(state.currentRoomId);
  // Сообщим в комнату о входе игрока, чтобы у всех обновились списки
  try {
    if (state.roomChannel) {
      state.roomChannel.send({ type: 'broadcast', event: 'player_joined', payload: { player_id: user.id } });
    }
  } catch {}
}

export async function joinByCode(codeRaw, statusEl, buttonEl) {
  if (buttonEl) buttonEl.disabled = true;
  if (statusEl) statusEl.textContent = '';
  // Анимируем саму кнопку
  let dotsTimer = null;
  let originalHTML = '';
  let fixedWidth = 0;
  try {
    if (buttonEl) {
      originalHTML = buttonEl.innerHTML;
      const rect = buttonEl.getBoundingClientRect();
      fixedWidth = Math.ceil(rect.width);
      const cs = window.getComputedStyle(buttonEl);
      try {
        const padLeft = parseFloat(cs.paddingLeft) || 0;
        const padRight = parseFloat(cs.paddingRight) || 0;
        const brdLeft = parseFloat(cs.borderLeftWidth) || 0;
        const brdRight = parseFloat(cs.borderRightWidth) || 0;
        const measure = document.createElement('span');
        measure.style.position = 'absolute';
        measure.style.visibility = 'hidden';
        measure.style.whiteSpace = 'nowrap';
        measure.style.font = cs.font;
        measure.textContent = 'Подключаем...';
        document.body.appendChild(measure);
        const textW = measure.getBoundingClientRect().width;
        document.body.removeChild(measure);
        const needW = Math.ceil(textW + padLeft + padRight + brdLeft + brdRight);
        fixedWidth = Math.max(fixedWidth, needW);
      } catch {}
      buttonEl.classList.add('muted');
      buttonEl.style.whiteSpace = 'nowrap';
      buttonEl.style.width = fixedWidth + 'px';
      buttonEl.innerHTML = '';
      const baseSpan = document.createElement('span');
      baseSpan.textContent = 'Подключаем';
      const dotsSpan = document.createElement('span');
      dotsSpan.style.display = 'inline-block';
      dotsSpan.style.width = '3ch';
      dotsSpan.style.textAlign = 'left';
      dotsSpan.style.verticalAlign = 'baseline';
      buttonEl.appendChild(baseSpan);
      buttonEl.appendChild(dotsSpan);
      let n = 0;
      const renderDots = () => { n = (n + 1) % 4; dotsSpan.textContent = '.'.repeat(n); };
      renderDots();
      dotsTimer = setInterval(renderDots, 500);
    }
  } catch {}
  try {
    const user = await ensureUser();
    const codeInput = (codeRaw || '').trim();
    const codeNorm = normalizeRoomCodeInput(codeInput);
    const candidates = Array.from(new Set([codeNorm]));
    if (!codeNorm) throw new Error('Введите код');
    // 1) RPC может вернуть массив или объект; 2) подстрахуемся селектом из таблицы
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_room_by_code', { p_code: codeNorm });
    let room = null;
    if (!rpcError && rpcData) {
      room = Array.isArray(rpcData) ? (rpcData[0] || null) : rpcData;
      // unwrap function-return wrapper like { get_room_by_code: {...} }
      if (room && !Array.isArray(room) && !(room.id || room.room_id || room.roomId)) {
        const maybeWrapped = room.get_room_by_code || room.GET_ROOM_BY_CODE || null;
        if (maybeWrapped && typeof maybeWrapped === 'object') {
          room = maybeWrapped;
        } else {
          // Fallback: try first nested object having id
          try {
            const nested = Object.values(room).find(v => v && typeof v === 'object' && (v.id || v.room_id || v.roomId));
            if (nested) room = nested;
          } catch {}
        }
      }
    }
    if (!room || !(room.id || room.room_id || room.roomId)) {
      const { data: roomSelArr } = await supabase
        .from('rooms')
        .select('id, code, status, archived')
        .in('code', candidates)
        .limit(1);
      room = (Array.isArray(roomSelArr) ? roomSelArr[0] : null) || null;
    }
    if (!room) throw new Error('Комната не найдена');
    const roomId = room?.id || room?.room_id || room?.roomId || null;
    const roomCode = room?.code || room?.room_code || room?.roomCode || codeNorm;
    if (!roomId) throw new Error('Комната не найдена');
    state.currentRoomId = roomId;
    state.currentRoomCode = roomCode || codeNorm;
    state.isHost = false;
    state.roomPlayersCache = {};
    localStorage.setItem('last_room_code', state.currentRoomCode);
  state.autoJumpToRound = true;
    // Ensure membership exists (idempotent): select first, then insert if missing
    const { data: existing, error: selErr } = await supabase
      .from('room_players')
      .select('player_id')
      .eq('room_id', state.currentRoomId)
      .eq('player_id', user.id)
      .maybeSingle();
    if (selErr) {
      console.error('Error checking existing membership:', selErr);
    }
    if (!existing) {
      const nickname = (state.nickname || '').trim() || 'Player';
      const { error: insErr } = await supabase.from('room_players').insert({
        player_id: user.id, room_id: state.currentRoomId, nickname, is_host: false
      });
      if (insErr) {
        const msg = String(insErr.message || '');
        if (!msg.toLowerCase().includes('duplicate') && insErr.code !== '23505') {
          throw new Error(insErr.message);
        }
      }
    }
    // Обновляем локальный кеш игроков (включая себя)
    const nickname2 = (state.nickname || '').trim() || 'Player';
    state.roomPlayersCache[user.id] = {
      player_id: user.id,
      nickname: nickname2,
      score: 0,
      is_host: false,
      is_active: true,
      last_seen_at: null
    };
  try { await setActiveStatus(true); } catch {}
    updateInviteUI();
    showStep(3);
    if (statusEl) statusEl.textContent = '';
    await refreshRoomState();
    // Подписка на изменения в комнате
    subscribeToRoomRealtime(state.currentRoomId);
    // Сообщим в комнату о входе игрока, чтобы у всех обновились списки
    try {
      if (state.roomChannel) {
        state.roomChannel.send({ type: 'broadcast', event: 'player_joined', payload: { player_id: user.id } });
      }
    } catch {}
  } catch (e) {
    if (statusEl) statusEl.textContent = e.message || 'Ошибка';
    else alert(e.message || e);
  } finally {
    if (dotsTimer) { try { clearInterval(dotsTimer); } catch {} dotsTimer = null; }
    if (buttonEl) {
      buttonEl.classList.remove('muted');
      buttonEl.style.whiteSpace = '';
      buttonEl.style.width = '';
      buttonEl.innerHTML = originalHTML || 'Присоединиться';
      buttonEl.disabled = false;
    }
  }
}

export async function startGameFromLobby() {
  try {
    if (!state.currentRoomId) return showStep(4);
    // 1) Сброс UI победителя от предыдущей игры (на всякий случай до обновлений БД)
    try {
      const banner = document.getElementById('winner-banner');
      const endBtn = document.getElementById('end-game');
      const nextBtn = document.getElementById('next-round');
      if (banner) { banner.classList.add('hidden'); banner.textContent = ''; }
      if (endBtn) endBtn.classList.add('hidden');
      if (nextBtn) nextBtn.classList.add('hidden');
    } catch {}

    // 2) Сбрасываем очки всех игроков комнаты, чтобы победитель не подтянулся из прошлой игры
    try {
      await supabase.from('room_players')
        .update({ score: 0 })
        .eq('room_id', state.currentRoomId);
    } catch (e) {
      console.error('Failed to reset scores on new game start:', e);
    }

    // 3) Переводим комнату в активное состояние и снимаем архивный флаг (если был)
    await supabase
      .from('rooms')
      .update({ status: 'in_progress', archived: false, archived_at: null })
      .eq('id', state.currentRoomId);
  } catch (e) {
    console.error('Failed to update room status on startGame:', e);
  } finally {
    showStep(4);
  }
  // Автозапуск первого раунда (только у хоста)
  try {
    if (state.isHost) {
      await startRound();
    }
  } catch (e) { console.error('Auto startRound failed:', e); }
}

// Перенос сохранения настроек на кнопку "Начать игру"

export async function setActiveStatus(isActive) {
  try {
    if (!state.currentRoomId) return;
    const user = await ensureUser();
    if (!user?.id) return;
    const nowIso = new Date().toISOString();
    await supabase
      .from('room_players')
      .update({ is_active: !!isActive, last_seen_at: nowIso })
      .eq('room_id', state.currentRoomId)
      .eq('player_id', user.id);
    const me = state.roomPlayersCache[user.id] || {};
    state.roomPlayersCache[user.id] = { ...me, is_active: !!isActive, last_seen_at: nowIso };
  } catch (e) {
    console.error('Failed to update is_active:', e);
  }
}

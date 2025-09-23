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
      .on('broadcast', { event: 'answer_submitted' }, () => {
        // Простое обновление состояния, чтобы у всех появилась галочка ✅
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
      .on('broadcast', { event: 'vote_submitted' }, () => {
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
  }
  return state.currentUser;
}

function randomCode(len=4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
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
  if (statusEl) statusEl.textContent = 'Подключаем…';
  try {
    const user = await ensureUser();
    const code = (codeRaw || '').trim().toUpperCase();
    if (!code) throw new Error('Введите код');
    const { data: room, error } = await supabase.rpc('get_room_by_code', { p_code: code }).single();
    if (error || !room) throw new Error('Комната не найдена');
    state.currentRoomId = room.id;
    state.currentRoomCode = room.code;
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
      const { error: insErr } = await supabase.from('room_players').insert({
        player_id: user.id, room_id: state.currentRoomId, nickname: state.nickname, is_host: false
      });
      if (insErr) {
        const msg = String(insErr.message || '');
        if (!msg.toLowerCase().includes('duplicate') && insErr.code !== '23505') {
          throw new Error(insErr.message);
        }
      }
    }
    // Обновляем локальный кеш игроков (включая себя)
    state.roomPlayersCache[user.id] = {
      player_id: user.id,
      nickname: state.nickname,
      score: 0,
      is_host: false,
      is_active: true,
      last_seen_at: null
    };
  try { await setActiveStatus(true); } catch {}
    updateInviteUI();
    showStep(3);
    if (statusEl) statusEl.textContent = 'Готово';
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
    if (buttonEl) buttonEl.disabled = false;
  }
}

export async function startGameFromLobby() {
  try {
    if (!state.currentRoomId) return showStep(4);
    await supabase.from('rooms').update({ status: 'in_progress' }).eq('id', state.currentRoomId);
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

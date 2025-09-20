import { supabase } from './supabaseClient.js';
import { state, el, showStep } from './state.js';
import { updateInviteUI, copy, share } from './ui.js';
import { ensureUser, createRoom, joinByCode, startGameFromLobby, setActiveStatus } from './room.js';
import { refreshRoomState, startRound, submitAnswer, startVoting, loadAnswers, vote, finalize, submitCustomQuestion } from './round.js';

// Инициализация
el('nick').value = state.nickname;
showStep(state.nickname ? 2 : 1);
(async () => {
  const { data } = await supabase.auth.getUser();
  state.currentUser = data?.user || null;
  updateInviteUI();
})();

// Параметр ?code=ABCD
const qp = new URLSearchParams(location.search);
const codeParam = (qp.get('code') || '').toUpperCase();
if (codeParam) el('join-code').value = codeParam;

// Шаг 1
const btnSetNick = el('set-nick');
if (btnSetNick) btnSetNick.onclick = async () => {
  const s = el('auth-status');
  try {
    const u = await ensureUser();
    if (!u) { if (s) s.textContent = 'Auth error'; return; }

    state.nickname = el('nick').value.trim() || 'Player';
    localStorage.setItem('demo_nick', state.nickname);
    el('nick-saved').textContent = `Сохранено: ${state.nickname}`;
    if (s) s.textContent = `uid: ${u.id.slice(0,8)}…`;
    showStep(2);
  } catch (e) {
    if (s) s.textContent = 'Enable Anonymous auth in Supabase';
    alert(e?.message || e);
  }
};

// Назад
const btnBack1 = el('back-1'); if (btnBack1) btnBack1.onclick = () => showStep(1);
// На странице есть два элемента с id="back-2" (в лобби и в раунде).
// Привяжем обработчик ко всем найденным, чтобы у игроков тоже работала кнопка
// и перед возвратом пометим игрока как неактивного.
document.querySelectorAll('#back-2').forEach((btn) => {
  btn.onclick = async () => {
    try {
      state.autoJumpToRound = false;          // блокируем автопереход
      await setActiveStatus(false);           // AFK
      if (state.roomChannel) {                // снимем подписку комнаты
        try { supabase.removeChannel(state.roomChannel); } catch {}
        state.roomChannel = null;
      }
      const { cleanupSubscriptions } = await import('./round.js');
      if (cleanupSubscriptions) cleanupSubscriptions();
      state.currentRoundId = null;            // очистка состояния комнаты/раунда
      state.currentRoomId = null;
      state.roomPlayersCache = {};
    } finally {
      showStep(2);
      // НЕ включаем autoJumpToRound обратно здесь
    }
  };
});

// Шаг 2
const btnCreateRoom = el('create-room');
if (btnCreateRoom) btnCreateRoom.onclick = async () => {
  try {
    await createRoom();
    await refreshRoomState();
  } catch (e) { alert(e.message || e); }
};

const joinBtn = el('join-room');
const joinStatus = el('join-status');
if (joinBtn) joinBtn.onclick = () => joinByCode(el('join-code').value, joinStatus, joinBtn);

if (state.nickname && codeParam) joinByCode(codeParam, joinStatus, joinBtn);

// Копирование
const btnCopyCodeLobby = el('copy-code-lobby');
if (btnCopyCodeLobby) btnCopyCodeLobby.onclick = () => state.currentRoomCode && copy(state.currentRoomCode, btnCopyCodeLobby);

// Шаг 3 → 4
const btnStartGame = el('start-game');
if (btnStartGame) btnStartGame.onclick = async () => {
  try {
    // Сначала сохраняем настройки
    const targetScoreInput = el('target-score');
    const target = parseInt((targetScoreInput && targetScoreInput.value) || '0', 10) || 0;
    const qsInput = el('question-seconds');
    const secs = parseInt((qsInput && qsInput.value) || '60', 10) || 60;
    const src = (document.getElementById('qsrc-players')?.checked) ? 'players' : 'preset';
    await supabase.from('rooms').update({ target_score: target, question_seconds: secs, question_source: src }).eq('id', state.currentRoomId);
    if (targetScoreInput) { targetScoreInput.dataset.dirty=''; targetScoreInput.value=String(target); }
    if (qsInput) { qsInput.dataset.dirty=''; qsInput.value = String(secs); }
    const rbPreset  = document.getElementById('qsrc-preset');
    const rbPlayers = document.getElementById('qsrc-players');
    if (rbPreset && rbPlayers) {
      rbPreset.dataset.dirty=''; rbPlayers.dataset.dirty='';
      rbPreset.checked = (src === 'preset'); rbPlayers.checked = (src === 'players');
    }
  } catch (e) { console.error('Save settings before start failed:', e); }
  // Затем стартуем игру
  await startGameFromLobby();
};

// Шаг 4 (Раунд)
const btnShowScores = el('show-scores'); if (btnShowScores) btnShowScores.onclick = refreshRoomState;
const btnStartRound = el('start-round'); if (btnStartRound) btnStartRound.onclick = startRound;
const btnSubmit = el('submit-answer'); if (btnSubmit) btnSubmit.onclick = submitAnswer;
const btnSubmitCustom = el('submit-custom-question'); if (btnSubmitCustom) btnSubmitCustom.onclick = submitCustomQuestion;
const btnStartVoting = el('start-voting'); if (btnStartVoting) btnStartVoting.onclick = startVoting;
const btnLoadAnswers = el('load-answers'); if (btnLoadAnswers) btnLoadAnswers.onclick = loadAnswers;
const btnVote = el('vote'); if (btnVote) btnVote.onclick = vote;
const btnFinalize = el('finalize'); if (btnFinalize) btnFinalize.onclick = finalize;
const btnEndGame = el('end-game'); if (btnEndGame) btnEndGame.onclick = async () => {
  try {
    state.autoJumpToRound = false;          // блокируем автопереход
    await setActiveStatus(false);
    if (state.roomChannel) {                // снимем подписку комнаты
      try { supabase.removeChannel(state.roomChannel); } catch {}
      state.roomChannel = null;
    }
    const { cleanupSubscriptions } = await import('./round.js');
    if (cleanupSubscriptions) cleanupSubscriptions();
    state.currentRoundId = null;
    state.currentRoomId = null;
    state.roomPlayersCache = {};
  } finally {
    import('./state.js').then(({ showStep }) => showStep(2));
  }
};
const btnNextRound = el('next-round'); if (btnNextRound) btnNextRound.onclick = startRound;

// Перепривязка после загрузки, если элементы создаются/показываются динамически
document.addEventListener('DOMContentLoaded', () => {
  const b = el('submit-answer');
  if (b) b.onclick = submitAnswer;
});

// Сеть/видимость: управляем is_active
window.addEventListener('offline', () => { try { setActiveStatus(false); } catch {} });
window.addEventListener('online',  () => { try { setActiveStatus(true); }  catch {} });
document.addEventListener('visibilitychange', () => {
  try {
    if (document.hidden) setActiveStatus(false); else setActiveStatus(true);
  } catch {}
});
// Навигация/закрытие вкладки
window.addEventListener('pagehide', () => { try { setActiveStatus(false); } catch {} });
window.addEventListener('beforeunload', () => { try { setActiveStatus(false); } catch {} });

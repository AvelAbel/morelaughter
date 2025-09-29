import { supabase } from './supabaseClient.js';
// Background disabled
import { state, el, showStep } from './state.js';
import { updateInviteUI, copy, share } from './ui.js';
import { ensureUser, createRoom, joinByCode, startGameFromLobby, setActiveStatus } from './room.js';
import { refreshRoomState, startRound, submitAnswer, startVoting, loadAnswers, vote, finalize, submitCustomQuestion } from './round.js';

// Инициализация
(async () => {
  const { data } = await supabase.auth.getUser();
  state.currentUser = data?.user || null;
  updateInviteUI();
})();

// Параметр ?code=ABCD
const qp = new URLSearchParams(location.search);
const codeParam = (qp.get('code') || '').toUpperCase();
if (codeParam) el('join-code').value = codeParam;
// Поддержка параметра шага (?step=1..4) для навигации между экранами
const stepParam = parseInt(qp.get('step') || '', 10);
if (stepParam >= 1 && stepParam <= 4) {
  showStep(stepParam);
} else {
  showStep(state.nickname ? 2 : 1);
}
// После того как выбран шаг, подставляем ник (если нужно)
const nickEl = el('nick'); if (nickEl) nickEl.value = state.nickname;

// Шаг 1
async function handleSetNick() {
  const s = el('auth-status');
  try {
    const u = await ensureUser();
    if (!u) { if (s) s.textContent = 'Auth error'; return; }

    state.nickname = el('nick').value.trim() || 'Player';
    localStorage.setItem('demo_nick', state.nickname);
    el('nick-saved').textContent = `Сохранено: ${state.nickname}`;
    if (s) s.textContent = `uid: ${u.id.slice(0,8)}…`;
    // Переход на страницу выбора игры
    window.location.href = 'games.html';
  } catch (e) {
    if (s) s.textContent = 'Enable Anonymous auth in Supabase';
    alert(e?.message || e);
  }
}
const btnSetNick = el('set-nick'); if (btnSetNick) btnSetNick.onclick = handleSetNick;
const btnNickGo = el('nick-go'); if (btnNickGo) btnNickGo.onclick = handleSetNick;
if (nickEl) nickEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSetNick(); });

// Назад
const btnBack1 = el('back-1'); if (btnBack1) btnBack1.onclick = () => { window.location.href = 'games.html'; };
// Дублирующийся back-2 наверху: ведёт на шаг 2 (Подключение)
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
    } finally {
      showStep(2);
    }
  };
});
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
  // Блокируем кнопку и запускаем анимацию многоточия
  let dotsTimer = null;
  const originalHTML = btnCreateRoom.innerHTML;
  // Зафиксируем текущую ширину, чтобы кнопка не "скакала" во время анимации
  const rect = btnCreateRoom.getBoundingClientRect();
  const fixedWidth = Math.ceil(rect.width);
  try {
    btnCreateRoom.disabled = true;
    btnCreateRoom.classList.add('muted');
    btnCreateRoom.style.width = fixedWidth + 'px';
    // Строим стабильную разметку: базовый текст + фиксированный контейнер под точки (3ch)
    btnCreateRoom.innerHTML = '';
    const baseSpan = document.createElement('span');
    baseSpan.textContent = 'Создаем';
    const dotsSpan = document.createElement('span');
    dotsSpan.style.display = 'inline-block';
    dotsSpan.style.width = '3ch';
    dotsSpan.style.textAlign = 'left';
    dotsSpan.style.verticalAlign = 'baseline';
    btnCreateRoom.appendChild(baseSpan);
    btnCreateRoom.appendChild(dotsSpan);
    let n = 0;
    const renderDots = () => { n = (n + 1) % 4; dotsSpan.textContent = '.'.repeat(n); };
    renderDots();
    dotsTimer = setInterval(renderDots, 500);
    await createRoom();
    await refreshRoomState();
  } catch (e) {
    alert(e.message || e);
  } finally {
    if (dotsTimer) { clearInterval(dotsTimer); dotsTimer = null; }
    btnCreateRoom.innerHTML = originalHTML;
    btnCreateRoom.classList.remove('muted');
    btnCreateRoom.disabled = false;
    btnCreateRoom.style.width = '';
  }
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
  let dotsTimer = null;
  const originalHTML = btnStartGame.innerHTML;
  const rect = btnStartGame.getBoundingClientRect();
  // Вычислим требуемую ширину для текста "Начинаем..." и возьмём максимум
  let fixedWidth = Math.ceil(rect.width);
  try {
    const cs = window.getComputedStyle(btnStartGame);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const brdLeft = parseFloat(cs.borderLeftWidth) || 0;
    const brdRight = parseFloat(cs.borderRightWidth) || 0;
    const measure = document.createElement('span');
    measure.style.position = 'absolute';
    measure.style.visibility = 'hidden';
    measure.style.whiteSpace = 'nowrap';
    measure.style.font = cs.font;
    measure.textContent = 'Начинаем...';
    document.body.appendChild(measure);
    const textW = measure.getBoundingClientRect().width;
    document.body.removeChild(measure);
    const needW = Math.ceil(textW + padLeft + padRight + brdLeft + brdRight);
    fixedWidth = Math.max(fixedWidth, needW);
  } catch {}
  try {
    btnStartGame.disabled = true;
    btnStartGame.classList.add('muted');
    // Не допускаем переносов строки при анимации
    btnStartGame.style.whiteSpace = 'nowrap';
    btnStartGame.style.width = fixedWidth + 'px';
    // Стабильная разметка для анимации "Начинаем..."
    btnStartGame.innerHTML = '';
    const baseSpan = document.createElement('span');
    baseSpan.textContent = 'Начинаем';
    const dotsSpan = document.createElement('span');
    dotsSpan.style.display = 'inline-block';
    dotsSpan.style.width = '3ch';
    dotsSpan.style.textAlign = 'left';
    dotsSpan.style.verticalAlign = 'baseline';
    btnStartGame.appendChild(baseSpan);
    btnStartGame.appendChild(dotsSpan);
    let n = 0;
    const renderDots = () => { n = (n + 1) % 4; dotsSpan.textContent = '.'.repeat(n); };
    renderDots();
    dotsTimer = setInterval(renderDots, 500);

    // Сначала сохраняем настройки
    try {
      const targetScoreInput = el('target-score');
      const targetRaw = parseInt((targetScoreInput && targetScoreInput.value) || '0', 10) || 0;
      const target = Math.min(99, Math.max(1, targetRaw));
      const qsInput = el('question-seconds');
      const secsRaw = parseInt((qsInput && qsInput.value) || '60', 10) || 60;
      const secs = Math.min(999, Math.max(1, secsRaw));
      const vsInput = el('vote-seconds');
      const vsecsRaw = parseInt((vsInput && vsInput.value) || '45', 10) || 45;
      const vsecs = Math.min(999, Math.max(1, vsecsRaw));
      const srcSel = document.getElementById('qsrc-select');
      const src = (srcSel && (srcSel.value === 'players' || srcSel.value === 'preset')) ? srcSel.value : 'preset';
      await supabase.from('rooms').update({ target_score: target, question_seconds: secs, vote_seconds: vsecs, question_source: src }).eq('id', state.currentRoomId);
      if (targetScoreInput) { targetScoreInput.dataset.dirty=''; targetScoreInput.value=String(target); }
      if (qsInput) { qsInput.dataset.dirty=''; qsInput.value = String(secs); }
      if (vsInput) { vsInput.dataset.dirty=''; vsInput.value = String(vsecs); }
      const srcSelect = document.getElementById('qsrc-select');
      if (srcSelect) { srcSelect.dataset.dirty=''; srcSelect.value = src; }
    } catch (e) { console.error('Save settings before start failed:', e); }
    // Затем стартуем игру
    await startGameFromLobby();
  } catch (e) {
    alert(e?.message || e);
  } finally {
    if (dotsTimer) { clearInterval(dotsTimer); dotsTimer = null; }
    btnStartGame.innerHTML = originalHTML;
    btnStartGame.classList.remove('muted');
    btnStartGame.disabled = false;
    btnStartGame.style.width = '';
    btnStartGame.style.whiteSpace = '';
  }
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
    if (state.isHost && state.currentRoomId) {
      await supabase.from('rooms').update({
        status: 'archived',
        archived: true,
        archived_at: new Date().toISOString()
      }).eq('id', state.currentRoomId);
    }
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

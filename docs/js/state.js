export const state = {
  currentUser: null,
  currentRoomId: null,
  currentRoomCode: localStorage.getItem('last_room_code') || '',
  currentRoundId: null,
  nickname: localStorage.getItem('demo_nick') || '',
  selectedAnswerId: null,          // сохраняем выбор радиокнопки
  currentPhase: null,              // запомним фазу
  myVoted: false,                  // проголосовал ли текущий игрок в текущем раунде
  isHost: false,
  roomChannel: null,
  hostTransferLock: false,
  roomPlayersCache: {},
  finalizing: false,              // защита от повторной финализации
  autoJumpToRound: true,          // разрешить автопереход на шаг 4 при событиях
  customQuestionByRoundId: {}     // текст вопроса для режима players по roundId
};
export const el = (id) => document.getElementById(id);
export const steps = [el('step-1'), el('step-2'), el('step-3'), el('step-4')];
export function showStep(n) {
  steps.forEach(s => s.classList.add('hidden'));
  if (n>=1 && n<=4) steps[n-1].classList.remove('hidden');
  
  // Автоматически обновляем состояние комнаты при переходе в лобби
  if (n === 3 && state.currentRoomId) {
    // Импорт функции будет добавлен динамически
    import('./round.js').then(({ refreshRoomState }) => {
      refreshRoomState();
    });
  }
}

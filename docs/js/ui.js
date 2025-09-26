import { state, el } from './state.js';
export function updateInviteUI() {
  const rcLobby = el('room-code-lobby'); if (rcLobby) rcLobby.textContent = state.currentRoomCode || '';
  const rc2 = el('room-code-2'); if (rc2) rc2.textContent = state.currentRoomCode || '';
  const cLobby = el('copy-code-lobby'); if (cLobby) cLobby.classList.toggle('hidden', !state.currentRoomCode);
}

// Timers to revert copy feedback per element
const copyTimers = new WeakMap();

export async function copy(text, indicatorEl) {
  const showFeedback = (message, className) => {
    if (!indicatorEl) return;
    const originalText = indicatorEl.dataset.originalText ?? indicatorEl.textContent;
    indicatorEl.dataset.originalText = originalText;
    indicatorEl.textContent = message;
    if (className) indicatorEl.classList.add(className);
    if (typeof indicatorEl.disabled === 'boolean') indicatorEl.disabled = true;
    if (copyTimers.has(indicatorEl)) clearTimeout(copyTimers.get(indicatorEl));
    const t = setTimeout(() => {
      indicatorEl.textContent = indicatorEl.dataset.originalText || originalText;
      indicatorEl.classList.remove('copied', 'copy-failed');
      if (typeof indicatorEl.disabled === 'boolean') indicatorEl.disabled = false;
    }, 1200);
    copyTimers.set(indicatorEl, t);
  };

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showFeedback('Скопировано', 'copied');
      return;
    }
    // Fallback for older browsers/insecure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) showFeedback('Скопировано', 'copied'); else showFeedback('Не удалось', 'copy-failed');
  } catch (e) {
    showFeedback('Не удалось', 'copy-failed');
  }
}

export async function share(url) {
  if (navigator.share) {
    try { await navigator.share({ title: 'Join my game', text: 'Присоединяйся к игре', url }); }
    catch {}
  } else { await copy(url); }
}

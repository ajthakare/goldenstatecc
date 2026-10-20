/**
 * Browser wiring for the "Suggest Duties" button + 3-line panel, shared by the
 * availability modal (admin/availability) and the full-page editor
 * (admin/availability/[seasonId], used by the installed app).
 */
import { suggestDuties } from './duty-suggestions';
import type { DutyHistory, MatchPlayer } from './duty-suggestions';

export interface SuggesterContext {
  seasonId: string;
  fixtureId: string;
  players: (MatchPlayer & { wasSelected?: boolean })[];
  captainIds: string[];
  locked: boolean;
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createDutySuggester(els: {
  button: HTMLButtonElement;
  panel: HTMLElement;
  body: HTMLElement;
  close: HTMLElement;
  getContext: () => SuggesterContext | null;
}) {
  const { button, panel, body, close, getContext } = els;
  let history: DutyHistory | null = null;
  let historyFor = '';
  let loading = false;   // a history request is in flight; keep the button disabled

  const isOpen = () => panel.style.display !== 'none';

  function render(ctx: SuggesterContext) {
    if (!history) return;
    const suggestions = suggestDuties({
      history,
      selected: ctx.players.filter((p) => p.wasSelected),
      excludeIds: ctx.captainIds,
      seed: ctx.fixtureId,
    });
    body.innerHTML = suggestions
      .map((s) =>
        `<div class="duty-suggestions-line"><strong>${escape(s.duty)}:</strong> ${
          s.picks.length ? s.picks.map((p) => `${escape(p.name)} (${p.count})`).join(', ') : '—'
        }</div>`)
      .join('');
  }

  /** Call whenever the table re-renders: updates the button and an open panel. */
  function refresh() {
    const ctx = getContext();
    if (!ctx) return;
    if (historyFor !== ctx.fixtureId) {
      history = null;
      panel.style.display = 'none';
    }
    const selected = ctx.players.filter((p) => p.wasSelected).length;
    button.style.display = ctx.locked ? 'none' : '';
    button.disabled = loading || selected < 11;
    button.title = selected < 11 ? 'Select 11 players first' : '';
    if (ctx.locked || selected < 11) panel.style.display = 'none';
    if (isOpen()) render(ctx);
  }

  button.addEventListener('click', async () => {
    if (isOpen()) { panel.style.display = 'none'; return; }
    const ctx = getContext();
    if (!ctx) return;
    if (!history || historyFor !== ctx.fixtureId) {
      loading = true;
      button.disabled = true;
      button.textContent = 'Loading…';
      try {
        const resp = await fetch(
          `/.netlify/functions/availability-duty-history?seasonId=${encodeURIComponent(ctx.seasonId)}&fixtureId=${encodeURIComponent(ctx.fixtureId)}`,
        );
        if (!resp.ok) throw new Error('Failed to load duty history');
        history = await resp.json();
        historyFor = ctx.fixtureId;
      } catch (error) {
        console.error('Error loading duty history:', error);
        alert('Could not load past duties. Please try again.');
      } finally {
        loading = false;
        button.textContent = 'Suggest Duties';
        refresh();
      }
      // Fixture switched, or the XI dropped below 11, while loading
      if (!history || button.disabled) return;
    }
    panel.style.display = 'block';
    render(ctx);
  });

  close.addEventListener('click', () => { panel.style.display = 'none'; });

  return { refresh };
}

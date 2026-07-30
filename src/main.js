/**
 * main.js — entry point.
 *
 * Creates the Game, boots it, and installs global error handlers so any
 * unexpected failure shows a readable message instead of a black screen.
 */

// The stylesheet is linked from index.html so it applies before the first
// paint (no flash of unstyled loading screen); it is not imported here.
import { Game } from './Game.js';

const canvas = document.getElementById('game-canvas');

/** Render a fatal error into the error screen (and the console). */
function fatal(prefix, err) {
  console.error(prefix, err);
  const screen = document.getElementById('screen-error');
  const text = document.getElementById('error-text');
  if (!screen || !text) return;
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  document.getElementById('overlay')?.classList.remove('hidden');
  document.getElementById('hud')?.classList.add('hidden');
  text.textContent = `${prefix}\n\n${err?.message ?? err}\n\n${err?.stack ?? ''}`;
  screen.classList.add('active');
}

if (!canvas) {
  fatal('Could not find the game canvas.', new Error('#game-canvas missing'));
} else {
  const game = new Game(canvas);

  // Expose for debugging from the console: `__game.player.position`, etc.
  if (typeof window !== 'undefined') window.__game = game;

  window.addEventListener('error', (e) => {
    if (game.state === 'loading') fatal('Unhandled error during start-up.', e.error ?? e);
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (game.state === 'loading') fatal('Unhandled promise rejection during start-up.', e.reason);
  });

  game.init().catch((err) => fatal('The game failed to start.', err));

  // Vite HMR: dispose cleanly so hot reloads don't leak WebGL contexts,
  // physics worlds or event listeners.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => game.dispose());
  }
}

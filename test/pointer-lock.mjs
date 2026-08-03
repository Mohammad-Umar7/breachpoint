/**
 * Pointer lock — the one permission the whole game depends on.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * Pointer lock requires *transient user activation*: the browser only grants
 * it inside the handful of milliseconds following a real click. Starting a
 * match is not that. It is a chain of asynchronous work — resolve a region,
 * open a socket, agree a room, build an arena — and by the time the game is
 * ready to take the mouse, the click that started it has long since stopped
 * counting. Chrome refuses, quietly.
 *
 * What the player saw: a live match, rendering at full frame rate, with a
 * visible cursor and a mouse that did nothing. No error, no prompt. The only
 * way through was to open the pause menu and press RESUME — because THAT is a
 * click, and a click is a fresh activation.
 *
 * So the fix cannot be "ask again on a timer": every retry outside a gesture
 * fails for the same reason. It has to be "ask on the next click", and the
 * click has to be swallowed rather than fired, or the first shot of every
 * match is one the player never aimed.
 *
 * Run: node test/pointer-lock.mjs
 */

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};

/**
 * Just enough DOM for InputManager, and no more.
 *
 * A stub rather than a headless browser on purpose: what is being tested is a
 * decision this class makes about WHEN to ask, not whether Chrome says yes.
 */
function stubDom({ secure = true } = {}) {
  const listeners = new Map();
  const target = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const l = listeners.get(type);
      if (l) l.splice(l.indexOf(fn), 1);
    },
  };
  const fire = (type, event = {}) => {
    for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, ...event });
  };

  const canvas = {
    requests: [],
    ...target,
    requestPointerLock(opts) {
      canvas.requests.push(opts ?? null);
      // The real thing resolves or rejects later; a plain undefined return is
      // the pre-promise behaviour and is the least interesting case to model.
      return undefined;
    },
  };

  globalThis.window = {
    ...target,
    isSecureContext: secure,
  };
  globalThis.document = {
    ...target,
    hidden: false,
    pointerLockElement: null,
    exitPointerLock() { globalThis.document.pointerLockElement = null; },
  };
  // Node defines `navigator` as a getter-only global, so it has to be replaced
  // rather than assigned. Only `keyboard` is read, and only in fullscreen.
  Object.defineProperty(globalThis, 'navigator', {
    value: { keyboard: null }, configurable: true, writable: true,
  });
  return { canvas, fire };
}

const { InputManager } = await (async () => {
  stubDom();
  return import('../src/core/InputManager.js');
})();

// --------------------------------------------------- asking outside a gesture
{
  const { canvas, fire } = stubDom();
  const input = new InputManager(canvas);

  check('a fresh InputManager does not want the mouse',
    input.wantsPointerLock === false, String(input.wantsPointerLock));

  // What startGame() does, at the end of an async chain. The browser refuses.
  input.requestPointerLock();
  check('starting a match asks for the lock',
    canvas.requests.length === 1, `${canvas.requests.length} requests`);
  check('and records that the game wants it',
    input.wantsPointerLock === true, String(input.wantsPointerLock));

  // The refusal arrives as an error event, not as an exception.
  fire('pointerlockerror');
  check('a refusal is not mistaken for the player leaving',
    input.pointerLocked === false, 'still unlocked, not reported as a lock loss');

  /*
   * THE FIX. The next click re-asks, and this is the check that fails if the
   * relock is ever removed: the game is playable again, without the pause
   * menu detour that was the only way through before.
   */
  fire('mousedown', { button: 0 });
  check('the next click asks again, inside a real user gesture',
    canvas.requests.length === 2, `${canvas.requests.length} requests`);

  /*
   * And that click is spent on the lock, not on the trigger. A first shot the
   * player did not aim is worse than the bug: it fires their weapon, gives
   * away their position, and is indistinguishable from a misclick.
   */
  check('and is not also registered as a shot',
    input.mousePressed.size === 0 && input.mouseButtons.size === 0,
    `${input.mousePressed.size} pressed, ${input.mouseButtons.size} held`);
}

// ------------------------------------------------- not while a menu is open
{
  const { canvas, fire } = stubDom();
  const input = new InputManager(canvas);

  input.requestPointerLock();
  input.exitPointerLock();               // pause() does this
  check('pausing gives up wanting the mouse',
    input.wantsPointerLock === false, String(input.wantsPointerLock));

  const before = canvas.requests.length;
  fire('mousedown', { button: 0 });
  check('so a click on a menu button does not grab the mouse',
    canvas.requests.length === before, `${canvas.requests.length - before} extra requests`);
}

// ----------------------------------------------------- once it is actually ours
{
  const { canvas, fire } = stubDom();
  const input = new InputManager(canvas);
  input.requestPointerLock();

  globalThis.document.pointerLockElement = canvas;
  fire('pointerlockchange');
  check('the lock is noticed when it arrives',
    input.pointerLocked === true, String(input.pointerLocked));

  const before = canvas.requests.length;
  fire('mousedown', { button: 0 });
  check('and clicks go back to being shots',
    input.mousePressed.has(0) && canvas.requests.length === before,
    `${canvas.requests.length - before} extra requests, button ${[...input.mousePressed]}`);
}

// --------------------------------------------------------- insecure origins
{
  /*
   * `unadjustedMovement` — raw, unaccelerated mouse input — is only available
   * in a secure context. A LAN address like http://192.168.1.50:5173 is not
   * one, and asking for it there is REJECTED rather than downgraded. Asking
   * plainly from the start is what makes LAN play work at all.
   */
  const { canvas } = stubDom({ secure: false });
  const input = new InputManager(canvas);
  input.requestPointerLock();
  check('on an insecure origin the request is made plainly',
    canvas.requests.length === 1 && canvas.requests[0] === null,
    JSON.stringify(canvas.requests[0]));
}

{
  const { canvas } = stubDom({ secure: true });
  const input = new InputManager(canvas);
  input.requestPointerLock();
  check('and on a secure one it asks for raw input',
    canvas.requests[0]?.unadjustedMovement === true,
    JSON.stringify(canvas.requests[0]));
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

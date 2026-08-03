/**
 * Minimap — the overhead corner map.
 *
 * WHY A 2D CANVAS AND NOT A SECOND CAMERA
 * ---------------------------------------
 * The obvious implementation is an orthographic camera rendering the world to
 * a texture. That is a SECOND FULL RENDER of the scene every frame, and draw
 * calls are already this game's limiting factor — a seven-player match draws
 * 361 meshes, and rendering them twice to fill a 160-pixel square in the corner
 * would be the single most expensive thing on screen.
 *
 * So the level is drawn ONCE, as flat rectangles, into an offscreen canvas the
 * moment the arena is built. Per frame the map is a blit of that image plus a
 * handful of dots. It costs microseconds and never touches the GPU pipeline.
 *
 * WHAT IT SHOWS, AND WHY THAT IS THE INTERESTING PART
 * --------------------------------------------------
 * Not everyone, all the time. In a free-for-all that would remove every reason
 * to be careful — you would simply read the map and know. Instead a player
 * appears for a couple of seconds WHEN THEY FIRE, which is the convention most
 * shooters settled on because it makes noise a real decision: shooting tells
 * the room where you are.
 *
 * That works here for free, because the server already relays every shot to
 * everyone (MSG.FIRE) so other players can be seen and heard firing. The map is
 * a second reader of a stream that already exists.
 */

/** How long a player stays on the map after firing. */
const BLIP_SECONDS = 2.4;

/** Metres of world shown across the map at default zoom. */
const SPAN_METRES = 70;

const COLOURS = {
  background: 'rgba(6, 11, 15, 0.78)',
  wall: 'rgba(126, 148, 166, 0.52)',
  wallEdge: 'rgba(170, 196, 214, 0.30)',
  grid: 'rgba(255, 255, 255, 0.05)',
  self: '#7fd4ff',
  blip: '#e8654f',
  pickupHealth: 'rgba(99, 209, 154, 0.75)',
  pickupArmor: 'rgba(127, 180, 255, 0.7)',
  pickupAmmo: 'rgba(224, 182, 79, 0.7)',
};

export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} level  needs `mapShapes` and `pickupSpots`
   */
  constructor(canvas, level) {
    this.canvas = canvas;
    this.level = level;
    this.ctx = canvas.getContext('2d');
    this.enabled = true;

    /** id -> seconds remaining. Filled by noteShot(). */
    this.blips = new Map();
    this._tmpBlips = [];

    // Backing store at device resolution so it is not a blurry square on a
    // high-DPI screen, while CSS keeps it the same physical size.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = canvas.clientWidth || 168;
    canvas.width = Math.round(this.size * dpr);
    canvas.height = Math.round(this.size * dpr);
    this.ctx.scale(dpr, dpr);

    this._buildStatic();
  }

  /**
   * Draw the level once, centred on the arena, into an offscreen canvas.
   *
   * Rebuilt only if the level is rebuilt, which is never during a match.
   */
  _buildStatic() {
    const shapes = this.level?.mapShapes ?? [];
    // Twice the visible span, so the map can be panned around the player
    // without running out of drawn world at the edges.
    const world = SPAN_METRES * 2;
    const px = this.size * 2;
    this.staticScale = px / world;
    this.staticPx = px;

    const off = document.createElement('canvas');
    off.width = px;
    off.height = px;
    const c = off.getContext('2d');
    const toPx = (v) => v * this.staticScale + px / 2;

    // A faint grid, so movement reads as movement even in an empty yard.
    c.strokeStyle = COLOURS.grid;
    c.lineWidth = 1;
    for (let m = -world / 2; m <= world / 2; m += 10) {
      c.beginPath();
      c.moveTo(toPx(m), 0); c.lineTo(toPx(m), px);
      c.moveTo(0, toPx(m)); c.lineTo(px, toPx(m));
      c.stroke();
    }

    c.fillStyle = COLOURS.wall;
    c.strokeStyle = COLOURS.wallEdge;
    c.lineWidth = 1;
    for (const s of shapes) {
      c.save();
      c.translate(toPx(s.x), toPx(s.z));
      if (s.rotY) c.rotate(s.rotY);
      const w = s.hx * 2 * this.staticScale;
      const h = s.hz * 2 * this.staticScale;
      c.fillRect(-w / 2, -h / 2, w, h);
      if (w > 3 && h > 3) c.strokeRect(-w / 2, -h / 2, w, h);
      c.restore();
    }

    this.static = off;
    this.shapeCount = shapes.length;
  }

  /**
   * Somebody fired — put them on the map for a moment.
   *
   * Called for OTHER players from the gunfire relay. Firing is the one action
   * that should cost you your position.
   */
  noteShot(playerId) {
    if (playerId != null) this.blips.set(playerId, BLIP_SECONDS);
  }

  /** Forget everyone — on leaving a match, so blips do not survive into the next. */
  clear() { this.blips.clear(); }

  /**
   * @param {number} dt
   * @param {{position: {x:number,z:number}, yaw: number}} player
   * @param {Map<number, object>|null} sample  interpolated remote positions
   */
  update(dt, player, sample) {
    for (const [id, left] of this.blips) {
      const next = left - dt;
      if (next <= 0) this.blips.delete(id);
      else this.blips.set(id, next);
    }
    if (!this.enabled || !this.ctx || !this.static) return;

    const ctx = this.ctx;
    const size = this.size;
    const r = size / 2;
    const scale = size / SPAN_METRES;

    ctx.clearRect(0, 0, size, size);

    // Round window, so the map does not read as a rectangle of the world.
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = COLOURS.background;
    ctx.fillRect(0, 0, size, size);

    /*
     * NORTH-UP, not rotated with the player.
     *
     * A map that spins under you is harder to read at a glance and is why
     * rotating minimaps are usually a setting rather than the default. The
     * player's own arrow carries the heading instead.
     */
    ctx.save();
    ctx.translate(r, r);
    ctx.drawImage(
      this.static,
      -player.position.x * scale - (this.staticPx / this.staticScale) * scale / 2,
      -player.position.z * scale - (this.staticPx / this.staticScale) * scale / 2,
      (this.staticPx / this.staticScale) * scale,
      (this.staticPx / this.staticScale) * scale,
    );

    // Pickups, so the map is useful when nobody is shooting.
    for (const spot of this.level?.pickupSpots ?? []) {
      const x = (spot.pos.x - player.position.x) * scale;
      const z = (spot.pos.z - player.position.z) * scale;
      if (Math.hypot(x, z) > r) continue;
      ctx.fillStyle = spot.type === 'health' ? COLOURS.pickupHealth
        : spot.type === 'armor' ? COLOURS.pickupArmor : COLOURS.pickupAmmo;
      ctx.fillRect(x - 1.5, z - 1.5, 3, 3);
    }

    // Anyone who has fired recently.
    for (const [id, left] of this.blips) {
      const p = sample?.get(id);
      if (!p) continue;
      const x = (p.x - player.position.x) * scale;
      const z = (p.z - player.position.z) * scale;
      if (Math.hypot(x, z) > r - 3) continue;
      ctx.globalAlpha = Math.min(1, left / BLIP_SECONDS);
      ctx.fillStyle = COLOURS.blip;
      ctx.beginPath();
      ctx.arc(x, z, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // The player: an arrow at the centre, pointing where they are looking.
    ctx.save();
    ctx.translate(r, r);
    // World yaw 0 faces -Z, which is UP on a north-up map, so the arrow is
    // drawn pointing up and rotated by the yaw directly.
    ctx.rotate(-player.yaw);
    ctx.fillStyle = COLOURS.self;
    ctx.beginPath();
    ctx.moveTo(0, -5.5);
    ctx.lineTo(3.5, 4);
    ctx.lineTo(0, 2);
    ctx.lineTo(-3.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // Ring, drawn last so nothing overlaps it.
    ctx.strokeStyle = 'rgba(160, 190, 210, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * ObjectPool — a tiny fixed-capacity free list.
 *
 * Used for tracers, decals, particles and shell casings so that no per-shot
 * allocation happens during gameplay (allocation is the main source of GC
 * hitching in a JS game loop).
 */
export class ObjectPool {
  /**
   * @param {number} capacity   Maximum simultaneous live objects.
   * @param {() => any} factory Creates one object.
   * @param {(o:any) => void} [reset] Called when an object is released.
   */
  constructor(capacity, factory, reset = null) {
    this.capacity = capacity;
    this.factory = factory;
    this.reset = reset;
    this.items = new Array(capacity);
    this.free = new Array(capacity);
    this.active = [];
    for (let i = 0; i < capacity; i++) {
      const obj = factory(i);
      this.items[i] = obj;
      this.free[i] = obj;
    }
  }

  /** @returns {any|null} An object from the pool, or null when exhausted. */
  acquire() {
    const obj = this.free.pop();
    if (!obj) return null;
    this.active.push(obj);
    return obj;
  }

  /**
   * Acquire, recycling the oldest active object when the pool is exhausted.
   * Ideal for decals/particles where dropping is worse than replacing.
   */
  acquireOrRecycle() {
    const obj = this.free.pop();
    if (obj) {
      this.active.push(obj);
      return obj;
    }
    const oldest = this.active.shift();
    if (!oldest) return null;
    if (this.reset) this.reset(oldest);
    this.active.push(oldest);
    return oldest;
  }

  release(obj) {
    const i = this.active.indexOf(obj);
    if (i === -1) return;
    this.active.splice(i, 1);
    if (this.reset) this.reset(obj);
    this.free.push(obj);
  }

  /** Release by active-array index — cheap when iterating backwards. */
  releaseAt(index) {
    const obj = this.active[index];
    if (obj === undefined) return;
    this.active.splice(index, 1);
    if (this.reset) this.reset(obj);
    this.free.push(obj);
  }

  releaseAll() {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const obj = this.active[i];
      if (this.reset) this.reset(obj);
      this.free.push(obj);
    }
    this.active.length = 0;
  }

  get activeCount() {
    return this.active.length;
  }
}

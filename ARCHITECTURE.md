# Architecture — where things live, and what to touch

This exists to answer one question quickly: **"I want to change X. Where do I
go, and what will I break?"**

Everything below is checkable. `npm test` proves the wiring still holds, and
`npm run deps <thing>` tells you the blast radius *before* you cut.

---

## The rule that matters most

**Nothing is coupled by magic — it is coupled by NAMES.** A DOM id in a string,
a sound looked up by name, a weapon pointing at a model id, a message type the
server sends and the client switches on. None of that is checked by the build.
Rename an element in `index.html` and the JavaScript still compiles perfectly,
then hands you a `null` when somebody opens a menu three screens in.

That is why `test/contracts.mjs` exists. It checks every one of those promises
in under a second. If you add a new name-based link, add a check for it there.

---

## Modules, and what each one owns

| Area | Owns | Notes |
|---|---|---|
| `src/Game.js` | Boot, the main loop, the state machine, wiring everything together | The big one. Adding a feature usually means a few lines here |
| `src/core/` | Settings, input, asset loading, sensitivity, quality detection | `AssetManager` owns every model, material and texture **by name** |
| `src/player/` | The local player: movement, camera, vitals, lean | Movement runs on the fixed physics step; look runs per frame |
| `src/weapons/` | Weapon behaviour, view model, ADS, recoil | `WeaponDefinitions.js` is **data** — most weapon changes are only here |
| `src/net/` | Multiplayer: protocol, client, other players' bodies and sounds | `protocol.js` is shared with the server — it is the contract |
| `src/world/` | The arena geometry and pickups | |
| `src/fx/`, `src/audio/` | Particles, post-processing, scope, all sound | Sounds are **synthesised**, looked up by name |
| `src/ui/` | HUD (`UIManager`) and menus (`MenuManager`) | Both reference `index.html` ids as strings |
| `server/` | The authoritative game server | Owns health, damage, kills, score, spawns, match state |

### The client/server split

The server is the sole authority over **health, armour, damage, who died, who
killed whom, score, respawn timing, match state and spawn points**. The client
is trusted (with validation) about **its own position, orientation and animation
flags**.

If you find yourself changing health on the client, stop. It will be overwritten
by the next server update. That mistake has been made three separate times here
— health packs, armour and grenade self-damage all did nothing for exactly this
reason.

---

## Shared things — the traps

These are used by more than one area. Changing or deleting one has effects
somewhere you are not looking. **Run `npm run deps <name>` before touching any
of them.**

| Thing | Owned by | Also used by |
|---|---|---|
| `soldier.glb` + character part pivots | `AssetManager` | `RemotePlayers` builds every multiplayer body from it |
| `soldierFatigues` / `Skin` / `Helmet` / `Visor` materials | `AssetManager` | `RemotePlayers` builds every player body from them |
| `darkGear` material | `AssetManager` | Vests, gun furniture and grenade bodies — declared shared in `contracts.mjs` |
| `src/net/protocol.js` | shared | **Both** the client and the server import it. Change it and you must change both ends, or old clients break |
| `WEAPON_DEFS` | `WeaponDefinitions.js` | Client damage, server damage validation, the loadout UI |
| `TAG_KIND` | `PhysicsWorld` | Every raycast filter in the weapons and player code |
| `body.phase` / `body.speed` | `RemotePlayers._animate` | `RemoteAudio` reads both to place footsteps on the visible footfall — renaming either silences every player |
| `MATCH_RULES.killCam*` / `respawn*` | `protocol.js` | The death sequence spans the server (when you may come back) and three client files (replay, countdown, camera). The totals are DERIVED — change a phase, not a total |

> A real example. The player-body materials used to be named `enemyFatigues`,
> `enemyVest`, `enemySkin`. Nothing said they were also what every multiplayer
> body is made of — the names implied the opposite. Deleting the AI would have
> silently taken multiplayer's player models with it.
>
> Three lessons, all now enforced. **Name things after what they are, not after
> what happens to use them** — the same trap had a second instance, a material
> called `soldierVest` that gun parts were quietly borrowing; it is `darkGear`
> now. **Ask `npm run deps` before you cut.** And any asset used from more than
> one area must be listed in `SHARED_BY_DESIGN` in `test/contracts.mjs`, so a
> new accidental coupling fails the build until somebody decides it on purpose.

---

## Recipes

### Add a weapon
1. `src/weapons/WeaponDefinitions.js` — add the entry (this is data; copy a
   similar weapon and change the numbers)
2. `src/core/AssetManager.js` — add the model if it needs a new one
3. `npm test` — contracts check the model resolves, the sounds exist and every
   field the damage maths reads is present

Nothing else. The loadout menu is generated from `WEAPON_DEFS`.

### Add a network message
Four files, in this order:
1. `src/net/protocol.js` — declare it in `MSG` with a comment describing the payload
2. `server/index.js` — send it, and/or add a `case` to handle it
3. `src/net/NetworkClient.js` — add a `case` to decode it into a callback
4. `src/Game.js` — wire the callback to something visible

`npm test` then verifies both directions: every message one side sends, the
other side handles.

### Add a sound
1. `src/audio/AudioManager.js` — add the synth function
2. Play it with `audio.play('yourName', { position })`

Contracts check the name resolves. Positional sounds need a `position`.

### Change something the HUD shows
1. `index.html` — the markup
2. `src/ui/UIManager.js` — read the element by id, update it in `updateHud`
3. `src/Game.js` `_pushHud` — pass the value in

Contracts check every id you reference exists.

### Delete a feature
1. `npm run deps <file>` — see who imports it
2. `npm run deps <name>` for each thing it owns — see what is shared
3. Delete, then `npm test`
4. `npm run deps -- --unused` — catch anything orphaned by the removal

---

## Checking your work

```bash
npm test                      # every suite, ~2 min
npm test -- contracts         # just the wiring checks, ~1 second
npm run deps <file|name>      # blast radius before you cut
npm run deps -- --unused      # files nothing imports
npm run build                 # catches syntax and bad imports
npm run bot -- BUDDY 2        # two practice players, to look at it yourself
```

`npm test` starts and stops a game server itself. New suites are picked up
automatically — drop a file in `test/*.mjs` or `server/*-test.js` and it runs.

### Things only a second player can show you

Plenty of this is not testable from a server suite: whether a footstep lands on
the visible footfall, whether a spawn shield reads as protection or as broken
hit registration, whether a name tag sits at the right height. `npm run bot`
puts a player in the room who walks, sprints, crouches, jumps, reloads and
fires, so any of that can be checked alone in about ten seconds.

Two of them (`npm run bot -- BUDDY 2`) is enough to take a match LIVE without
you joining, which is what most match-state behaviour needs.

Add `hunt` — `npm run bot -- BUDDY 1 hunt` — and it comes after you and shoots.
That is the only way to reach anything that happens when you DIE: the kill cam,
the respawn sequence, the damage direction indicator.

### A warning about tests that pass

A check that silently examines *nothing* passes, and reads as a green tick. One
in `contracts.mjs` did exactly that: it split the weapon table on `\n  {\n`,
found nothing in a CRLF file, and reported success having checked zero weapons.
Any check that counts things now prints the count, so an empty run is visible.
When you add a check, make it say how much it looked at.

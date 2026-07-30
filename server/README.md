# Breachpoint game server

Free-for-all deathmatch server. Node + `ws`, no database, no build step.

```bash
cd server
npm install
npm start                 # ws://localhost:8787
node smoke-test.js        # 26 assertions against a running server
```

`GET /health` returns live room and player counts, which is also what a host's
health check hits.

## How it decides things

A **relay with validation**, not a fully authoritative simulation. Each browser
runs its own physics — the same Rapier code single-player used — and reports
where it ended up. The server checks the report is not absurd and owns
everything players would otherwise argue about.

| | decided by |
|---|---|
| position, orientation, animation flags | **client**, server-validated |
| health, damage, who died | **server** |
| score, kill attribution | **server** |
| respawn timing and spawn point | **server** |
| match state and clock | **server** |

This is the pragmatic split: it needs no headless physics, so the game is
playable now, while the things that matter for fairness are decided in one
place. Moving position authority to the server later does **not** change the
wire protocol — see the header of [`src/net/protocol.js`](../src/net/protocol.js).

**It is not cheat-proof.** A determined person can aimbot or fake positions
within the validation limits. For playing with friends that is irrelevant, and
the upgrade path does not require a rewrite.

### What is validated

- **Teleports and speed hacks** — per-input distance cap and a sustained-speed
  cap. Failing either snaps the player back rather than kicking them; a lag
  spike must not eject a real player.
- **Arena bounds** — positions far outside the level are refused.
- **Fire rate**, per weapon, from the client's own `rpm`. Tracked per weapon so
  switching guns cannot beat the limit.
- **Damage** is never client-supplied. The client claims *"I hit player 4 in the
  head with the rifle"*; the server looks the numbers up itself.
- **Range**, against where the victim actually was when the shot was fired
  (see lag compensation below).
- **Flooding** — per-second message and input caps.

Limits live in `LIMITS` in `protocol.js` and are deliberately generous.

### Lag compensation

Clients render other players ~110 ms in the past so movement interpolates
smoothly. Judging a shot against a victim's *current* position would therefore
punish anyone shooting a moving target. Each player keeps ~1 s of position
history, and a shot is judged against `now - (ping + interpolation delay)`.

### Single source of truth

The server imports `../src/weapons/WeaponDefinitions.js` and `../src/net/arena.js`
**directly**. Damage, fire rates and spawn points therefore cannot drift from
the client. A copy here would go stale the first time a weapon was rebalanced,
and the symptom — legitimate hits being quietly rejected — is very hard to
diagnose from the browser.

---

## Hosting it

Two separate things, and this is the part that is not obvious: the **game files**
go on a CDN, and the **server** is a long-lived process somewhere else. A static
host cannot run the server, because it has to hold open connections and state.

### 1. The client → Cloudflare Pages (free)

```bash
npm run build          # from the repo root -> dist/
```

Connect the repo at <https://dash.cloudflare.com> → Pages, build command
`npm run build`, output directory `dist`. It redeploys on every push. Vercel and
Netlify work identically.

### 2. The server → Fly.io (~$0–5/month)

```bash
fly launch --no-deploy      # once; fly.toml is already in the repo root
fly deploy
fly status                  # note the hostname
```

Then point the client at it by setting `VITE_SERVER_URL` in the Pages build
environment:

```
VITE_SERVER_URL=wss://your-app.fly.dev
```

**Add regions as you get players.** Ping is the entire game in a shooter — a
player in Dubai on a US server sits around 200 ms and hitscan feels broken:

```bash
fly regions add fra sin      # Frankfurt, Singapore
fly scale count 3
```

Fly routes each player to the nearest instance. This is what Krunker's region
picker is doing.

### Other hosts

| | notes |
|---|---|
| Railway / Render | simplest; usually one region on cheap tiers |
| VPS (Hetzner, ~€4/mo) | most control, most admin, one region |
| Cloudflare Durable Objects | elegant per-room model, awkward for a 30 Hz tick |

Any host works provided it runs a persistent Node process and allows
WebSockets. Put TLS in front of it in production — browsers on `https://` will
refuse a plaintext `ws://` connection.

# Recorded sounds (optional)

Everything in Breachpoint is synthesised at runtime by `src/audio/AudioManager.js`.
That keeps the repo asset-free, but synthesis has a hard ceiling: a real gunshot
is a supersonic pressure wave clipping a microphone, and no arrangement of
oscillators and filters is going to be mistaken for a recording of one.

**Drop a file in this folder and it replaces the synthesised sound.** Nothing
else to change — `AudioManager.play()` checks for a loaded sample before it
falls back to the synth.

## How

Name the file after the sound and use `.ogg`, `.wav` or `.mp3`:

```
public/audio/shootRifle.ogg
public/audio/shootSniper.wav
```

Files are loaded when a match starts. Every one is optional and every failure is
silent, so you can add them one at a time and the game keeps working the whole
way.

## Names it looks for

| File name        | Used for                        |
| ---------------- | ------------------------------- |
| `shootRifle`     | M4-style carbine                |
| `shootPistol`    | M9                              |
| `shootShotgun`   | Pump shotgun                    |
| `shootMagnum`    | Revolver                        |
| `shootBurst`     | Burst-fire rifle                |
| `shootSmg`       | SMG                             |
| `shootLmg`       | LMG                             |
| `shootSniper`    | AWM                             |
| `shootMarksman`  | Marksman rifle                  |
| `shootEnemy`     | AI weapons                      |
| `reload`         | Reload                          |
| `reloadEmpty`    | Reload from empty               |
| `explosion`      | Grenades                        |
| `hitmarker`      | Landing a hit                   |
| `killConfirm`    | Getting a kill                  |

## What to use

Keep gunshots short — trim to the shot itself, roughly 300–600 ms including its
tail. Long files overlap badly during automatic fire.

Sources that are free to use commercially, no attribution required:

- **freesound.org** — filter the search by licence to **Creative Commons 0**
- **OpenGameArt.org** — filter to **CC0**
- **Sonniss GDC Game Audio Bundle** — released free for commercial game use each
  year, and it is genuinely professional material

Check the licence on anything you download. Most gunshot sounds on the internet
are copyrighted, and a "free download" is usually free-as-in-preview rather than
free to ship in a game you put online.

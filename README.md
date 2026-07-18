# Split-Screen Pong 3D

A fast, flashy 3D take on Pong for **2–4 players**, built with [Three.js](https://threejs.org/). Runs entirely in the browser — no install, no build step.

## Play

**▶ https://landonring.github.io/split-screen-pong-3d/**

## Modes

- **2 players** — classic head-to-head in a textured 3D arena (or play **1 player vs. a bot** on Easy/Medium/Hard).
- **3–4 players** — a triangle (3P) or square (4P) arena with N-way split screen. Each player defends one edge; miss and you lose a life, get eliminated at 0, last one standing wins.

## Controls

| | Move | Shoot |
|---|---|---|
| **Player 1** | `W A S D` / left stick (mouse in 3–4P) | `Space` / L2 |
| **Player 2** | Arrow keys / right stick | `/` / R2 |
| **Player 3 / 4** | Gamepads (left stick) | R2 |

- **C / △** switch camera view · **F** fullscreen · **M** mute
- **Phone / tablet:** drag to move your paddle, with on-screen buttons to shoot and switch camera view.
- All keybinds, per-channel volumes (music / ball / gunshots) and cursor sensitivity are editable in **⚙ Settings**.
- Controller users get a joystick-driven reticle cursor for the menus.

## Power-ups

Hit the floating power-ups with the ball: **Multi-ball**, **Magnet**, **Big paddle**, **Speed up**, **Shotgun** (5 blasts to knock the ball back), **Spin arena**, and **Vines** (slow an opponent).

## Tech

Plain ES modules — `index.html` + a handful of `.js` files. Three.js loads from a CDN via an import map; the arena and shotgun are `.glb` models. Audio is fully synthesized (WebAudio chiptune), so there are no sound files to load.

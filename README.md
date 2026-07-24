# Split-Screen Pong 3D

A fast, flashy 3D take on Pong for **2–4 players**, built with [Three.js](https://threejs.org/). Runs entirely in the browser — no install, no build step.

## Play

**▶ https://landonring.github.io/split-screen-pong-3d/**

## Modes

- **2 players** — classic head-to-head in a textured 3D arena (or play **1 player vs. a bot** on Easy/Medium/Hard).
- **3–4 players** — a triangle (3P) or square (4P) arena with N-way split screen. Each player defends one edge; miss and you lose a life, get eliminated at 0, last one standing wins.
- **Online, by invite code** — play together on different devices.

## Online (invite codes)

One person picks **🌐 PLAY ONLINE** and gets a 4-letter code (plus a **COPY INVITE LINK** button — the link opens the game with the code already filled in). Everyone else picks **JOIN WITH CODE** and types it.

Each device says how many people are sitting at it (**PLAYERS ON THIS DEVICE: 1 or 2**), so you can have two players split-screen on a laptop and a third on a tablet across the room. Up to 4 players total; 2 players get the classic arena, 3–4 get the polygon arena.

**Every device only renders its own players' views** — you never see anyone else's screen, just their score/lives on your HUD (remote players show up in the `ELSEWHERE` strip). The host runs the physics and streams the world; everyone predicts their own paddle locally, so it stays responsive. Power-ups are off in online 1v1.

It's peer-to-peer over WebRTC (PeerJS's free broker is used only to introduce the devices, with public TURN relays as a fallback for strict networks) — no game server, and it works across the internet, not just your Wi-Fi.

## Head tracking

**⚙ Settings → HEAD TRACKING → ON** turns on your webcam and steers Player 1's paddle with your head: lean left/right and up/down and the ball follows where you go. Adjust **head sensitivity**, flip **mirror**, and hit **RECENTER** to set your neutral position. Uses the browser's face detector when it has one, and a skin-tone tracker everywhere else. Everything is processed on-device — no video is uploaded or recorded.

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

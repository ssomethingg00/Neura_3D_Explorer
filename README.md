# NEURA · 3D EXPLORER

> Real-time 3D visualisation of the **Neura Protocol** testnet (Chain 267).
> Every pulse you see is a real on-chain transaction — rescanned live from the RPC every 15 seconds.

![Dashboard overview](github_readme.md_image/4.png)

---

## What it does

NEURA 3D Explorer turns Neura testnet activity into a navigable star map.
Wallets and contracts orbit a central hub on Fibonacci-distributed sphere shells, scaled by their lifetime on-chain footprint. Live transactions appear as pulses travelling along the edges between addresses.

- **Scans live blocks every 15s** straight from `testnet.rpc.neuraprotocol.io`
- **~500 slotted nodes** across 14 shells (stable layout across scans)
- **Address focus / route mode** highlights every counterparty an address has ever talked to
- **ALL TIME ROUTE** paginates the full Blockscout history for a single address
- **5 colour themes** (Mono · Cyan · Amber · Magenta · Emerald)
- **Idle showcase tour** — camera auto-flies between nodes and edges when you stop interacting
- **Persistent state** — your graph survives reloads via `localStorage`

---

## Screenshots

### 3D node graph

The whole chain as a Fibonacci sphere — contracts are isometric cubes, wallets are shaded spheres, edges show transactional relationships.

![3D node graph](github_readme.md_image/5.png)

### Focus & route mode

Click any node (or search a `0x…` address) to lock the camera onto it and light up every edge it touches.

![Focused address route](github_readme.md_image/6.png)
![ALL TIME route burst](github_readme.md_image/1.png)

### Address details panel

Click a node to open a live address profile — creation, creator, lifetime TX, today's TX, token transfers, scanner-seen TX, and a direct link to Blockscout.

![Pinned address panel](github_readme.md_image/2.png)

### Control panel & themes

Flip labels, toggle the depth-grid globe, watch scan status in real time, and retint the entire UI with one click.

![Control panel and themes](github_readme.md_image/3.png)

---

## Tech

- **React 18** + **Vite 5**
- **viem** for RPC (custom `defineChain` for Neura testnet, chain id `267`)
- **Blockscout REST API** for per-address counters & paginated tx history
- **Pure SVG** for the 3D renderer — orbit camera, perspective projection, painter's algorithm depth sort, per-node wobble
- **No three.js**, no canvas — just maths and CSS

---

## Quick start

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
npm run preview
```

The app talks directly to:

- RPC — `https://testnet.rpc.neuraprotocol.io/`
- Explorer — `https://testnet-blockscout.infra.neuraprotocol.io`

No API keys, no backend.

---

## Controls

| Action | Input |
| --- | --- |
| Orbit camera | Click + drag |
| Pan | Shift + drag |
| Dolly (zoom) | Mouse wheel · pinch · `+` / `−` buttons |
| Reset view | `⟲` button |
| Focus a node | Click it · or search `0x…` in FIND |
| Toggle route highlight | `ROUTE` button |
| Pull entire history | `ALL TIME ROUTE` button |
| Resize every node from on-chain counters | `RESIZE ALL` button |
| Exit fullscreen | `Esc` |

---

## Project layout

```
src/
 ├ App.jsx        — shell, nav, hero, stats, footer, theme state
 ├ NodeGraph.jsx  — 3D camera, projection, showcase tour, SVG renderer, panels
 ├ chain.js       — RPC scanner, slot algorithm, Blockscout API, persistence
 └ palette.js     — five colour themes (single source of truth)
styles.css        — all styling (theme tokens via CSS vars)
```

---

## Built by

**[@ssomethingg00](https://github.com/ssomethingg00)**

- GitHub — [github.com/ssomethingg00](https://github.com/ssomethingg00)
- Twitter / X — [@ssomethingg00](https://x.com/ssomethingg00)
- Source — [github.com/ssomethingg00/Neura_3D_Explorer](https://github.com/ssomethingg00/Neura_3D_Explorer)

---

## Neura Protocol

- [neuraprotocol.io](https://www.neuraprotocol.io)
- [docs.neuraprotocol.io](https://docs.neuraprotocol.io)
- [Blockscout testnet](https://testnet-blockscout.infra.neuraprotocol.io)
- [Testnet faucet](https://faucet.neuraprotocol.io)

// ──────────────────────────────────────────────────────────────────────
// Per-mode colour palette — single source of truth.
//
// Every theme defines its OWN values for every slot below, tinted to
// match the theme name. Edit any hex to retune that slot for that mode.
// Vite HMR picks the change up instantly while dev server is running.
//
// Keys per mode:
//   accent       — UI accent (titles, buttons, glows)
//   glow         — soft halo colour for accent (rgba)
//   active2      — node colour: Active < 2 min
//   active10     — node colour: Active < 10 min
//   idle         — node colour: idle fallback (no kind tint)
//   idleEoa      — idle wallet tint
//   idleContract — idle contract tint
//   pulseLive    — live transaction pulse
//   pulseReplay  — replay / historical pulse
//   focused      — focused address ring + route edges
//   pinned       — pinned node highlight (when not focused)
// ──────────────────────────────────────────────────────────────────────

export const PALETTES = {
  // ── MONO ── pure grayscale. Only `active2` and `focused` keep a chromatic
  // accent so "Active <2 min" wallets + the focus reticle pop at a glance.
  mono: {
    accent:       "#ffffff",
    glow:         "rgba(255,255,255,0.18)",
    active2:      "#4df60b",
    active10:     "#d4d4d4",
    idle:         "#444444",
    idleEoa:      "#a3a3a3",
    idleContract: "#737373",
    pulseLive:    "#ffffff",
    pulseReplay:  "#888888",
    focused:      "#ef4444",
    pinned:       "#fafafa",
  },

  // ── CYAN ── teal / ocean / electric-blue family.
  cyan: {
    accent:       "#22d3ee",
    glow:         "rgba(34,211,238,0.22)",
    active2:      "#2dd4bf",
    active10:     "#cffafe",
    idle:         "#3b4f57",
    idleEoa:      "#38bdf8",
    idleContract: "#0e7490",
    pulseLive:    "#22d3ee",
    pulseReplay:  "#1d4ed8",
    focused:      "#f43f5e",
    pinned:       "#67e8f9",
  },

  // ── AMBER ── warm gold / orange / sand family.
  amber: {
    accent:       "#f5b942",
    glow:         "rgba(245,185,66,0.22)",
    active2:      "#facc15",
    active10:     "#fef3c7",
    idle:         "#57433a",
    idleEoa:      "#d4a373",
    idleContract: "#b45309",
    pulseLive:    "#f5b942",
    pulseReplay:  "#ea580c",
    focused:      "#ef4444",
    pinned:       "#fbbf24",
  },

  // ── MAGENTA ── hot-pink / violet / fuchsia family.
  magenta: {
    accent:       "#ec4899",
    glow:         "rgba(236,72,153,0.22)",
    active2:      "#ec4899",
    active10:     "#fce7f3",
    idle:         "#3b2a3e",
    idleEoa:      "#a78bfa",
    idleContract: "#c026d3",
    pulseLive:    "#f472b6",
    pulseReplay:  "#7c3aed",
    focused:      "#84cc16",
    pinned:       "#f9a8d4",
  },

  // ── EMERALD ── jade / mint / forest family.
  emerald: {
    accent:       "#34d399",
    glow:         "rgba(52,211,153,0.22)",
    active2:      "#22c55e",
    active10:     "#d1fae5",
    idle:         "#1f3a2d",
    idleEoa:      "#5eead4",
    idleContract: "#047857",
    pulseLive:    "#34d399",
    pulseReplay:  "#84cc16",
    focused:      "#ef4444",
    pinned:       "#a7f3d0",
  },
};

export const MODE_NAMES = {
  mono:    "MONO",
  cyan:    "CYAN",
  amber:   "AMBER",
  magenta: "MAGENTA",
  emerald: "EMERALD",
};

export function getPalette(mode) {
  return PALETTES[mode] || PALETTES.mono;
}

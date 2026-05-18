import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  SCAN_INTERVAL_MS,
  EXPLORER_URL,
  shortLabel,
  fetchAddressInfo,
  fetchAddressCounters,
  fetchAddressTodayCount,
  fetchTxTimestamp,
} from "./chain.js";

// Fallback palette — kept inline so the file is self-contained if a caller
// forgets to pass one in. The live values come from src/palette.js via the
// `palette` prop (see App.jsx).
const FALLBACK_PALETTE = {
  active2:      "#4df60b",
  active10:     "#ffffff",
  idle:         "#555555",
  idleEoa:      "#5b8ec2",
  idleContract: "#c79545",
  pulseLive:    "#0759E5",
  pulseReplay:  "#f5b942",
  focused:      "#ef4444",
  pinned:       "#22d3ee",
};

function makeNodeColor(palette) {
  return function nodeColor(n) {
    if (n.status === "veryActive") return palette.active2;
    if (n.status === "active30")   return palette.active10;
    if (n.kind === "eoa")          return palette.idleEoa;
    if (n.kind === "contract")     return palette.idleContract;
    return palette.idle;
  };
}

const PULSE_DURATION_MS = 2200;

// Camera params — distance from origin, where smaller = closer (= bigger).
// DIST_MIN is tiny so zoom-in can fly arbitrarily deep into the cluster
// (the project3d zc>=-1 guard drops anything behind the camera). DIST_MAX
// is capped tight at the full-overview distance so zoom-out can't pull
// the sphere into a useless tiny speck — that's the user-asked behavior.
const DIST_MIN = 5;
const DIST_MAX = 350;
const DIST_DEFAULT = 280;
const FOCAL = 60;       // perspective focal length (in viewBox units)
const PITCH_LIMIT = Math.PI / 2 - 0.05; // avoid singularity at the poles

// Idle-tour ("showcase") tuning — after this many ms of no pointer activity
// on the globe, the camera starts running guided scenes (zoom on a random
// node, traverse along an edge). In route mode, scenes restrict to the
// focused address's neighbours / edges so the user always sees its path.
const SHOWCASE_IDLE_MS = 3000;
const SHOWCASE_ZOOM_DURATION = 4500;
const SHOWCASE_PATH_DURATION = 6000;
// Gap between showcase scenes — kept at 0 so the camera never visibly
// holds still between scenes. Each new scene's phase-1 eases from the
// previous scene's end view (passed as startView), so the transition
// blends and the motion reads as one continuous tour.
const SHOWCASE_GAP_MS = 0;
const SHOWCASE_ZOOM_DISTANCE = 140;
const SHOWCASE_PATH_DISTANCE = 180;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// Per-node continuous drift. Without it the Fibonacci-sphere placement reads
// as a static spiral — the user said wallet/contract dots look "muda hua".
// Each node gets a stable phase derived from its address, then oscillates on
// three independent sin/cos lobes so paths trace smooth curves instead of
// straight back-and-forth. Edges and pulses look up node positions through
// `project` / interpolate from wobbled endpoints, so connections track the
// drift and the route stays visually attached while everything moves.
const WOBBLE_AMP_HUB = 0.9;
const WOBBLE_AMP = 1.9;
const WOBBLE_SPEED = 0.00055;

function addrPhase(addr) {
  if (!addr) return 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < addr.length; i++) {
    h = Math.imul(h ^ addr.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) / 0xFFFFFFFF) * Math.PI * 2;
}

function wobbleOffset(node, now) {
  if (!node || !node.addr) return { dx: 0, dy: 0, dz: 0 };
  const ph = node._wobblePh != null ? node._wobblePh : (node._wobblePh = addrPhase(node.addr));
  const t = now * WOBBLE_SPEED;
  const amp = node.isHub ? WOBBLE_AMP_HUB : WOBBLE_AMP;
  return {
    dx: Math.sin(t + ph) * amp,
    dy: Math.cos(t * 0.83 + ph * 1.7) * amp,
    dz: Math.sin(t * 1.17 + ph * 2.3) * amp,
  };
}

// Clamp camera so distance stays in range and pitch never crosses the pole.
// panX/panY clamps are wide (±300) because cursor-targeted wheel zoom can
// drift the look-at point far off-center when the user zooms in deep on a
// node that's nowhere near the middle of the viewport.
function clampView(v) {
  return {
    yaw: Number.isFinite(v.yaw) ? v.yaw : 0,
    pitch: clamp(Number.isFinite(v.pitch) ? v.pitch : 0, -PITCH_LIMIT, PITCH_LIMIT),
    distance: clamp(Number.isFinite(v.distance) ? v.distance : DIST_DEFAULT, DIST_MIN, DIST_MAX),
    panX: clamp(Number.isFinite(v.panX) ? v.panX : 0, -300, 300),
    panY: clamp(Number.isFinite(v.panY) ? v.panY : 0, -300, 300),
  };
}

// Project a 3D world point through the orbit camera onto the 2D viewBox.
// Returns null if the point falls behind the camera.
function project3d(wx, wy, wz, view) {
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
  // Yaw (Y axis): rotate around vertical axis
  const x1 = wx * cy + wz * sy;
  const z1 = -wx * sy + wz * cy;
  const y1 = wy;
  // Pitch (X axis): tilt camera up/down
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;
  // Translate along -Z so camera sits at +distance
  const zc = z2 - view.distance;
  if (zc >= -1) return null; // behind / too close to camera plane
  const scale = FOCAL / -zc;
  return {
    x: 50 + x1 * scale + view.panX,
    y: 50 + y2 * scale + view.panY,
    depth: -zc,
    scale,
  };
}

// Smooth easing for showcase camera interpolation.
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Yaw + pitch needed to bring a world-space point to screen centre under
// the orbit camera. Pitch is clamped so the camera never crosses the pole.
function lookAtAngles(node) {
  const wx = node.x || 0, wy = node.y || 0, wz = node.z || 0;
  const yaw = Math.atan2(-wx, wz);
  const horiz = Math.sqrt(wx * wx + wz * wz);
  const pitch = clamp(Math.atan2(wy, horiz), -PITCH_LIMIT, PITCH_LIMIT);
  return { yaw, pitch };
}

// Pick the equivalent target yaw that's within ±π of `from`, so the camera
// always rotates the short way around the globe instead of doing a 350°
// swing when ±π wraps.
function shortestYaw(from, to) {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta;
}

function interpView(a, b, t) {
  return {
    yaw: a.yaw + (b.yaw - a.yaw) * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    distance: a.distance + (b.distance - a.distance) * t,
    panX: a.panX + (b.panX - a.panX) * t,
    panY: a.panY + (b.panY - a.panY) * t,
  };
}

function fmtTs(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtRel(ms, now) {
  if (!ms) return "—";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}

const HISTORICAL_WINDOW_MS = 15_000;

export default function NodeGraph({
  nodes,
  edges,
  byAddr,
  pulseQueue,
  consumePulse,
  scanStatus,
  txHistory,
  loadAddress,
  loadAddressAll,
  setLifetimeTx,
  beginBulkSizing,
  endBulkSizing,
  expandNeighbors,
  setProtectedAddrs,
  edgeCountsRaw,
  showLabels,
  showGrid,
  fullscreen,
  setFullscreen,
  palette,
}) {
  const pal = palette || FALLBACK_PALETTE;
  const nodeColor = useMemo(() => makeNodeColor(pal), [pal]);
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const rafRef = useRef(0);
  const [aspect, setAspect] = useState(1);
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);

  // Orbit camera: yaw + pitch around origin, distance = zoom, pan offsets
  // for translating the projected scene on screen. Small default pitch keeps
  // silhouette nearly circular but adds enough tilt that depth reads as 3D
  // instead of revealing the Fibonacci-sphere spiral as a flat pattern.
  const [view, setView] = useState({
    yaw: 0, pitch: 0.2, distance: DIST_DEFAULT, panX: 0, panY: 0,
  });
  const dragRef = useRef(null);
  const pinchRef = useRef(null);
  // Auto-rotate while idle so the user immediately sees it as a 3D body.
  const autoSpinRef = useRef(true);

  // Idle-tour ("showcase") refs. When the user hasn't moved the pointer on
  // the globe for SHOWCASE_IDLE_MS, the camera starts running guided scenes
  // (zoom into a random node, fly along an edge). Any pointer activity on
  // the SVG resets the timer and cancels the active scene immediately.
  const lastActivityRef = useRef(performance.now());
  const showcaseRef = useRef({ scene: null, pausedUntil: 0 });
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const byAddrRef = useRef(byAddr);
  const routeInfoRef = useRef(null);
  const focusedAddrRef = useRef(null);
  const routeModeRef = useRef(false);

  // Time slider — null = LIVE; otherwise timestamp (ms) of historical position
  const [historicalTime, setHistoricalTime] = useState(null);
  const isLive = historicalTime === null;

  // Address search / route focus
  const [searchInput, setSearchInput] = useState("");
  const [focusedAddr, setFocusedAddr] = useState(null);
  const [routeMode, setRouteMode] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  // ALL TIME pull state shared between the search-bar button and the
  // pinned-panel button so progress is consistent wherever the user starts.
  const [allTimeLoading, setAllTimeLoading] = useState(false);
  const [allTimeProgress, setAllTimeProgress] = useState({ fetched: 0, page: 0, merged: 0 });
  const allTimeCtrlRef = useRef(null);

  // Bulk-resize: scanner fetches lifetime counters only 8/scan, so node sizes
  // lag behind real on-chain footprint. This button pulls counters for every
  // visible node in parallel and resizes them immediately via setLifetimeTx.
  const [sizingAll, setSizingAll] = useState(false);
  const [sizingProgress, setSizingProgress] = useState({ done: 0, total: 0 });
  const sizingCtrlRef = useRef(null);

  const refreshAllSizes = useCallback(async () => {
    if (sizingAll) {
      if (sizingCtrlRef.current) sizingCtrlRef.current.abort();
      return;
    }
    if (!nodes || nodes.length === 0 || !setLifetimeTx) return;
    const ctrl = new AbortController();
    sizingCtrlRef.current = ctrl;
    const addrs = nodes.map((n) => n.addr).filter(Boolean);
    setSizingAll(true);
    setSizingProgress({ done: 0, total: addrs.length });

    // Suspend slot recomputes for the whole pass — without this, 500 nodes
    // = 500 computeStableSlots calls in seconds and the layout reshuffles
    // every frame. endBulkSizing() does one final recompute at the end.
    if (beginBulkSizing) beginBulkSizing();

    const CONCURRENCY = 6;
    let idx = 0;
    let done = 0;
    const worker = async () => {
      while (!ctrl.signal.aborted) {
        const i = idx++;
        if (i >= addrs.length) return;
        const a = addrs[i];
        try {
          const data = await fetchAddressCounters(a, ctrl.signal);
          if (ctrl.signal.aborted) return;
          const sent = data && data.transactions_count != null ? Number(data.transactions_count) : 0;
          const tokens = data && data.token_transfers_count != null ? Number(data.token_transfers_count) : 0;
          setLifetimeTx(a, sent + tokens);
        } catch (e) {
          // User-aborted: stop quietly. Other failures: leave this addr at
          // whatever the scanner had.
          if (e && e.name === "AbortError") return;
        }
        done++;
        setSizingProgress({ done, total: addrs.length });
      }
    };
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      if (endBulkSizing) endBulkSizing();
      setSizingAll(false);
      if (sizingCtrlRef.current === ctrl) sizingCtrlRef.current = null;
    }
  }, [nodes, setLifetimeTx, sizingAll, beginBulkSizing, endBulkSizing]);

  const runAllTime = useCallback(async (rawAddr) => {
    if (!loadAddressAll || !rawAddr) return null;
    if (allTimeLoading) {
      if (allTimeCtrlRef.current) allTimeCtrlRef.current.abort();
      return null;
    }
    const ctrl = new AbortController();
    allTimeCtrlRef.current = ctrl;
    setAllTimeLoading(true);
    setAllTimeProgress({ fetched: 0, page: 0, merged: 0 });
    setFocusedAddr(rawAddr);
    setRouteMode(true);
    setSearchError(null);
    const result = await loadAddressAll(rawAddr, {
      signal: ctrl.signal,
      onProgress: ({ page, fetched }) => setAllTimeProgress((p) => ({ ...p, page, fetched })),
    });
    setAllTimeLoading(false);
    allTimeCtrlRef.current = null;
    if (result && result.ok) {
      setAllTimeProgress((p) => ({ ...p, merged: result.merged || 0 }));
      // Force route mode on so the freshly-loaded edges immediately light up
      setRouteMode(true);
    } else if (result && result.aborted) {
      setSearchError(`Cancelled · merged ${result.merged || 0}`);
    } else {
      setSearchError((result && result.error) || "All-time load failed");
    }
    return result;
  }, [loadAddressAll, allTimeLoading]);

  const handleAllTime = () => {
    const target = focusedAddr || (/^0x[0-9a-f]{40}$/.test(searchInput.trim().toLowerCase()) ? searchInput.trim().toLowerCase() : null);
    if (!target) {
      setSearchError("Enter or focus an address first");
      return;
    }
    runAllTime(target);
  };

  // Whenever a node becomes "focused" (via search or click), make sure its
  // pinned panel is open so the user has the ROUTE / ALL TIME ROUTE controls.
  useEffect(() => {
    if (!focusedAddr) return;
    if (pinned && pinned.addr === focusedAddr) return;
    const node = byAddr.get(focusedAddr);
    if (node) setPinned(node);
  }, [focusedAddr, byAddr, pinned]);

  // Lock the focus + its top counterparties so the scanner can't shuffle
  // them out from under the route view. Recomputes whenever the focus
  // changes OR when new edges arrive for the focused address.
  useEffect(() => {
    if (!setProtectedAddrs) return;
    if (!focusedAddr) {
      setProtectedAddrs([]);
      return;
    }
    const counter = new Map();
    if (edgeCountsRaw) {
      for (const key of Object.keys(edgeCountsRaw)) {
        const sep = key.indexOf("|");
        if (sep < 0) continue;
        const from = key.slice(0, sep);
        const to = key.slice(sep + 1);
        if (from === focusedAddr && to !== focusedAddr) {
          counter.set(to, (counter.get(to) || 0) + edgeCountsRaw[key]);
        } else if (to === focusedAddr && from !== focusedAddr) {
          counter.set(from, (counter.get(from) || 0) + edgeCountsRaw[key]);
        }
      }
    }
    // Cap to avoid filling the entire layout with low-volume neighbours.
    const top = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);
    const protect = [focusedAddr, ...top.map(([a]) => a)];
    setProtectedAddrs(protect);
  }, [focusedAddr, edgeCountsRaw, setProtectedAddrs]);

  // Switching focus = new address = clear out the previous ALL TIME badge so
  // "ALL TIME · +500" from the last address doesn't bleed into this one.
  useEffect(() => {
    setAllTimeProgress({ fetched: 0, page: 0, merged: 0 });
  }, [focusedAddr]);

  // On unmount, cancel any in-flight long-running fetches so their setState
  // callbacks never land on a torn-down component.
  useEffect(() => {
    return () => {
      if (allTimeCtrlRef.current) allTimeCtrlRef.current.abort();
      if (sizingCtrlRef.current) sizingCtrlRef.current.abort();
    };
  }, []);

  const handleSearch = async (e) => {
    e.preventDefault();
    const v = searchInput.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(v)) {
      setSearchError("Invalid format (0x + 40 hex)");
      setFocusedAddr(null);
      return;
    }
    setSearchError(null);
    if (byAddr.has(v)) {
      setFocusedAddr(v);
      return;
    }
    // Not in our current graph — backfill via Blockscout API
    if (!loadAddress) {
      setSearchError("Not in current graph.");
      setFocusedAddr(v);
      return;
    }
    setSearchLoading(true);
    setFocusedAddr(v);
    setRouteMode(true);
    const result = await loadAddress(v);
    setSearchLoading(false);
    if (!result || !result.ok) {
      setSearchError(result?.error || "Could not fetch address");
      return;
    }
    if (result.totalItems === 0) {
      setSearchError("No txs found on chain for that address");
    }
  };
  const clearFocus = () => {
    setFocusedAddr(null);
    setRouteMode(false);
    setSearchInput("");
    setSearchError(null);
    setSearchLoading(false);
  };

  // Route address set — every counterparty the focused address has ever
  // transacted with, pulled from raw edgeCounts (not just the top-N edges).
  // We also produce a synthetic edge list so even rare edges (single tx,
  // unique counterparty) appear in route mode — this is what the user
  // expects when they search a wallet and click ROUTE.
  const routeInfo = useMemo(() => {
    if (!focusedAddr) return { addrs: null, edges: null, extraEdges: null };
    const source = edgeCountsRaw || {};
    const addrs = new Set([focusedAddr]);
    const edgeKeys = new Set();
    const extraEdges = [];
    for (const key of Object.keys(source)) {
      const sep = key.indexOf("|");
      if (sep < 0) continue;
      const from = key.slice(0, sep);
      const to = key.slice(sep + 1);
      if (from === focusedAddr || to === focusedAddr) {
        addrs.add(from);
        addrs.add(to);
        edgeKeys.add(key);
        // Only push as a renderable edge if both endpoints are in the layout.
        if (byAddr.has(from) && byAddr.has(to)) {
          extraEdges.push({ from, to, count: source[key] });
        }
      }
    }
    return { addrs, edges: edgeKeys, extraEdges };
  }, [focusedAddr, edgeCountsRaw, byAddr]);

  // Mirror props/derived state into refs so the RAF showcase loop (mounted
  // once) always sees the latest snapshot when picking scenes.
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { byAddrRef.current = byAddr; }, [byAddr]);
  useEffect(() => { routeInfoRef.current = routeInfo; }, [routeInfo]);
  useEffect(() => { focusedAddrRef.current = focusedAddr; }, [focusedAddr]);
  useEffect(() => { routeModeRef.current = routeMode; }, [routeMode]);
  // Drop any in-flight scene when the route context changes so the next
  // showcase pick uses the new node/edge pool immediately.
  useEffect(() => { showcaseRef.current.scene = null; }, [routeMode, focusedAddr]);


  // active pulses with start times (assigned when pulse enters queue)
  const [activePulses, setActivePulses] = useState([]);
  const knownPulseIds = useRef(new Set());

  useEffect(() => {
    const update = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.width > 0) {
        const next = r.width / r.height;
        if (Number.isFinite(next) && next > 0) setAspect(next);
      }
    };
    update();
    const id = setTimeout(update, 50);
    window.addEventListener("resize", update);
    let ro = null;
    if (typeof ResizeObserver !== "undefined" && wrapRef.current) {
      ro = new ResizeObserver(update);
      ro.observe(wrapRef.current);
    }
    return () => {
      window.removeEventListener("resize", update);
      clearTimeout(id);
      if (ro) ro.disconnect();
    };
  }, [fullscreen]);

  // re-clamp view whenever aspect changes so stale pan offsets can't strand the camera off-canvas
  useEffect(() => {
    setView((v) => clampView(v));
  }, [aspect]);

  // RAF tick — animates pulses AND drives both the gentle auto-spin (until
  // first interaction) and the showcase tour (kicks in after SHOWCASE_IDLE_MS
  // of no pointer activity on the globe). Pitch breathes gently around 0.2
  // (sin wave, ±0.18 rad) so the Fibonacci sphere spiral never sits still
  // long enough to read as a flat pattern.
  useEffect(() => {
    let last = performance.now();
    let t0 = performance.now();

    // Pick the next showcase scene. In route mode we only ever pick from
    // the focused address's neighbours / edges — that's the "route move
    // only" rule the user asked for. Outside route mode we sample the
    // entire layout.
    const pickShowcaseScene = (now, currentView) => {
      const allNodes = nodesRef.current;
      const allEdges = edgesRef.current;
      const byA = byAddrRef.current;
      if (!allNodes || allNodes.length === 0) return null;
      const inRoute = !!(routeModeRef.current && focusedAddrRef.current);
      const routeI = routeInfoRef.current;

      let nodePool = allNodes;
      let edgePool = allEdges || [];

      if (inRoute && routeI && routeI.addrs) {
        nodePool = allNodes.filter((n) => routeI.addrs.has(n.addr));
        if (nodePool.length === 0) nodePool = allNodes;
        const seen = new Set();
        const merged = [];
        const consider = (e) => {
          const k = e.from + "|" + e.to;
          if (seen.has(k)) return;
          if (!byA || !byA.has(e.from) || !byA.has(e.to)) return;
          seen.add(k);
          merged.push(e);
        };
        if (routeI.extraEdges) routeI.extraEdges.forEach(consider);
        if (allEdges && routeI.edges) {
          allEdges.forEach((e) => {
            if (routeI.edges.has(e.from + "|" + e.to)) consider(e);
          });
        }
        edgePool = merged;
      }

      const validNodes = nodePool.filter((n) =>
        Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)
      );
      const validEdges = edgePool.filter((e) => {
        const a = byA && byA.get(e.from);
        const b = byA && byA.get(e.to);
        return a && b
          && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)
          && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z);
      });
      if (validNodes.length === 0) return null;

      // In route mode, paths are the more informative scene (they actually
      // visualise the route), so weight them heavily. Outside route mode,
      // mix evenly between "zoom on a wallet/contract" and "trace an edge".
      const pathWeight = inRoute ? 0.8 : 0.5;
      const wantPath = validEdges.length > 0 && Math.random() < pathWeight;

      if (wantPath) {
        const e = validEdges[Math.floor(Math.random() * validEdges.length)];
        const a = byA.get(e.from);
        const b = byA.get(e.to);
        return {
          type: "path",
          startTime: now,
          duration: SHOWCASE_PATH_DURATION,
          fromNode: a,
          toNode: b,
          startView: { ...currentView },
        };
      }
      const node = validNodes[Math.floor(Math.random() * validNodes.length)];
      return {
        type: "zoom",
        startTime: now,
        duration: SHOWCASE_ZOOM_DURATION,
        node,
        startView: { ...currentView },
      };
    };

    const computeShowcaseView = (scene, now) => {
      const t = clamp((now - scene.startTime) / scene.duration, 0, 1);

      if (scene.type === "zoom") {
        const target = lookAtAngles(scene.node);
        const closeYaw = shortestYaw(scene.startView.yaw, target.yaw);
        const closeView = {
          yaw: closeYaw,
          pitch: target.pitch,
          distance: SHOWCASE_ZOOM_DISTANCE,
          panX: 0,
          panY: 0,
        };
        // Phase 1 — ease in. Phase 2 — hold + slow yaw drift. Phase 3 —
        // ease back out to a neutral mid-distance view.
        if (t < 0.35) {
          const e = easeInOut(t / 0.35);
          return interpView(scene.startView, closeView, e);
        }
        if (t < 0.65) {
          const drift = (t - 0.35) * 0.40;
          return { ...closeView, yaw: closeView.yaw + drift };
        }
        const heldYaw = closeView.yaw + 0.30 * 0.40;
        const restView = {
          yaw: heldYaw + 0.4,
          pitch: 0.2,
          distance: DIST_DEFAULT,
          panX: 0,
          panY: 0,
        };
        const e = easeInOut((t - 0.65) / 0.35);
        return interpView({ ...closeView, yaw: heldYaw }, restView, e);
      }

      if (scene.type === "path") {
        const fromTarget = lookAtAngles(scene.fromNode);
        const toTarget = lookAtAngles(scene.toNode);
        const yawA = shortestYaw(scene.startView.yaw, fromTarget.yaw);
        const yawB = shortestYaw(yawA, toTarget.yaw);
        const fromView = {
          yaw: yawA, pitch: fromTarget.pitch,
          distance: SHOWCASE_PATH_DISTANCE, panX: 0, panY: 0,
        };
        const toView = {
          yaw: yawB, pitch: toTarget.pitch,
          distance: SHOWCASE_PATH_DISTANCE, panX: 0, panY: 0,
        };

        // Phase 1 — settle on FROM. Phase 2 — fly to TO with a small
        // dolly-back arc so the whole path stays on screen. Phase 3 —
        // pull back to a neutral view.
        if (t < 0.20) {
          const e = easeInOut(t / 0.20);
          return interpView(scene.startView, fromView, e);
        }
        if (t < 0.80) {
          const phase = (t - 0.20) / 0.60;
          const e = easeInOut(phase);
          const v = interpView(fromView, toView, e);
          const arc = Math.sin(e * Math.PI) * 35;
          return { ...v, distance: v.distance + arc };
        }
        const restView = {
          yaw: yawB + 0.3, pitch: 0.2,
          distance: DIST_DEFAULT, panX: 0, panY: 0,
        };
        const e = easeInOut((t - 0.80) / 0.20);
        return interpView(toView, restView, e);
      }
      return null;
    };

    const loop = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setTick((x) => (x + 1) % 1_000_000);

      const idleMs = now - lastActivityRef.current;
      const showcaseEligible = idleMs > SHOWCASE_IDLE_MS && now >= showcaseRef.current.pausedUntil;

      setView((prev) => {
        if (showcaseEligible) {
          let scene = showcaseRef.current.scene;
          if (scene && now - scene.startTime > scene.duration) {
            // Scene finished — clear and schedule a brief gap before the
            // next one picks. The gap lets the rest-view linger.
            showcaseRef.current.scene = null;
            showcaseRef.current.pausedUntil = now + SHOWCASE_GAP_MS;
            scene = null;
          }
          if (!scene) {
            scene = pickShowcaseScene(now, prev);
            if (scene) showcaseRef.current.scene = scene;
          }
          if (scene) {
            const v = computeShowcaseView(scene, now);
            if (v) return clampView(v);
          }
        }

        if (autoSpinRef.current) {
          const phase = (now - t0) / 1000;
          const pitchBreath = 0.2 + 0.18 * Math.sin(phase * 0.35);
          return { ...prev, yaw: prev.yaw + 0.10 * dt, pitch: pitchBreath };
        }
        return prev;
      });

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ingest new pulses from queue, stagger their start times across the 15s window.
  // Historical mode pauses ingestion so live pulses don't accumulate while reviewing.
  useEffect(() => {
    if (!isLive) return;
    if (pulseQueue.length === 0) return;
    const fresh = pulseQueue.filter((p) => !knownPulseIds.current.has(p.id));
    if (fresh.length === 0) return;
    const now = performance.now();
    const spread = SCAN_INTERVAL_MS - PULSE_DURATION_MS;
    const staggered = fresh.map((p, i) => {
      const t = fresh.length === 1 ? 0 : (i / (fresh.length - 1)) * Math.max(0, spread);
      knownPulseIds.current.add(p.id);
      return { ...p, startedAt: now + t };
    });
    setActivePulses((prev) => [...prev, ...staggered]);
  }, [pulseQueue, isLive]);

  // when leaving live, drop active pulses; when entering live, clear ledger so new pulses come in fresh
  useEffect(() => {
    if (!isLive) {
      setActivePulses([]);
      knownPulseIds.current.clear();
    }
  }, [isLive]);

  // garbage-collect finished pulses
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      setActivePulses((prev) => {
        const alive = prev.filter((p) => now - p.startedAt < PULSE_DURATION_MS + 100);
        const dead = prev.filter((p) => now - p.startedAt >= PULSE_DURATION_MS + 100);
        if (dead.length) {
          dead.forEach((p) => {
            knownPulseIds.current.delete(p.id);
            consumePulse(p.id);
          });
        }
        return alive;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [consumePulse]);

  const ar = clamp(Number.isFinite(aspect) ? aspect : 1, 0.5, 4);
  const vbW = 100 * ar;
  const vbH = 100;
  const vbX = -(vbW - 100) / 2;
  const vbY = 0;
  // 3D camera — no viewBox zoom. Always render full viewBox; perspective
  // handles the apparent zoom via camera distance.
  const zoomedW = vbW;
  const zoomedH = vbH;
  const zoomedX = vbX;
  const zoomedY = vbY;

  // 3D → 2D projection bound to current camera state. Adds the per-address
  // wobble so every wallet/contract dot drifts smoothly each frame; edges
  // call this same function for both endpoints, so routes track the drift
  // and stay visually connected.
  const project = (n) => {
    const w = wobbleOffset(n, nowPerf);
    return project3d((n.x || 0) + w.dx, (n.y || 0) + w.dy, (n.z || 0) + w.dz, view);
  };

  // Closer camera → more detail visible (use distance instead of zoom).
  const labelMode = view.distance < 50 ? "full" : view.distance < 80 ? "short" : "hub-only";

  // Any pointer activity on the globe resets the idle timer and instantly
  // cancels any in-flight showcase scene so the user takes back control.
  const markActivity = useCallback(() => {
    lastActivityRef.current = performance.now();
    if (showcaseRef.current.scene) showcaseRef.current.scene = null;
    showcaseRef.current.pausedUntil = 0;
  }, []);

  // Wheel → dolly camera in/out, anchored at the cursor position.
  // We shift panX/panY so the world point that was under the cursor BEFORE
  // the dolly still projects to the cursor AFTER. Math: a world point at
  // viewBox offset (dx) from look-at projects to dx*FOCAL/distance; if
  // distance scales by f, the offset scales by 1/f. So to keep the cursor
  // pinned, the look-at must shift by (cursorOff - panOld) * (1 - 1/f).
  const onWheel = useCallback((e) => {
    e.preventDefault();
    autoSpinRef.current = false;
    markActivity();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const vb = svg.viewBox.baseVal; // current rendered viewBox (handles aspect)
    const cx = (e.clientX - rect.left) / rect.width;
    const cy = (e.clientY - rect.top) / rect.height;
    // Cursor offset from viewBox center (50, 50). Always in viewBox units.
    const curOffX = (vb.x + cx * vb.width) - 50;
    const curOffY = (vb.y + cy * vb.height) - 50;
    setView((v) => {
      const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
      const newDist = clamp(v.distance * factor, DIST_MIN, DIST_MAX);
      if (newDist === v.distance) return v;
      const f = newDist / v.distance; // actual factor after clamp
      const newPanX = curOffX - (curOffX - v.panX) / f;
      const newPanY = curOffY - (curOffY - v.panY) / f;
      return clampView({ ...v, distance: newDist, panX: newPanX, panY: newPanY });
    });
  }, [markActivity]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Pointer down → orbit drag (or pan if shift held)
  const onPointerDown = (e) => {
    markActivity();
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const svg = svgRef.current;
    if (!svg) return;
    // Skip orbit setup if the pointer is on a node — let the click fire.
    const onNode = e.target && e.target.closest && e.target.closest('[data-node-addr]');
    if (onNode && e.pointerType !== "touch") return;

    svg.setPointerCapture(e.pointerId);
    autoSpinRef.current = false; // first user interaction stops auto-spin

    if (e.pointerType === "touch") {
      const pts = pinchRef.current ? pinchRef.current.pts : new Map();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinchRef.current = {
          pts,
          startDist: Math.hypot(a.x - b.x, a.y - b.y),
          startDistance: view.distance,
        };
        dragRef.current = null;
        return;
      }
      pinchRef.current = { pts };
      if (onNode) return;
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startYaw: view.yaw,
      startPitch: view.pitch,
      startPanX: view.panX,
      startPanY: view.panY,
      pan: !!(e.shiftKey || e.button === 2 || e.pointerType === "mouse" && e.buttons === 4),
      moved: false,
    };
  };

  const onPointerMove = (e) => {
    // Pointer-move always counts as activity — even hover without drag — so
    // the showcase tour stays paused while the user is exploring.
    markActivity();
    if (pinchRef.current && pinchRef.current.pts) {
      const entry = pinchRef.current.pts.get(e.pointerId);
      if (entry) {
        entry.x = e.clientX; entry.y = e.clientY;
        if (pinchRef.current.pts.size === 2 && pinchRef.current.startDist) {
          const [a, b] = [...pinchRef.current.pts.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const factor = pinchRef.current.startDist / dist; // closer fingers → farther camera
          setView((v) => clampView({ ...v, distance: pinchRef.current.startDistance * factor }));
          return;
        }
      }
    }
    const drag = dragRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dxPix = e.clientX - drag.startX;
    const dyPix = e.clientY - drag.startY;
    if (Math.hypot(dxPix, dyPix) > 3) drag.moved = true;

    if (drag.pan) {
      // Translate in screen-space. Scale factor mirrors a unit-pixel pan.
      const unitsX = (vbW / rect.width) * dxPix;
      const unitsY = (vbH / rect.height) * dyPix;
      const { startPanX, startPanY } = drag;
      setView((v) => clampView({
        ...v,
        panX: startPanX + unitsX,
        panY: startPanY + unitsY,
      }));
    } else {
      // Orbit — rotate camera. Horizontal drag → yaw, vertical drag → pitch.
      const { startYaw, startPitch } = drag;
      const sensX = 0.008; // rad per pixel
      const sensY = 0.008;
      setView((v) => clampView({
        ...v,
        yaw: startYaw + dxPix * sensX,
        pitch: startPitch - dyPix * sensY,
      }));
    }
  };

  const onPointerUp = (e) => {
    const svg = svgRef.current;
    if (svg && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    if (pinchRef.current && pinchRef.current.pts) {
      pinchRef.current.pts.delete(e.pointerId);
      if (pinchRef.current.pts.size < 2) pinchRef.current.startDist = null;
      if (pinchRef.current.pts.size === 0) pinchRef.current = null;
    }
  };

  const zoomBy = (factor) => {
    autoSpinRef.current = false;
    setView((v) => clampView({ ...v, distance: v.distance / factor }));
  };
  const resetView = () => {
    autoSpinRef.current = true;
    setView({ yaw: 0, pitch: 0.2, distance: DIST_DEFAULT, panX: 0, panY: 0 });
  };


  // pulse render
  const nowPerf = performance.now();
  const nowMs = Date.now();

  // Historical: pick txs from history in a ±window around the slider position,
  // animate them in a continuous loop so user can study the moment.
  const historicalPulses = useMemo(() => {
    if (isLive) return [];
    if (!txHistory || txHistory.length === 0) return [];
    const start = historicalTime - HISTORICAL_WINDOW_MS / 2;
    const end = historicalTime + HISTORICAL_WINDOW_MS / 2;
    return txHistory.filter((t) => t.timestamp >= start && t.timestamp <= end && t.to);
  }, [isLive, historicalTime, txHistory]);

  const focusFilter = (p) => {
    if (!focusedAddr || !routeMode) return true;
    return p.from === focusedAddr || p.to === focusedAddr;
  };
  const renderPulses = isLive
    ? activePulses.filter(focusFilter).map((p) => {
        const fromNode = byAddr.get(p.from);
        const toNode = byAddr.get(p.to);
        if (!fromNode || !toNode) return null;
        const elapsed = nowPerf - p.startedAt;
        if (elapsed < 0) return null;
        const t = clamp(elapsed / PULSE_DURATION_MS, 0, 1);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        // Interpolate in 3D world space, then project — straight line
        // in space curves correctly under the orbit camera. Apply wobble
        // to both endpoints so the pulse stays attached as the nodes drift.
        const wf = wobbleOffset(fromNode, nowPerf);
        const wt = wobbleOffset(toNode, nowPerf);
        const fx = (fromNode.x || 0) + wf.dx;
        const fy = (fromNode.y || 0) + wf.dy;
        const fz = (fromNode.z || 0) + wf.dz;
        const tx = (toNode.x || 0) + wt.dx;
        const ty = (toNode.y || 0) + wt.dy;
        const tz = (toNode.z || 0) + wt.dz;
        const wx = fx + (tx - fx) * ease;
        const wy = fy + (ty - fy) * ease;
        const wz = fz + (tz - fz) * ease;
        const pt = project3d(wx, wy, wz, view);
        if (!pt) return null;
        const fade = t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15;
        const cx = pt.x, cy = pt.y;
        const ps = pt.scale;
        return (
          <g key={p.id}>
            <circle cx={cx} cy={cy} r={0.9 * ps} fill={pal.pulseLive} opacity={0.25 * fade} />
            <circle cx={cx} cy={cy} r={0.42 * ps} fill={pal.pulseLive} opacity={0.95 * fade} />
          </g>
        );
      })
    : historicalPulses.filter(focusFilter).map((p, i) => {
        const fromNode = byAddr.get(p.from);
        const toNode = byAddr.get(p.to);
        if (!fromNode || !toNode) return null;
        // looped phase based on real clock, offset per-tx so they spread out
        const offset = (i / Math.max(1, historicalPulses.length)) * PULSE_DURATION_MS;
        const t = ((nowPerf + offset) % PULSE_DURATION_MS) / PULSE_DURATION_MS;
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const wf = wobbleOffset(fromNode, nowPerf);
        const wt = wobbleOffset(toNode, nowPerf);
        const fx = (fromNode.x || 0) + wf.dx;
        const fy = (fromNode.y || 0) + wf.dy;
        const fz = (fromNode.z || 0) + wf.dz;
        const tx = (toNode.x || 0) + wt.dx;
        const ty = (toNode.y || 0) + wt.dy;
        const tz = (toNode.z || 0) + wt.dz;
        const wx = fx + (tx - fx) * ease;
        const wy = fy + (ty - fy) * ease;
        const wz = fz + (tz - fz) * ease;
        const pt = project3d(wx, wy, wz, view);
        if (!pt) return null;
        const fade = t < 0.85 ? 1 : 1 - (t - 0.85) / 0.15;
        const cx = pt.x, cy = pt.y;
        const ps = pt.scale;
        return (
          <g key={p.hash + "-" + i}>
            <circle cx={cx} cy={cy} r={0.9 * ps} fill={pal.pulseReplay} opacity={0.25 * fade} />
            <circle cx={cx} cy={cy} r={0.42 * ps} fill={pal.pulseReplay} opacity={0.95 * fade} />
          </g>
        );
      });

  const cursor = dragRef.current ? "grabbing" : "grab";

  return (
    <div ref={wrapRef} className={"graph-wrap " + (fullscreen ? "is-fullscreen" : "")}>
      <form className="search-bar" onSubmit={handleSearch}>
        <span className="search-prefix">FIND ::</span>
        <input
          className="search-input mono"
          type="text"
          placeholder="0x… address (40 hex)"
          value={searchInput}
          onChange={(e) => { setSearchInput(e.target.value); setSearchError(null); }}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="search-btn" title="Find address" disabled={searchLoading}>
          {searchLoading ? "…" : "FIND"}
        </button>
        <button
          type="button"
          className={"search-btn route " + (routeMode ? "on" : "")}
          onClick={() => setRouteMode((v) => !v)}
          disabled={!focusedAddr}
          title="Toggle route highlighting (uses already-loaded data)"
        >
          ROUTE
        </button>
        <button
          type="button"
          className={"search-btn alltime " + (allTimeLoading ? "loading" : "")}
          onClick={handleAllTime}
          disabled={!loadAddressAll || (!focusedAddr && !/^0x[0-9a-f]{40}$/.test(searchInput.trim().toLowerCase()))}
          title="Paginate every on-chain tx for this address (slow but complete)"
        >
          {allTimeLoading ? `STOP · ${allTimeProgress.fetched}` : "ALL TIME"}
        </button>
        {focusedAddr && (
          <button type="button" className="search-btn x" onClick={clearFocus} title="Clear">×</button>
        )}
        {searchLoading && <span className="search-meta">◌ fetching from explorer…</span>}
        {allTimeLoading && (
          <span className="search-meta">◌ all-time · {allTimeProgress.fetched} tx · p{allTimeProgress.page}</span>
        )}
        {!searchLoading && !allTimeLoading && searchError && <span className="search-err">{searchError}</span>}
        {!searchLoading && !allTimeLoading && focusedAddr && !searchError && (
          <span className="search-ok">◉ {shortLabel(focusedAddr)}</span>
        )}
      </form>

      <div className="graph-corner tl">// NEURA.TESTNET · CHAIN 267</div>
      <div className="graph-corner tr">
        {scanStatus.phase === "scanning" ? "◌ SCANNING…" :
         scanStatus.phase === "error" ? "✕ " + (scanStatus.error || "ERROR") :
         scanStatus.lastBlockNumber ? "▸ BLOCK " + scanStatus.lastBlockNumber : "▸ INIT"}
      </div>
      <div className="graph-corner bl">NODES :: {nodes.length}</div>
      <div className="graph-corner br">EDGES :: {edges.length} · PULSES :: {activePulses.length}</div>

      <div className="zoom-cluster">
        <button className="zoom-btn" onClick={() => zoomBy(1.4)} title="Zoom in">+</button>
        <button className="zoom-btn" onClick={() => zoomBy(1 / 1.4)} title="Zoom out">−</button>
        <button className="zoom-btn small" onClick={resetView} title="Reset view">⟲</button>
        <div className="zoom-readout">{view.distance.toFixed(0)}</div>
      </div>

      <button
        className={"expand-btn resize-btn " + (sizingAll ? "loading" : "")}
        onClick={refreshAllSizes}
        disabled={!setLifetimeTx || !nodes || nodes.length === 0}
        title="Fetch all-time tx counters for every visible node and resize wallets + blocks accordingly"
      >
        <span className="btn-bracket">[</span>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 8a6 6 0 0 1 11-3.5 M14 8a6 6 0 0 1-11 3.5 M13 2v3h-3 M3 14v-3h3" />
        </svg>
        {sizingAll
          ? `STOP · ${sizingProgress.done}/${sizingProgress.total}`
          : "RESIZE ALL"}
        <span className="btn-bracket">]</span>
      </button>

      <button
        className="expand-btn"
        onClick={() => setFullscreen(!fullscreen)}
        title={fullscreen ? "Exit fullscreen (Esc)" : "Expand to fullscreen"}
      >
        <span className="btn-bracket">[</span>
        {fullscreen ? (
          <>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6 2v4H2 M10 2v4h4 M6 14v-4H2 M10 14v-4h4" />
            </svg>
            COLLAPSE
          </>
        ) : (
          <>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 6V2h4 M14 6V2h-4 M2 10v4h4 M14 10v4h-4" />
            </svg>
            EXPAND
          </>
        )}
        <span className="btn-bracket">]</span>
      </button>

      <svg
        ref={svgRef}
        viewBox={`${zoomedX} ${zoomedY} ${zoomedW} ${zoomedH}`}
        className="graph-svg"
        preserveAspectRatio="xMidYMid meet"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <radialGradient id="vignette" cx="50%" cy="50%" r="55%">
            <stop offset="60%" stopColor="rgba(0,0,0,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.55)" />
          </radialGradient>
          <radialGradient id="nodeGlow">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
          {/* Sphere shading (works with currentColor on parent) */}
          <radialGradient id="sphereLit" cx="32%" cy="28%" r="78%">
            <stop offset="0%"  stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="38%" stopColor="currentColor" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.45" />
          </radialGradient>
          {/* Faint atmospheric glow behind every node */}
          <radialGradient id="atmosphere">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Depth horizon — soft vignette around the origin */}
        <radialGradient id="depthFog" cx="50%" cy="50%" r="60%">
          <stop offset="0%"  stopColor="rgba(255,255,255,0.04)" />
          <stop offset="60%" stopColor="rgba(0,0,0,0)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.55)" />
        </radialGradient>
        <ellipse cx="50" cy="50" rx={48 * ar} ry={48} fill="url(#depthFog)" />

        {/* 3D wireframe globe — latitudes + longitudes around the cluster,
            rotated with the camera so it reads as a spinning sphere. */}
        {showGrid && (() => {
          const out = [];
          const R = 65;
          const samples = 36;
          // Latitude circles (rings perpendicular to Y axis)
          for (let li = 1; li < 5; li++) {
            const phi = (li / 5) * Math.PI;
            const ry = R * Math.cos(phi);
            const rxy = R * Math.sin(phi);
            const pts = [];
            for (let s = 0; s <= samples; s++) {
              const t = (s / samples) * Math.PI * 2;
              const p = project3d(rxy * Math.cos(t), ry, rxy * Math.sin(t), view);
              if (p) pts.push(`${p.x},${p.y}`);
              else pts.push(null);
            }
            // Break polyline on null projections (behind camera)
            let run = [];
            const flush = () => {
              if (run.length > 1) {
                out.push(
                  <polyline
                    key={"lat-" + li + "-" + out.length}
                    points={run.join(" ")}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="0.07"
                    strokeDasharray="0.5 0.7"
                    opacity={0.32}
                  />
                );
              }
              run = [];
            };
            pts.forEach((p) => { if (p) run.push(p); else flush(); });
            flush();
          }
          // Longitude circles (great circles through the poles)
          for (let lo = 0; lo < 6; lo++) {
            const theta = (lo / 6) * Math.PI;
            const pts = [];
            for (let s = 0; s <= samples; s++) {
              const t = (s / samples) * Math.PI * 2;
              const x = R * Math.sin(t) * Math.cos(theta);
              const y = R * Math.cos(t);
              const z = R * Math.sin(t) * Math.sin(theta);
              const p = project3d(x, y, z, view);
              if (p) pts.push(`${p.x},${p.y}`);
              else pts.push(null);
            }
            let run = [];
            const flush = () => {
              if (run.length > 1) {
                out.push(
                  <polyline
                    key={"lon-" + lo + "-" + out.length}
                    points={run.join(" ")}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="0.07"
                    opacity={0.28}
                  />
                );
              }
              run = [];
            };
            pts.forEach((p) => { if (p) run.push(p); else flush(); });
            flush();
          }
          return out;
        })()}

        {/* Edges — depth sorted so back-of-globe edges render first.
            In route mode, fold every focus-edge into the render set even
            if it ranks below the topEdges cutoff. */}
        {(() => {
          if (!routeInfo.extraEdges || routeInfo.extraEdges.length === 0) return edges;
          const seen = new Set(edges.map((e) => e.from + "|" + e.to));
          const merged = edges.slice();
          for (const e of routeInfo.extraEdges) {
            const k = e.from + "|" + e.to;
            if (!seen.has(k)) {
              merged.push(e);
              seen.add(k);
            }
          }
          return merged;
        })().map((e) => {
          const fa = byAddr.get(e.from);
          const fb = byAddr.get(e.to);
          if (!fa || !fb) return null;
          const pa = project(fa);
          const pb = project(fb);
          if (!pa || !pb) return null;
          const onRoute = routeInfo.edges ? routeInfo.edges.has(e.from + "|" + e.to) : false;
          const dim = routeMode && !onRoute;
          // Depth midpoint — further edges fade more
          const midDepth = (pa.depth + pb.depth) / 2;
          const depthFade = clamp(1 - (midDepth - DIST_MIN) / (DIST_MAX * 1.5), 0.35, 1);
          const baseOp = clamp(0.25 + Math.log2(1 + e.count) * 0.12, 0.25, 0.85);
          return {
            depth: midDepth,
            el: (
              <line
                key={"e-" + e.from + "-" + e.to}
                x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                stroke={onRoute ? pal.focused : "var(--border)"}
                strokeWidth={(onRoute ? 0.22 : 0.1) + Math.min(0.25, Math.log2(1 + e.count) * 0.04)}
                opacity={dim ? 0.08 : (onRoute ? 0.95 : baseOp * depthFade)}
              />
            ),
          };
        }).filter(Boolean).sort((a, b) => b.depth - a.depth).map((e) => e.el)}

        {renderPulses}

        {nodes
          .map((n) => {
            if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) return null;
            if (!Number.isFinite(n.r) || n.r <= 0) return null;
            const p = project(n);
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
            return { node: n, p };
          })
          .filter(Boolean)
          // Back-to-front (painter's algorithm) so close nodes occlude far ones.
          .sort((a, b) => b.p.depth - a.p.depth)
          .map(({ node: n, p }) => {
          const isFocused = focusedAddr === n.addr;
          const isPinned = pinned && pinned.addr === n.addr;
          const isHighlighted = isFocused || isPinned;
          const onRoute = routeInfo.addrs ? routeInfo.addrs.has(n.addr) : false;
          const dim = routeMode && focusedAddr && !onRoute;
          // Perspective scaling so close nodes appear larger than distant ones.
          const baseR = (n.r / 2.2) * p.scale;
          const focusBump = isHighlighted ? 1.5 : 1;
          const pulseScale = (n.status === "veryActive" || isHighlighted)
            ? 1 + 0.12 * Math.sin(tick * 0.10 + n.x)
            : 1;
          const r = baseR * pulseScale * focusBump;
          // Depth dimming — far nodes fade slightly
          const depthAlpha = clamp(1 - (p.depth - DIST_MIN) / (DIST_MAX * 1.6), 0.35, 1);
          const c = isFocused ? pal.focused : isPinned ? pal.pinned : nodeColor(n);
          const isContract = n.kind === "contract";
          const isVery = n.status === "veryActive" || n.isHub || isHighlighted;
          const showLabel =
            showLabels && (
              labelMode === "full" ||
              (labelMode === "short" && (n.isHub || n.status === "veryActive" || isContract)) ||
              (labelMode === "hub-only" && n.isHub)
            );
          return (
            <g
              key={n.addr}
              data-node-addr={n.addr}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(null)}
              onPointerUp={(ev) => {
                ev.stopPropagation();
                setPinned(n);
                // Clicking a node also focuses it + turns on route mode so
                // every edge & neighbour connected to this address lights up.
                setFocusedAddr(n.addr);
                setRouteMode(true);
                setSearchError(null);
                // Re-slot any counterparties that don't currently have one
                // — without this, edges with un-slotted endpoints get
                //  filtered out before they reach the renderer.
                if (expandNeighbors) expandNeighbors(n.addr);
                // Zoom in TOWARD the clicked node — DON'T orbit. Keep the
                // node at the exact screen position the user clicked, just
                // dolly the camera closer. Same anchored-zoom math as the
                // mouse-wheel handler: when distance scales by f, pan must
                // shift so the projected point stays put.
                // The node stays under the cursor, so the user reads it as
                // "I clicked here → it zoomed into here" — never recentred.
                autoSpinRef.current = false;
                markActivity();
                setView((v) => {
                  // Anchor zoom on the visible (wobbled) position so the
                  // dot stays exactly under the cursor through the dolly.
                  const w = wobbleOffset(n, performance.now());
                  const proj = project3d((n.x || 0) + w.dx, (n.y || 0) + w.dy, (n.z || 0) + w.dz, v);
                  const targetDist = clamp(Math.max(30, (n.r || 1) * 8), DIST_MIN, DIST_MAX);
                  if (!proj || targetDist === v.distance) return v;
                  const f = targetDist / v.distance;
                  const anchorX = proj.x - 50;
                  const anchorY = proj.y - 50;
                  return clampView({
                    ...v,
                    distance: targetDist,
                    panX: anchorX - (anchorX - v.panX) / f,
                    panY: anchorY - (anchorY - v.panY) / f,
                  });
                });
              }}
              style={{ cursor: "pointer", opacity: (dim ? 0.18 : 1) * depthAlpha, transition: "opacity .25s ease" }}
            >
              {/* Per-node colored shading uses `color` so SVG gradients with
                  currentColor pick it up. */}
              <g color={c}>
                {/* Soft atmospheric glow — depth cue */}
                {(isVery || isHighlighted) && (
                  <circle cx={p.x} cy={p.y} r={r * 2.2} fill="url(#atmosphere)" />
                )}
                {/* Highlight reticle for pinned/focused */}
                {isHighlighted && (
                  <>
                    <circle
                      cx={p.x} cy={p.y} r={r * 2.4}
                      fill="none" stroke={c}
                      strokeWidth="0.18"
                      strokeDasharray="0.5 0.35"
                      opacity={0.85}
                    />
                    <circle
                      cx={p.x} cy={p.y} r={r * 3.2}
                      fill="none" stroke={c}
                      strokeWidth="0.08" opacity={0.5}
                    />
                  </>
                )}

                {isContract ? (() => {
                  // Isometric cube: front face (square), top face (rhombus
                  // going up+right), right face (rhombus going right+up).
                  // Top is lit, right is shadowed → blockchain "block" feel.
                  const s = r;            // half-side of front face
                  const d = r * 0.55;     // isometric depth
                  const xL = p.x - s, xR = p.x + s;
                  const yT = p.y - s, yB = p.y + s;
                  const xLD = xL + d, xRD = xR + d;
                  const yTD = yT - d, yBD = yB - d;
                  const baseOp = n.status === "inactive" ? 0.7 : 1;
                  return (
                    <g opacity={baseOp}>
                      {/* drop shadow */}
                      <rect
                        x={xL + 0.4} y={yB - 0.1}
                        width={s * 2} height="0.6"
                        fill="#000" opacity="0.35"
                      />
                      {/* front face */}
                      <rect
                        x={xL} y={yT} width={s * 2} height={s * 2}
                        fill={c}
                      />
                      {/* front rim highlight (top edge) */}
                      <line
                        x1={xL} y1={yT} x2={xR} y2={yT}
                        stroke="rgba(255,255,255,0.45)"
                        strokeWidth="0.15"
                      />
                      {/* top face (lighter) — full color, white wash on top
                          so the status color stays readable */}
                      <polygon
                        points={`${xL},${yT} ${xLD},${yTD} ${xRD},${yTD} ${xR},${yT}`}
                        fill={c}
                      />
                      <polygon
                        points={`${xL},${yT} ${xLD},${yTD} ${xRD},${yTD} ${xR},${yT}`}
                        fill="rgba(255,255,255,0.35)"
                      />
                      {/* right face (darker) */}
                      <polygon
                        points={`${xR},${yT} ${xRD},${yTD} ${xRD},${yBD} ${xR},${yB}`}
                        fill={c}
                      />
                      <polygon
                        points={`${xR},${yT} ${xRD},${yTD} ${xRD},${yBD} ${xR},${yB}`}
                        fill="rgba(0,0,0,0.30)"
                      />
                      {/* cube edges */}
                      <polyline
                        points={`${xL},${yT} ${xLD},${yTD} ${xRD},${yTD} ${xR},${yT}`}
                        fill="none" stroke="rgba(255,255,255,0.5)"
                        strokeWidth="0.08"
                      />
                      <line
                        x1={xRD} y1={yTD} x2={xRD} y2={yBD}
                        stroke="rgba(255,255,255,0.25)" strokeWidth="0.08"
                      />
                      <line
                        x1={xR} y1={yB} x2={xRD} y2={yBD}
                        stroke="rgba(255,255,255,0.18)" strokeWidth="0.06"
                      />
                      {/* faint outer wireframe — keeps "contract" identity */}
                      <rect
                        x={xL - 0.5} y={yT - 0.5}
                        width={s * 2 + 1} height={s * 2 + 1}
                        fill="none" stroke={c}
                        strokeWidth="0.08"
                        strokeDasharray="0.45 0.45"
                        opacity={0.5}
                      />
                    </g>
                  );
                })() : (() => {
                  // 3D sphere: layered shadow + radial-gradient body +
                  // specular highlight.
                  const baseOp = n.status === "inactive" ? 0.75 : 1;
                  return (
                    <g opacity={baseOp}>
                      {/* drop shadow */}
                      <ellipse
                        cx={p.x + r * 0.18} cy={p.y + r * 1.05}
                        rx={r * 0.9} ry={r * 0.22}
                        fill="#000" opacity="0.35"
                      />
                      {/* faint outer ring */}
                      <circle
                        cx={p.x} cy={p.y} r={r + 0.5}
                        fill="none" stroke={c}
                        strokeWidth="0.1" opacity="0.55"
                      />
                      {/* solid color base so the wallet's status color is
                          unambiguous, then shade with the gradient on top */}
                      <circle
                        cx={p.x} cy={p.y} r={r}
                        fill={c}
                      />
                      <circle
                        cx={p.x} cy={p.y} r={r}
                        fill="url(#sphereLit)" opacity="0.55"
                      />
                      {/* specular highlight — small soft sheen, not an "eye" */}
                      <ellipse
                        cx={p.x - r * 0.35} cy={p.y - r * 0.45}
                        rx={r * 0.22} ry={r * 0.14}
                        fill="rgba(255,255,255,0.35)"
                      />
                    </g>
                  );
                })()}
              </g>
              {showLabel && r > 0.6 && (
                <text
                  x={p.x} y={p.y + r + 2.2}
                  fontSize={labelMode === "full" ? 1.3 : 1.6}
                  textAnchor="middle"
                  fill="var(--sub)"
                  fontFamily="Courier New, monospace"
                >
                  {isContract ? "▪ " : ""}{n.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Showcase overlay — only visible while a guided scene is active.
            Path scenes draw a bright reveal line + a leading dot tracing the
            edge so the user can read the from→to direction. Zoom scenes
            stamp a pulsing reticle on the target node. */}
        {(() => {
          const scene = showcaseRef.current.scene;
          if (!scene) return null;
          const t = clamp((nowPerf - scene.startTime) / scene.duration, 0, 1);

          if (scene.type === "path") {
            if (t < 0.12 || t > 0.95) return null;
            const wa = wobbleOffset(scene.fromNode, nowPerf);
            const wb = wobbleOffset(scene.toNode, nowPerf);
            const a = project3d((scene.fromNode.x || 0) + wa.dx, (scene.fromNode.y || 0) + wa.dy, (scene.fromNode.z || 0) + wa.dz, view);
            const b = project3d((scene.toNode.x || 0) + wb.dx, (scene.toNode.y || 0) + wb.dy, (scene.toNode.z || 0) + wb.dz, view);
            if (!a || !b) return null;
            const revealRaw = clamp((t - 0.20) / 0.60, 0, 1);
            const eReveal = easeInOut(revealRaw);
            const endX = a.x + (b.x - a.x) * eReveal;
            const endY = a.y + (b.y - a.y) * eReveal;
            let fade = 1;
            if (t < 0.20) fade = (t - 0.12) / 0.08;
            else if (t > 0.85) fade = 1 - (t - 0.85) / 0.10;
            fade = clamp(fade, 0, 1);
            return (
              <g pointerEvents="none">
                <line x1={a.x} y1={a.y} x2={endX} y2={endY}
                  stroke={pal.focused} strokeWidth="0.9" opacity={0.30 * fade} />
                <line x1={a.x} y1={a.y} x2={endX} y2={endY}
                  stroke={pal.focused} strokeWidth="0.32" opacity={0.95 * fade} />
                <circle cx={a.x} cy={a.y} r="1.8" fill="none"
                  stroke={pal.focused} strokeWidth="0.22" opacity={0.85 * fade} />
                <circle cx={endX} cy={endY} r="2.4" fill={pal.focused} opacity={0.30 * fade} />
                <circle cx={endX} cy={endY} r="1.0" fill="#fff" opacity={0.95 * fade} />
                {revealRaw >= 0.99 && (
                  <circle cx={b.x} cy={b.y} r="1.8" fill="none"
                    stroke={pal.focused} strokeWidth="0.22" opacity={0.85 * fade} />
                )}
              </g>
            );
          }

          if (scene.type === "zoom") {
            if (t < 0.28 || t > 0.72) return null;
            const w = wobbleOffset(scene.node, nowPerf);
            const p = project3d((scene.node.x || 0) + w.dx, (scene.node.y || 0) + w.dy, (scene.node.z || 0) + w.dz, view);
            if (!p) return null;
            let fade = 1;
            if (t < 0.35) fade = (t - 0.28) / 0.07;
            else if (t > 0.65) fade = 1 - (t - 0.65) / 0.07;
            fade = clamp(fade, 0, 1);
            const r = 3 + Math.sin(nowPerf * 0.004) * 0.5;
            return (
              <g pointerEvents="none">
                <circle cx={p.x} cy={p.y} r={r} fill="none"
                  stroke={pal.focused} strokeWidth="0.20"
                  strokeDasharray="0.6 0.4" opacity={0.85 * fade} />
                <circle cx={p.x} cy={p.y} r={r * 1.7} fill="none"
                  stroke={pal.focused} strokeWidth="0.10" opacity={0.45 * fade} />
              </g>
            );
          }
          return null;
        })()}

        <rect x={zoomedX} y={zoomedY} width={zoomedW} height={zoomedH} fill="url(#vignette)" pointerEvents="none" />
      </svg>

      {hover && (
        <div className="tooltip">
          <div className="tt-row"><span className="tt-k">ADDR</span><span className="tt-v mono">{shortLabel(hover.addr)}</span></div>
          <div className="tt-row"><span className="tt-k">KIND</span>
            <span className="tt-v">
              {hover.kind === "contract" ? "▪ Contract" : hover.kind === "eoa" ? "● Wallet (EOA)" : "… checking"}
            </span>
          </div>
          <div className="tt-row"><span className="tt-k">TXS</span><span className="tt-v">{hover.txCount.toLocaleString()}</span></div>
          <div className="tt-row"><span className="tt-k">STATUS</span>
            <span className="tt-v">
              <span className="legend-dot" style={{ background: hover.status === "veryActive" ? pal.active2 : hover.status === "active30" ? pal.active10 : pal.idle }} />
              {hover.status === "veryActive" ? "Active <2 min"
                : hover.status === "active30" ? "Active <10 min"
                : "Idle"}
            </span>
          </div>
          <div className="tt-row tt-hint"><span className="tt-k"></span><span className="tt-v dim">click → details + history</span></div>
        </div>
      )}

      {nodes.length === 0 && scanStatus.phase === "error" && (
        <div className="graph-empty">
          <div className="empty-head">⚠ RPC ERROR</div>
          <div className="empty-sub">{scanStatus.error}</div>
        </div>
      )}
      {nodes.length === 0 && scanStatus.phase !== "error" && !scanStatus.lastScanAt && (
        <div className="graph-empty subtle">
          <div className="empty-head">◌ FIRST SCAN…</div>
          <div className="empty-sub">Will use cache on next load.</div>
        </div>
      )}

      <TimeSlider
        txHistory={txHistory}
        historicalTime={historicalTime}
        setHistoricalTime={setHistoricalTime}
        isLive={isLive}
        nowMs={nowMs}
        focusedAddr={focusedAddr}
        routeMode={routeMode}
        scanStatus={scanStatus}
      />

      {pinned && (
        <PinnedPanel
          node={pinned}
          onClose={() => {
            setPinned(null);
            setFocusedAddr(null);
            setRouteMode(false);
          }}
          nowMs={nowMs}
          loadAddressAll={loadAddressAll}
          setLifetimeTx={setLifetimeTx}
          routeMode={routeMode}
          setRouteMode={setRouteMode}
          runAllTime={runAllTime}
          allTimeLoading={allTimeLoading}
          allTimeProgress={allTimeProgress}
          palette={pal}
        />
      )}
    </div>
  );
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function TimeSlider({ txHistory, historicalTime, setHistoricalTime, isLive, nowMs, focusedAddr, routeMode, scanStatus }) {
  const latest = nowMs;
  // Earliest tx we have on record — slider scrubs from here to now.
  const earliestKnown = txHistory && txHistory.length > 0
    ? txHistory[0].timestamp
    : latest - 60_000;

  const value = historicalTime ?? latest;
  const focusOn = !!focusedAddr && routeMode;

  // Live = scrub from earliest-known tx → now.
  const timeMin = earliestKnown;
  const timeMax = latest;
  const safeValue = clamp(value, timeMin, timeMax);

  const windowTxs = txHistory.filter((t) => {
    if (focusOn && t.from !== focusedAddr && t.to !== focusedAddr) return false;
    return Math.abs(t.timestamp - safeValue) <= HISTORICAL_WINDOW_MS / 2;
  }).length;

  const onTimeChange = (e) => {
    const v = Number(e.target.value);
    if (Math.abs(v - latest) < 1500) setHistoricalTime(null);
    else setHistoricalTime(v);
  };

  const scanPct = scanStatus && scanStatus.lastScanAt
    ? clamp(1 - scanStatus.countdownMs / SCAN_INTERVAL_MS, 0, 1) : 0;

  return (
    <div className="time-slider">
      <div className="ts-row">
        <span className="ts-mode">
          {isLive ? <><span className="ts-live-dot" /> LIVE</> : <>▶ REPLAY</>}
        </span>
        <span className="ts-time mono">{fmtTime(safeValue)}</span>
        <input
          className="ts-range"
          type="range"
          min={timeMin}
          max={timeMax}
          value={safeValue}
          step={1000}
          onChange={onTimeChange}
        />
        <span className="ts-meta">
          {windowTxs} tx
          {focusOn && <span className="ts-focus"> · {shortLabel(focusedAddr)}</span>}
        </span>
        <button
          className={"live-pill " + (isLive ? "on" : "")}
          onClick={() => setHistoricalTime(null)}
          title="Snap to live"
        >
          ◉ LIVE
        </button>
      </div>
      {isLive && (
        <div className="ts-scan-line" title={`Next scan in ${Math.ceil((scanStatus?.countdownMs ?? 0) / 1000)}s`}>
          <div className="ts-scan-fill" style={{ width: (scanPct * 100).toFixed(1) + "%" }} />
        </div>
      )}
    </div>
  );
}

function PinnedPanel({
  node, onClose, nowMs, loadAddressAll, setLifetimeTx,
  routeMode, setRouteMode,
  runAllTime, allTimeLoading, allTimeProgress,
  palette,
}) {
  const pal = palette || FALLBACK_PALETTE;
  const [meta, setMeta] = useState({
    loading: true,
    error: null,
    isContract: null,
    createdAt: null,
    creator: null,
    creationTx: null,
    totalTx: null,
    todayTx: null,
    tokenTransfers: null,
  });
  // Refetch whenever the pinned node changes.
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setMeta({
      loading: true, error: null,
      isContract: null, createdAt: null, creator: null, creationTx: null,
      totalTx: null, todayTx: null, tokenTransfers: null,
    });

    (async () => {
      try {
        const [info, counters] = await Promise.all([
          fetchAddressInfo(node.addr, ctrl.signal).catch(() => null),
          fetchAddressCounters(node.addr, ctrl.signal).catch(() => null),
        ]);
        if (cancelled) return;

        const isContract = info && typeof info.is_contract === "boolean"
          ? info.is_contract
          : (node.kind === "contract");

        let createdAt = null;
        const creationTx = info && info.creation_tx_hash ? info.creation_tx_hash : null;
        if (creationTx) {
          createdAt = await fetchTxTimestamp(creationTx, ctrl.signal).catch(() => null);
        }
        if (cancelled) return;

        let todayTx = null;
        try {
          todayTx = await fetchAddressTodayCount(node.addr, ctrl.signal);
        } catch { todayTx = null; }
        if (cancelled) return;

        const totalTx = counters && counters.transactions_count != null
          ? Number(counters.transactions_count) : null;
        const tokenTransfers = counters && counters.token_transfers_count != null
          ? Number(counters.token_transfers_count) : null;

        // Push the lifetime count back into the scanner state so this node's
        // layout size + slot rank reflects on-chain importance, not just
        // scanner-observed activity.
        if (setLifetimeTx && (totalTx != null || tokenTransfers != null)) {
          setLifetimeTx(node.addr, (totalTx || 0) + (tokenTransfers || 0));
        }

        setMeta({
          loading: false,
          error: null,
          isContract,
          createdAt,
          creator: info && info.creator_address_hash ? info.creator_address_hash : null,
          creationTx,
          totalTx,
          tokenTransfers,
          todayTx,
        });
      } catch (err) {
        if (cancelled) return;
        setMeta((m) => ({ ...m, loading: false, error: err && err.message ? err.message : "fetch error" }));
      }
    })();

    return () => { cancelled = true; ctrl.abort(); };
  }, [node.addr]);

  const kindLabel = meta.isContract === true
    ? "▪ CONTRACT"
    : meta.isContract === false
      ? "● WALLET"
      : (node.kind === "contract" ? "▪ CONTRACT" : "● WALLET");

  const totalDisplay = meta.totalTx != null
    ? meta.totalTx.toLocaleString()
    : node.txCount.toLocaleString();
  const totalIsApi = meta.totalTx != null;

  return (
    <div className="pinned-panel">
      <div className="pp-head">
        <span className="pp-title">{kindLabel}</span>
        <button className="pp-close" onClick={onClose} title="Close">×</button>
      </div>
      <div className="pp-body">
        <div className="pp-row"><span className="pp-k">ADDR</span><span className="pp-v mono">{node.addr}</span></div>

        <div className="pp-row"><span className="pp-k">CREATED</span>
          <span className="pp-v">
            {meta.loading ? (
              <span className="dim">◌ fetching…</span>
            ) : meta.createdAt ? (
              <>
                <span className="mono">{fmtTs(meta.createdAt)}</span>
                <span className="dim"> · {fmtRel(meta.createdAt, nowMs)}</span>
              </>
            ) : (
              <span className="dim">
                <span className="mono">{fmtTs(node.firstSeen)}</span>
                <span> (scanner first.seen — no API record)</span>
              </span>
            )}
          </span>
        </div>

        {meta.creator && (
          <div className="pp-row"><span className="pp-k">CREATOR</span>
            <span className="pp-v mono">{shortLabel(meta.creator)}</span>
          </div>
        )}

        <div className="pp-row"><span className="pp-k">TX OUT</span>
          <span className="pp-v">
            <span>{totalDisplay}</span>
            <span className="dim"> · {totalIsApi ? "lifetime sent (API nonce)" : "scanner only"}</span>
          </span>
        </div>

        <div className="pp-row"><span className="pp-k">TX TODAY</span>
          <span className="pp-v">
            {meta.loading ? (
              <span className="dim">◌ counting…</span>
            ) : meta.todayTx != null ? (
              <>
                <span>{meta.todayTx.toLocaleString()}</span>
                <span className="dim"> · in + out, last 24h</span>
              </>
            ) : (
              <span className="dim">—</span>
            )}
          </span>
        </div>

        {meta.tokenTransfers != null && meta.tokenTransfers > 0 && (
          <div className="pp-row"><span className="pp-k">TX TOKEN</span>
            <span className="pp-v">
              <span>{meta.tokenTransfers.toLocaleString()}</span>
              <span className="dim"> · token transfers</span>
            </span>
          </div>
        )}

        <div className="pp-row"><span className="pp-k">TX SCAN</span>
          <span className="pp-v">
            <span>{node.txCount.toLocaleString()}</span>
            <span className="dim"> · seen by this explorer</span>
          </span>
        </div>

        <div className="pp-row dim pp-note">
          Node size = <b>log10</b>(lifetime on-chain sent + token txs). The
          background scanner fetches these counters page-by-page, so heavy
          contracts can take a couple of scan cycles to claim their slot.
        </div>

        <div className="pp-row"><span className="pp-k">LAST.SEEN</span>
          <span className="pp-v">
            <span className="mono">{fmtTs(node.lastSeen)}</span>
            <span className="dim"> · {fmtRel(node.lastSeen, nowMs)}</span>
          </span>
        </div>

        <div className="pp-row"><span className="pp-k">STATUS</span>
          <span className="pp-v">
            <span className="legend-dot" style={{ background: node.status === "veryActive" ? pal.active2 : node.status === "active30" ? pal.active10 : pal.idle }} />
            {node.status === "veryActive" ? "Active <2 min"
              : node.status === "active30" ? "Active <10 min"
              : "Idle"}
          </span>
        </div>

        {meta.error && (
          <div className="pp-row dim pp-note">API error: {meta.error}</div>
        )}

        <div className="pp-route-row">
          <button
            className={"btn pp-route-btn " + (routeMode ? "primary on" : "ghost")}
            onClick={() => setRouteMode && setRouteMode(!routeMode)}
            title="Highlight every edge currently in the graph that touches this address"
          >
            <span className="btn-bracket">[</span>
            ROUTE{routeMode ? " · ON" : ""}
            <span className="btn-bracket">]</span>
          </button>
          <button
            className={"btn pp-route-btn alltime " + (allTimeLoading ? "loading" : (allTimeProgress && allTimeProgress.merged > 0) ? "done" : "")}
            onClick={() => runAllTime && runAllTime(node.addr)}
            disabled={!runAllTime}
            title="Paginate every on-chain transaction for this address — slow, but route then shows the full history"
          >
            <span className="btn-bracket">[</span>
            {allTimeLoading
              ? `STOP · ${allTimeProgress.fetched}`
              : (allTimeProgress && allTimeProgress.merged > 0)
                ? `ALL TIME · +${allTimeProgress.merged}`
                : "ALL TIME ROUTE"}
            <span className="btn-bracket">]</span>
          </button>
        </div>
        {allTimeLoading && (
          <div className="pp-row dim pp-note">paginating page {allTimeProgress.page} · {allTimeProgress.fetched} tx loaded so far</div>
        )}

        <a
          className="btn ghost pp-cta"
          href={`${EXPLORER_URL}/address/${node.addr}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="btn-bracket">[</span>OPEN IN EXPLORER<span className="btn-bracket">]</span>
        </a>
      </div>
    </div>
  );
}

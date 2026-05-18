import { useEffect, useRef, useState, useCallback } from "react";
import { createPublicClient, http, defineChain } from "viem";

export const SCAN_INTERVAL_MS = 15_000;
export const RPC_URL = "https://testnet.rpc.neuraprotocol.io/";
export const EXPLORER_URL = "https://testnet-blockscout.infra.neuraprotocol.io";
export const EXPLORER_API = "https://testnet-blockscout.infra.neuraprotocol.io/api/v2";

export const neuraTestnet = defineChain({
  id: 267,
  name: "Neura Testnet",
  nativeCurrency: { name: "ANKR", symbol: "ANKR", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: EXPLORER_URL },
  },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: neuraTestnet,
  transport: http(RPC_URL, { batch: true, retryCount: 2, timeout: 15_000 }),
});

// Fetch wrapper with a hard timeout so hung Blockscout requests can't park
// the UI in "scanning" forever. Respects a user-supplied AbortSignal too.
function fetchWithTimeout(url, opts = {}, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const userSignal = opts.signal;
  const onUserAbort = () => ctrl.abort();
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort();
    else userSignal.addEventListener("abort", onUserAbort);
  }
  const fetchOpts = { ...opts, signal: ctrl.signal };
  return fetch(url, fetchOpts).finally(() => {
    clearTimeout(timer);
    if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
  });
}

// Parse a Blockscout-style ISO timestamp safely. Returns null when the
// input is missing or malformed — callers fall back to a sensible default
// (Date.now() for live, 0 for "today" comparisons).
function safeParseTs(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

const STORAGE_KEY = "neura-explorer-state-v2";
const MAX_BLOCKS_PER_SCAN = 30;
const MAX_PULSES_QUEUED = 240;
const STATUS_VERY_ACTIVE_MS = 2 * 60_000;
const STATUS_ACTIVE_MS = 10 * 60_000;
const CODE_BATCH_SIZE = 12;
const LIFETIME_BATCH_SIZE = 8;

// 14 sphere shells → ~495 nodes total. Radii spread further out so nodes
// don't crowd each other in the 3D view. Outer shells use smaller node
// radii so they read as "distant" addresses.
// NOTE: outermost shell radius (130) must stay below DIST_MIN in
// NodeGraph.jsx so the camera never ends up inside the cluster at max zoom.
const RING_DEFS = [
  null, // hub at origin
  { count: 7,   radius: 22,  baseR: 8.5,  offset: 0.13 },
  { count: 11,  radius: 36,  baseR: 6.0,  offset: 0.27 },
  { count: 15,  radius: 50,  baseR: 4.4,  offset: 0.41 },
  { count: 19,  radius: 62,  baseR: 3.3,  offset: 0.55 },
  { count: 23,  radius: 73,  baseR: 2.5,  offset: 0.69 },
  { count: 27,  radius: 82,  baseR: 1.9,  offset: 0.83 },
  { count: 31,  radius: 90,  baseR: 1.5,  offset: 0.97 },
  { count: 37,  radius: 98,  baseR: 1.25, offset: 1.11 },
  { count: 45,  radius: 105, baseR: 1.05, offset: 1.25 },
  { count: 53,  radius: 112, baseR: 0.9,  offset: 1.39 },
  { count: 63,  radius: 118, baseR: 0.8,  offset: 1.53 },
  { count: 75,  radius: 124, baseR: 0.7,  offset: 1.67 },
  { count: 88,  radius: 130, baseR: 0.6,  offset: 1.81 },
];
const RING_CAPS = RING_DEFS.map((d) => (d ? d.count : 1));
const MAX_NODES = RING_CAPS.reduce((a, b) => a + b, 0);

// Soft render cap — how many nodes are actually slotted/drawn by default.
// We keep the full 495-slot ring geometry available so a focused address
// can pull in lots of counterparties, but in normal browsing we only fill
// SOFT_RENDER_CAP slots so the SVG doesn't lag with hundreds of circles
// + edges. The cap auto-grows past this when protectedAddrs (focused +
// neighbours, ALL TIME route) demand more slots.
const SOFT_RENDER_CAP = 150;
const SOFT_RENDER_BUFFER = 30; // headroom over protectedSet when route grows

function loadState() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem("neura-explorer-state-v1");
      if (legacy) raw = legacy;
    }
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    // tolerate missing fields so schema additions don't wipe cached data
    return {
      lastBlock: typeof parsed.lastBlock === "number" ? parsed.lastBlock : null,
      addresses: parsed.addresses && typeof parsed.addresses === "object" ? parsed.addresses : {},
      edgeCounts: parsed.edgeCounts && typeof parsed.edgeCounts === "object" ? parsed.edgeCounts : {},
      slotMap: parsed.slotMap && typeof parsed.slotMap === "object" ? parsed.slotMap : {},
      addrType: parsed.addrType && typeof parsed.addrType === "object" ? parsed.addrType : {},
      lifetimeTx: parsed.lifetimeTx && typeof parsed.lifetimeTx === "object" ? parsed.lifetimeTx : {},
      // Protected addresses are session-state — clear on reload so a closed
      // browser doesn't end up with phantom locks.
      protectedAddrs: [],
      txHistory: Array.isArray(parsed.txHistory) ? parsed.txHistory : [],
      totals: parsed.totals && typeof parsed.totals === "object" ? parsed.totals : { blocks: 0, txs: 0 },
    };
  } catch {
    return null;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota exceeded — ignore
  }
}

function emptyState() {
  return {
    lastBlock: null,
    addresses: {}, // addr -> { txCount, firstSeen, lastSeen }
    edgeCounts: {}, // "from|to" -> count
    slotMap: {},   // addr -> { ring, slotIndex }  — stable layout positions
    addrType: {},  // addr -> "eoa" | "contract"
    lifetimeTx: {}, // addr -> on-chain "sent + token + internal" approx (Blockscout counters)
    protectedAddrs: [], // addresses that must keep their slots regardless of new scan activity
    txHistory: [], // [{from, to, hash, blockNumber, timestamp}] ring buffer (timestamp = ms)
    totals: { blocks: 0, txs: 0 },
  };
}

const TX_HISTORY_LIMIT = 3000;

function shortLabel(addr) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function classifyStatus(lastSeen, now) {
  const age = now - lastSeen;
  if (age < STATUS_VERY_ACTIVE_MS) return "veryActive";
  if (age < STATUS_ACTIVE_MS) return "active30";
  return "inactive";
}

// Promote every counterparty of `focusAddr` (from edgeCounts) into a slot.
// Edges are dropped at the topEdges filter when either endpoint lacks a
// slot, so without this step the "route" view for a freshly-loaded address
// can look entirely empty even though the txs were merged.
// Mutates `state` in place.
function forceSlotsForCounterparties(state, focusAddr, maxAdd = 25) {
  if (!state.addresses[focusAddr]) return;
  const counterparties = new Map(); // addr -> count
  for (const key of Object.keys(state.edgeCounts)) {
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const from = key.slice(0, sep);
    const to = key.slice(sep + 1);
    if (from === focusAddr && to !== focusAddr) {
      counterparties.set(to, (counterparties.get(to) || 0) + state.edgeCounts[key]);
    } else if (to === focusAddr && from !== focusAddr) {
      counterparties.set(from, (counterparties.get(from) || 0) + state.edgeCounts[key]);
    }
  }
  if (counterparties.size === 0) return;

  // Rank counterparties by edge-volume so the strongest neighbours win slots.
  const ranked = [...counterparties.entries()]
    .filter(([a]) => state.addresses[a])
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxAdd);

  const protectedSet = new Set(ranked.map(([a]) => a));
  protectedSet.add(focusAddr);

  for (const [cpAddr] of ranked) {
    if (state.slotMap[cpAddr]) continue; // already has a slot
    // Find an outer-ring address with the smallest weight that isn't a
    // counterparty itself, evict it.
    let victim = null;
    let victimW = Infinity;
    for (const a of Object.keys(state.slotMap)) {
      if (protectedSet.has(a)) continue;
      const slot = state.slotMap[a];
      if (!slot || slot.ring === 0) continue;
      const w = sizeWeight(a, state.addresses[a] || {}, state.lifetimeTx);
      if (w < victimW) { victimW = w; victim = a; }
    }
    if (!victim) break; // no evictable slot — graph is fully occupied by neighbours
    const slot = state.slotMap[victim];
    delete state.slotMap[victim];
    state.slotMap[cpAddr] = slot;
  }
}

// Compute stable slot assignments. Existing slots survive across scans;
// dropped-out addresses free their slots, new addresses fill the gaps.
// Ranking uses lifetime on-chain counts when available so that a contract
// with 28M txs takes the hub over a wallet that's only locally chatty.
//
// `protectedAddrs` (optional) is a list of addresses whose slots must be
// preserved no matter what — used when the user has focused a node and is
// inspecting its route, so the scanner's normal "rotate in newer
// addresses" behaviour doesn't yank counterparties off the layout.
function computeStableSlots(addresses, prevSlotMap, lifetimeTx, protectedAddrs) {
  const protectedSet = new Set();
  if (protectedAddrs) {
    for (const a of protectedAddrs) {
      if (typeof a === "string" && addresses[a]) protectedSet.add(a);
    }
  }

  const ranked = Object.entries(addresses)
    .map(([addr, info]) => ({ addr, ...info, _w: sizeWeight(addr, info, lifetimeTx) }))
    .sort((a, b) => b._w - a._w);

  // Eligible = every protected addr (forced in) + the top-weight remainder.
  // Dynamic cap: SOFT_RENDER_CAP normally, but grows when a focused route
  // has many counterparties so they all get slotted instead of being
  // dropped at the edge filter. Hard-capped at MAX_NODES (ring capacity).
  const dynamicCap = Math.min(
    MAX_NODES,
    Math.max(SOFT_RENDER_CAP, protectedSet.size + SOFT_RENDER_BUFFER)
  );
  const eligibleArr = [];
  const eligibleSet = new Set();
  for (const a of ranked) {
    if (!protectedSet.has(a.addr)) continue;
    eligibleArr.push(a);
    eligibleSet.add(a.addr);
  }
  for (const a of ranked) {
    if (eligibleSet.has(a.addr)) continue;
    if (eligibleArr.length >= dynamicCap) break;
    eligibleArr.push(a);
    eligibleSet.add(a.addr);
  }
  // Re-sort by weight so the heaviest still takes the hub.
  eligibleArr.sort((a, b) => b._w - a._w);

  if (eligibleArr.length === 0) return {};

  const sorted = eligibleArr;
  const eligible = eligibleSet;
  const hubAddr = sorted[0].addr;
  const ringFilled = RING_CAPS.map(() => new Set());
  const newSlotMap = {};

  // 1. Hub always gets ring 0 / slot 0 (most active overall)
  newSlotMap[hubAddr] = { ring: 0, slotIndex: 0 };
  ringFilled[0].add(0);

  // 2. Preserve existing slot assignments where still eligible
  for (const addr of Object.keys(prevSlotMap)) {
    if (addr === hubAddr) continue;
    if (!eligible.has(addr)) continue;
    const slot = prevSlotMap[addr];
    if (!slot || slot.ring === 0) continue;
    if (slot.ring >= RING_CAPS.length) continue;
    if (ringFilled[slot.ring].has(slot.slotIndex)) continue;
    newSlotMap[addr] = slot;
    ringFilled[slot.ring].add(slot.slotIndex);
  }

  // 3. Place remaining eligible addresses into first available outer slots,
  //    preferring inner rings for higher-ranked addresses.
  for (const a of sorted) {
    if (newSlotMap[a.addr]) continue;
    for (let r = 1; r < RING_CAPS.length; r++) {
      if (ringFilled[r].size >= RING_CAPS[r]) continue;
      let assigned = false;
      for (let i = 0; i < RING_CAPS[r]; i++) {
        if (!ringFilled[r].has(i)) {
          newSlotMap[a.addr] = { ring: r, slotIndex: i };
          ringFilled[r].add(i);
          assigned = true;
          break;
        }
      }
      if (assigned) break;
    }
  }
  return newSlotMap;
}

// Effective size weight for an address. Prefers on-chain lifetime tx count
// (fetched lazily from Blockscout counters) but falls back to scanner-only
// count when API data isn't loaded yet. Log-scaled so a 28M-tx contract and
// a 368-tx wallet stay comparable on the same canvas.
function sizeWeight(addr, info, lifetimeTx) {
  const lifetime = lifetimeTx && lifetimeTx[addr];
  const raw = (typeof lifetime === "number" && lifetime > 0) ? lifetime : (info.txCount || 0);
  return Math.log10(1 + raw);
}

// Fibonacci sphere distribution — uniform points on a unit sphere.
// Stable per (slotIndex, count), so a node keeps the same direction across
// scans even as the ring's population changes.
function fibSphere(i, n) {
  // +0.5 keeps points off the poles for ring sizes <= 1
  const phi = Math.acos(1 - 2 * (i + 0.5) / Math.max(1, n));
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  return {
    x: Math.cos(theta) * Math.sin(phi),
    y: Math.sin(theta) * Math.sin(phi),
    z: Math.cos(phi),
  };
}

function buildLayout(addresses, slotMap, addrType, lifetimeTx) {
  const nodes = [];
  let maxW = 0;
  for (const addr of Object.keys(slotMap)) {
    const info = addresses[addr];
    if (!info) continue;
    const w = sizeWeight(addr, info, lifetimeTx);
    if (w > maxW) maxW = w;
  }
  if (maxW <= 0) maxW = 1;

  for (const addr of Object.keys(slotMap)) {
    const info = addresses[addr];
    if (!info) continue;
    const slot = slotMap[addr];
    const isHub = slot.ring === 0;
    const w = sizeWeight(addr, info, lifetimeTx);
    const norm = Math.min(1, w / maxW);

    // World-space coordinates are centered at the origin. The viewer
    // (NodeGraph) orbits this point and projects 3D → 2D.
    let x, y, z, r;
    if (isHub) {
      x = 0; y = 0; z = 0;
      r = 11 + 6 * norm;
    } else {
      const def = RING_DEFS[slot.ring];
      if (!def) continue;
      // Each ring becomes a sphere shell of that radius. Within the shell,
      // Fibonacci distribution gives an even, "constellation-like" spread.
      const dir = fibSphere(slot.slotIndex, def.count);
      const shellRadius = def.radius;
      x = dir.x * shellRadius;
      y = dir.y * shellRadius;
      z = dir.z * shellRadius;
      r = def.baseR * (0.45 + 0.55 * norm);
    }

    const kind = addrType[addr] || "unknown";
    nodes.push({
      addr,
      label: shortLabel(addr),
      x, y, z, r,
      txCount: info.txCount,
      lifetimeTx: lifetimeTx && lifetimeTx[addr] != null ? lifetimeTx[addr] : null,
      firstSeen: info.firstSeen,
      lastSeen: info.lastSeen,
      ring: slot.ring,
      isHub,
      kind,
    });
  }

  const byAddr = new Map(nodes.map((n) => [n.addr, n]));
  return { nodes, byAddr };
}

function topEdges(edgeCounts, byAddr, limit = 60) {
  const entries = [];
  for (const key of Object.keys(edgeCounts)) {
    const [from, to] = key.split("|");
    if (!byAddr.has(from) || !byAddr.has(to)) continue;
    entries.push({ from, to, count: edgeCounts[key] });
  }
  entries.sort((a, b) => b.count - a.count);
  return entries.slice(0, limit);
}

export function useChainScanner() {
  const [state, setState] = useState(() => loadState() || emptyState());
  const [scanStatus, setScanStatus] = useState({
    phase: "idle",      // idle | scanning | ok | error
    error: null,
    lastBlockNumber: null,
    lastScanAt: null,
    countdownMs: SCAN_INTERVAL_MS,
    blocksThisScan: 0,
    txsThisScan: 0,
  });
  const [pulseQueue, setPulseQueue] = useState([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const scanningRef = useRef(false);
  const tickRef = useRef(null);
  // Abort handle for the most-recent loadAddress fetch — replaced on every
  // new search and aborted on unmount so we never setState into a dead tree.
  const loadAddressCtrlRef = useRef(null);

  const runScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanStatus((s) => ({ ...s, phase: "scanning", error: null }));

    try {
      const head = await publicClient.getBlockNumber();
      const headNum = Number(head);
      const prev = stateRef.current.lastBlock;
      let fromBlock;
      if (prev === null || prev === undefined) {
        // Cold start: walk back a full scan window so the first render has
        // enough addresses to populate the rings instead of 5 lonely blocks.
        fromBlock = Math.max(0, headNum - (MAX_BLOCKS_PER_SCAN - 1));
      } else {
        fromBlock = prev + 1;
      }
      const toBlock = Math.min(headNum, fromBlock + MAX_BLOCKS_PER_SCAN - 1);

      if (fromBlock > headNum) {
        setScanStatus((s) => ({
          ...s,
          phase: "ok",
          lastBlockNumber: headNum,
          lastScanAt: Date.now(),
          blocksThisScan: 0,
          txsThisScan: 0,
        }));
        scanningRef.current = false;
        return;
      }

      const now = Date.now();
      const next = {
        lastBlock: toBlock,
        addresses: { ...stateRef.current.addresses },
        edgeCounts: { ...stateRef.current.edgeCounts },
        slotMap: { ...stateRef.current.slotMap },
        addrType: { ...stateRef.current.addrType },
        txHistory: stateRef.current.txHistory.slice(),
        totals: { ...stateRef.current.totals },
      };

      const newPulses = [];
      let txsThisScan = 0;
      let blocksThisScan = 0;

      const blockNumbers = [];
      for (let b = fromBlock; b <= toBlock; b++) blockNumbers.push(b);

      const blocks = await Promise.all(
        blockNumbers.map((bn) =>
          publicClient.getBlock({ blockNumber: BigInt(bn), includeTransactions: true })
        )
      );

      for (const block of blocks) {
        blocksThisScan++;
        const blockTs = block.timestamp ? Number(block.timestamp) * 1000 : now;
        for (const tx of block.transactions) {
          if (!tx || !tx.from) continue;
          const from = tx.from.toLowerCase();
          const to = tx.to ? tx.to.toLowerCase() : null;

          if (!next.addresses[from]) {
            next.addresses[from] = { txCount: 0, firstSeen: blockTs, lastSeen: blockTs };
          }
          next.addresses[from].txCount++;
          next.addresses[from].lastSeen = Math.max(next.addresses[from].lastSeen, blockTs);
          if (next.addresses[from].firstSeen > blockTs) next.addresses[from].firstSeen = blockTs;

          if (to) {
            if (!next.addresses[to]) {
              next.addresses[to] = { txCount: 0, firstSeen: blockTs, lastSeen: blockTs };
            }
            next.addresses[to].txCount++;
            next.addresses[to].lastSeen = Math.max(next.addresses[to].lastSeen, blockTs);
            if (next.addresses[to].firstSeen > blockTs) next.addresses[to].firstSeen = blockTs;

            const key = from + "|" + to;
            next.edgeCounts[key] = (next.edgeCounts[key] || 0) + 1;
          }

          const pulseId = tx.hash + "-" + Math.random().toString(36).slice(2, 6);
          newPulses.push({
            id: pulseId,
            from, to, hash: tx.hash,
            value: tx.value ? tx.value.toString() : "0",
            blockNumber: Number(block.number),
            timestamp: blockTs,
          });
          next.txHistory.push({
            from, to, hash: tx.hash,
            blockNumber: Number(block.number),
            timestamp: blockTs,
          });
          txsThisScan++;
        }
      }

      // bound txHistory ring buffer
      if (next.txHistory.length > TX_HISTORY_LIMIT) {
        next.txHistory = next.txHistory.slice(-TX_HISTORY_LIMIT);
      }

      next.totals.blocks += blocksThisScan;
      next.totals.txs += txsThisScan;

      // prune addresses if too many (keep top by txCount, never evict slotted ones).
      // Thresholds scaled up so 500-slot layout has enough eligible pool —
      // pruning to 200 would starve the outer rings between scans.
      const addrEntries = Object.entries(next.addresses);
      if (addrEntries.length > 1400) {
        const slotted = new Set(Object.keys(next.slotMap));
        addrEntries.sort((a, b) => b[1].txCount - a[1].txCount);
        const kept = addrEntries.slice(0, 800);
        const keptSet = new Set(kept.map(([a]) => a));
        // ensure slotted addrs always retained
        for (const a of slotted) {
          if (!keptSet.has(a) && next.addresses[a]) {
            kept.push([a, next.addresses[a]]);
            keptSet.add(a);
          }
        }
        next.addresses = Object.fromEntries(kept);
        const prunedEdges = {};
        for (const k of Object.keys(next.edgeCounts)) {
          const [a, b] = k.split("|");
          if (keptSet.has(a) && keptSet.has(b)) prunedEdges[k] = next.edgeCounts[k];
        }
        next.edgeCounts = prunedEdges;
        const prunedType = {};
        for (const a of Object.keys(next.addrType)) {
          if (keptSet.has(a)) prunedType[a] = next.addrType[a];
        }
        next.addrType = prunedType;
      }

      // Carry forward lifetime counts (or initialise if missing on cold-start).
      if (!next.lifetimeTx) next.lifetimeTx = { ...stateRef.current.lifetimeTx };
      else next.lifetimeTx = { ...next.lifetimeTx };
      // Carry forward the user's active protection set (e.g. a focused
      // address + its counterparties) so the scanner can't shuffle those
      // slots away under their feet.
      if (!next.protectedAddrs) next.protectedAddrs = stateRef.current.protectedAddrs || [];

      // Recompute stable slot assignments using the previous slotMap as anchor.
      next.slotMap = computeStableSlots(next.addresses, next.slotMap, next.lifetimeTx, next.protectedAddrs);

      // Detect contract vs EOA for any newly-slotted address we haven't checked.
      const slottedAddrs = Object.keys(next.slotMap);
      const needCode = slottedAddrs.filter((a) => !next.addrType[a]);
      if (needCode.length) {
        try {
          const batch = needCode.slice(0, CODE_BATCH_SIZE);
          const codes = await Promise.all(
            batch.map((a) =>
              publicClient.getBytecode({ address: /** @type any */ (a) }).catch(() => null)
            )
          );
          codes.forEach((code, i) => {
            const a = batch[i];
            const isContract = !!code && code !== "0x" && code.length > 2;
            next.addrType[a] = isContract ? "contract" : "eoa";
          });
        } catch {
          // ignore detection failure — types will be filled on next scan
        }
      }

      // Background-fetch Blockscout counters for slotted addresses without
      // a known lifetime tx count. Throttled to a small batch per scan so
      // we don't hammer the API; results override scanner-only sizing.
      const needLifetime = slottedAddrs
        .filter((a) => next.lifetimeTx[a] == null)
        .slice(0, LIFETIME_BATCH_SIZE);
      if (needLifetime.length) {
        try {
          const results = await Promise.all(
            needLifetime.map((a) =>
              fetchWithTimeout(`${EXPLORER_API}/addresses/${a}/counters`)
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null)
            )
          );
          results.forEach((data, i) => {
            const a = needLifetime[i];
            const sent = data && data.transactions_count != null
              ? Number(data.transactions_count) : 0;
            const tokens = data && data.token_transfers_count != null
              ? Number(data.token_transfers_count) : 0;
            // Combined lifetime "footprint" — sent txs + token transfers.
            // 0 here means "we asked and got nothing" — mark with a sentinel
            // so we don't refetch every scan.
            next.lifetimeTx[a] = sent + tokens > 0 ? sent + tokens : 0;
          });
          // Re-rank slots with the new lifetime data so the heaviest contract
          // can claim the hub instead of the most-locally-chatty wallet.
          next.slotMap = computeStableSlots(next.addresses, next.slotMap, next.lifetimeTx, next.protectedAddrs);
        } catch {
          // ignore — best effort, will retry next scan
        }
      }

      setState(next);
      saveState(next);

      setPulseQueue((q) => {
        const trimmed = q.length > MAX_PULSES_QUEUED / 2 ? q.slice(-MAX_PULSES_QUEUED / 2) : q;
        const merged = [...trimmed, ...newPulses];
        return merged.slice(-MAX_PULSES_QUEUED);
      });

      setScanStatus({
        phase: "ok",
        error: null,
        lastBlockNumber: toBlock,
        lastScanAt: now,
        countdownMs: SCAN_INTERVAL_MS,
        blocksThisScan,
        txsThisScan,
      });
    } catch (err) {
      setScanStatus((s) => ({
        ...s,
        phase: "error",
        error: err && err.shortMessage ? err.shortMessage : (err && err.message) || "RPC error",
      }));
    } finally {
      scanningRef.current = false;
    }
  }, []);

  // initial scan + interval
  useEffect(() => {
    runScan();
    const id = setInterval(runScan, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runScan]);

  // 1Hz tick for countdown HUD
  useEffect(() => {
    tickRef.current = setInterval(() => {
      setScanStatus((s) => {
        if (!s.lastScanAt) return s;
        const elapsed = Date.now() - s.lastScanAt;
        return { ...s, countdownMs: Math.max(0, SCAN_INTERVAL_MS - elapsed) };
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  // Unmount cleanup — abort any in-flight loadAddress so its setState never
  // lands on a torn-down component.
  useEffect(() => {
    return () => {
      if (loadAddressCtrlRef.current) loadAddressCtrlRef.current.abort();
    };
  }, []);

  const layoutValue = buildLayout(state.addresses, state.slotMap, state.addrType, state.lifetimeTx);
  const edges = topEdges(state.edgeCounts, layoutValue.byAddr, 220);
  // Raw edge map (frozen reference) so route mode can scan ALL edges
  // touching a focused address, not just the top-N rendered set.
  const edgeCountsRaw = state.edgeCounts;

  // attach status colors to nodes by recency
  const now = Date.now();
  const nodes = layoutValue.nodes.map((n) => ({
    ...n,
    status: classifyStatus(n.lastSeen, now),
  }));

  const contractsCount = nodes.filter((n) => n.kind === "contract").length;
  const eoaCount = nodes.filter((n) => n.kind === "eoa").length;
  const addressesCount = Object.keys(state.addresses).length;
  const slotCap = MAX_NODES;

  // consumePulse: remove pulse id from queue once animated
  const consumePulse = useCallback((id) => {
    setPulseQueue((q) => q.filter((p) => p.id !== id));
  }, []);

  const clearState = useCallback(() => {
    const fresh = emptyState();
    setState(fresh);
    saveState(fresh);
    setPulseQueue([]);
  }, []);

  // Fetch full tx history for an address from Blockscout API and merge into state.
  // Used by search: if a user looks up an address we haven't scanned yet, this
  // backfills it instantly instead of waiting for the live scanner to catch up.
  const loadAddress = useCallback(async (rawAddr) => {
    const addr = rawAddr.toLowerCase();
    // Replace any prior in-flight loadAddress so consecutive searches don't
    // race + so unmount can cancel cleanly.
    if (loadAddressCtrlRef.current) loadAddressCtrlRef.current.abort();
    const ctrl = new AbortController();
    loadAddressCtrlRef.current = ctrl;
    setScanStatus((s) => ({ ...s, phase: "scanning", error: null }));
    try {
      const r = await fetchWithTimeout(
        `${EXPLORER_API}/addresses/${addr}/transactions`,
        { signal: ctrl.signal }
      );
      if (!r.ok) throw new Error(`Blockscout API ${r.status}`);
      const data = await r.json();
      const items = data && Array.isArray(data.items) ? data.items : [];

      let merged = 0;
      setState((prev) => {
        const next = {
          ...prev,
          addresses: { ...prev.addresses },
          edgeCounts: { ...prev.edgeCounts },
          slotMap: { ...prev.slotMap },
          addrType: { ...prev.addrType },
          lifetimeTx: { ...(prev.lifetimeTx || {}) },
          txHistory: prev.txHistory.slice(),
          totals: { ...prev.totals },
        };

        const seenHashes = new Set(next.txHistory.map((t) => t.hash));

        for (const tx of items) {
          const from = tx.from && tx.from.hash ? tx.from.hash.toLowerCase() : null;
          const to = tx.to && tx.to.hash ? tx.to.hash.toLowerCase() : null;
          if (!from) continue;
          // Defensive parse — a malformed Blockscout timestamp must not
          // poison txHistory with NaN (would break TimeSlider min/max).
          const parsedTs = safeParseTs(tx.timestamp);
          const ts = parsedTs != null ? parsedTs : Date.now();

          if (!next.addresses[from]) next.addresses[from] = { txCount: 0, firstSeen: ts, lastSeen: ts };
          next.addresses[from].txCount++;
          next.addresses[from].lastSeen = Math.max(next.addresses[from].lastSeen, ts);
          if (next.addresses[from].firstSeen > ts) next.addresses[from].firstSeen = ts;
          if (tx.from && typeof tx.from.is_contract === "boolean") {
            next.addrType[from] = tx.from.is_contract ? "contract" : "eoa";
          }

          if (to) {
            if (!next.addresses[to]) next.addresses[to] = { txCount: 0, firstSeen: ts, lastSeen: ts };
            next.addresses[to].txCount++;
            next.addresses[to].lastSeen = Math.max(next.addresses[to].lastSeen, ts);
            if (next.addresses[to].firstSeen > ts) next.addresses[to].firstSeen = ts;
            if (tx.to && typeof tx.to.is_contract === "boolean") {
              next.addrType[to] = tx.to.is_contract ? "contract" : "eoa";
            }
            const key = from + "|" + to;
            next.edgeCounts[key] = (next.edgeCounts[key] || 0) + 1;
          }

          if (!seenHashes.has(tx.hash)) {
            seenHashes.add(tx.hash);
            next.txHistory.push({
              from, to, hash: tx.hash,
              blockNumber: tx.block_number,
              timestamp: ts,
            });
            next.totals.txs++;
            merged++;
          }
        }

        // keep history sorted + bounded
        next.txHistory.sort((a, b) => a.timestamp - b.timestamp);
        if (next.txHistory.length > TX_HISTORY_LIMIT) {
          next.txHistory = next.txHistory.slice(-TX_HISTORY_LIMIT);
        }

        // Recompute slots, then force the searched address into a slot
        next.slotMap = computeStableSlots(next.addresses, next.slotMap, next.lifetimeTx, next.protectedAddrs);
        if (next.addresses[addr] && !next.slotMap[addr]) {
          // evict the lowest-tx-count outer-ring slot, give it to the searched addr
          let victim = null;
          let victimCount = Infinity;
          for (const a of Object.keys(next.slotMap)) {
            if (a === addr) continue;
            const slot = next.slotMap[a];
            if (!slot || slot.ring === 0) continue;
            const c = (next.addresses[a] && next.addresses[a].txCount) || 0;
            if (c < victimCount) { victimCount = c; victim = a; }
          }
          if (victim) {
            const slot = next.slotMap[victim];
            delete next.slotMap[victim];
            next.slotMap[addr] = slot;
          }
        }
        // Now promote this address's counterparties into slots so that the
        // route mode actually shows them. Without this, edges drop at the
        // topEdges filter (which requires both endpoints to be slotted).
        forceSlotsForCounterparties(next, addr, 25);

        return next;
      });

      setScanStatus((s) => ({
        ...s,
        phase: "ok",
        error: null,
        txsThisScan: merged,
        lastScanAt: Date.now(),
      }));
      return { ok: true, merged, totalItems: items.length };
    } catch (err) {
      // A superseded search (or unmount) aborts — don't surface that as an
      // error toast, it's expected.
      if (err && err.name === "AbortError") {
        return { ok: false, aborted: true };
      }
      const msg = err && err.message ? err.message : "API error";
      setScanStatus((s) => ({ ...s, phase: "error", error: msg }));
      return { ok: false, error: msg };
    } finally {
      if (loadAddressCtrlRef.current === ctrl) loadAddressCtrlRef.current = null;
    }
  }, []);

  // Paginate ALL transactions for an address and merge them into state.
  // Used by "SEE ALL INTERACTIONS" — exposes a progress callback so the
  // pinned panel can render a live counter while pages load.
  const loadAddressAll = useCallback(async (rawAddr, opts) => {
    const addr = rawAddr.toLowerCase();
    const onProgress = opts && opts.onProgress;
    const signal = opts && opts.signal;
    const maxPages = (opts && opts.maxPages) || 40; // ~2000 txs cap

    let url = `${EXPLORER_API}/addresses/${addr}/transactions`;
    let totalFetched = 0;
    let totalMerged = 0;
    const collected = [];

    // Some Blockscout instances return intermittent 5xx on deep pagination
    // for hot addresses. Retry each page a few times with backoff before
    // giving up — and if a page fails terminally, keep whatever we got.
    // Distinguish user-abort (don't retry) from timeout-abort (retry).
    const fetchPageWithRetry = async (pageUrl) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal && signal.aborted) return null;
        try {
          const r = await fetchWithTimeout(pageUrl, signal ? { signal } : {});
          if (r.ok) return await r.json();
          if (r.status >= 500) {
            lastErr = new Error(`Blockscout API ${r.status}`);
            await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
            continue;
          }
          throw new Error(`Blockscout API ${r.status}`);
        } catch (e) {
          if (e && e.name === "AbortError") {
            // User cancelled vs. timeout fired. Only the user abort propagates.
            if (signal && signal.aborted) throw e;
            lastErr = e;
            await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
            continue;
          }
          lastErr = e;
          await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
        }
      }
      throw lastErr || new Error("page fetch failed");
    };

    try {
      for (let page = 0; page < maxPages; page++) {
        if (signal && signal.aborted) return { ok: false, aborted: true, merged: totalMerged };
        let data;
        try {
          data = await fetchPageWithRetry(url);
        } catch (pageErr) {
          if (pageErr && pageErr.name === "AbortError") throw pageErr;
          // Terminal page failure — commit what we have and bail with a soft error.
          if (collected.length === 0) throw pageErr;
          break;
        }
        if (!data) break;
        const items = Array.isArray(data.items) ? data.items : [];
        collected.push(...items);
        totalFetched += items.length;
        if (onProgress) onProgress({ page: page + 1, fetched: totalFetched });
        if (!data.next_page_params) break;
        const qp = new URLSearchParams(
          Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])
        );
        url = `${EXPLORER_API}/addresses/${addr}/transactions?${qp.toString()}`;
      }

      setState((prev) => {
        const next = {
          ...prev,
          addresses: { ...prev.addresses },
          edgeCounts: { ...prev.edgeCounts },
          slotMap: { ...prev.slotMap },
          addrType: { ...prev.addrType },
          lifetimeTx: { ...(prev.lifetimeTx || {}) },
          txHistory: prev.txHistory.slice(),
          totals: { ...prev.totals },
        };
        const seenHashes = new Set(next.txHistory.map((t) => t.hash));

        for (const tx of collected) {
          const from = tx.from && tx.from.hash ? tx.from.hash.toLowerCase() : null;
          const to = tx.to && tx.to.hash ? tx.to.hash.toLowerCase() : null;
          if (!from) continue;
          // Same NaN guard as loadAddress — malformed timestamp must not
          // corrupt txHistory.
          const parsedTs = safeParseTs(tx.timestamp);
          const ts = parsedTs != null ? parsedTs : Date.now();

          if (!next.addresses[from]) next.addresses[from] = { txCount: 0, firstSeen: ts, lastSeen: ts };
          next.addresses[from].txCount++;
          next.addresses[from].lastSeen = Math.max(next.addresses[from].lastSeen, ts);
          if (next.addresses[from].firstSeen > ts) next.addresses[from].firstSeen = ts;
          if (tx.from && typeof tx.from.is_contract === "boolean") {
            next.addrType[from] = tx.from.is_contract ? "contract" : "eoa";
          }

          if (to) {
            if (!next.addresses[to]) next.addresses[to] = { txCount: 0, firstSeen: ts, lastSeen: ts };
            next.addresses[to].txCount++;
            next.addresses[to].lastSeen = Math.max(next.addresses[to].lastSeen, ts);
            if (next.addresses[to].firstSeen > ts) next.addresses[to].firstSeen = ts;
            if (tx.to && typeof tx.to.is_contract === "boolean") {
              next.addrType[to] = tx.to.is_contract ? "contract" : "eoa";
            }
            const key = from + "|" + to;
            next.edgeCounts[key] = (next.edgeCounts[key] || 0) + 1;
          }

          if (!seenHashes.has(tx.hash)) {
            seenHashes.add(tx.hash);
            next.txHistory.push({
              from, to, hash: tx.hash,
              blockNumber: tx.block_number,
              timestamp: ts,
            });
            next.totals.txs++;
            totalMerged++;
          }
        }

        next.txHistory.sort((a, b) => a.timestamp - b.timestamp);
        if (next.txHistory.length > TX_HISTORY_LIMIT) {
          next.txHistory = next.txHistory.slice(-TX_HISTORY_LIMIT);
        }
        next.slotMap = computeStableSlots(next.addresses, next.slotMap, next.lifetimeTx, next.protectedAddrs);
        if (next.addresses[addr] && !next.slotMap[addr]) {
          let victim = null;
          let victimCount = Infinity;
          for (const a of Object.keys(next.slotMap)) {
            if (a === addr) continue;
            const slot = next.slotMap[a];
            if (!slot || slot.ring === 0) continue;
            const c = (next.addresses[a] && next.addresses[a].txCount) || 0;
            if (c < victimCount) { victimCount = c; victim = a; }
          }
          if (victim) {
            const slot = next.slotMap[victim];
            delete next.slotMap[victim];
            next.slotMap[addr] = slot;
          }
        }
        // Same neighbour-promotion as loadAddress — even more important here
        // because we just merged hundreds of historical txs.
        forceSlotsForCounterparties(next, addr, 40);
        return next;
      });

      return { ok: true, fetched: totalFetched, merged: totalMerged };
    } catch (err) {
      if (err && err.name === "AbortError") return { ok: false, aborted: true, merged: totalMerged };
      const msg = err && err.message ? err.message : "API error";
      return { ok: false, error: msg, merged: totalMerged };
    }
  }, []);

  // Mark a set of addresses as "protected" — they keep their slots and
  // can't be evicted by the periodic scanner. Pass empty array to release.
  // Recomputes slots immediately so the layout snaps to a consistent state.
  const setProtectedAddrs = useCallback((addrs) => {
    const normalized = Array.isArray(addrs)
      ? Array.from(new Set(addrs.filter((a) => typeof a === "string").map((a) => a.toLowerCase())))
      : [];
    setState((prev) => {
      const prevArr = prev.protectedAddrs || [];
      if (prevArr.length === normalized.length) {
        const prevSet = new Set(prevArr);
        const same = normalized.every((a) => prevSet.has(a));
        if (same) return prev;
      }
      const slotMap = computeStableSlots(prev.addresses, prev.slotMap, prev.lifetimeTx, normalized);
      return { ...prev, protectedAddrs: normalized, slotMap };
    });
  }, []);

  // Force this address's neighbours into slot positions using only local
  // edgeCounts (no API call). Used when the user clicks an already-slotted
  // node so the route view immediately shows its real neighbourhood.
  const expandNeighbors = useCallback((rawAddr) => {
    if (!rawAddr) return;
    const addr = rawAddr.toLowerCase();
    setState((prev) => {
      if (!prev.addresses[addr]) return prev;
      const next = {
        ...prev,
        slotMap: { ...prev.slotMap },
      };
      forceSlotsForCounterparties(next, addr, 25);
      // If nothing changed, return prev so React skips the re-render.
      if (next.slotMap === prev.slotMap) return prev;
      // Cheap shallow check — keys identical means no change
      const changed = Object.keys(next.slotMap).length !== Object.keys(prev.slotMap).length
        || Object.keys(next.slotMap).some((k) => prev.slotMap[k] !== next.slotMap[k]);
      return changed ? next : prev;
    });
  }, []);

  // While a bulk sizing pass is in flight, every per-node setLifetimeTx
  // call skips the expensive computeStableSlots — otherwise resizing 500
  // nodes triggers 500 slot reshuffles in seconds and the UI feels janky.
  // The bulk caller flips this flag on with beginBulkSizing(), drives all
  // its updates, then calls endBulkSizing() to do ONE final recompute.
  const bulkSizingRef = useRef(false);

  // Write a fetched lifetime tx count back into state so the layout can
  // re-rank slots and re-scale node sizes. Used by the pinned panel after
  // it loads Blockscout counters for the address the user clicked.
  const setLifetimeTx = useCallback((addr, value) => {
    if (!addr || typeof value !== "number" || value < 0) return;
    const key = addr.toLowerCase();
    setState((prev) => {
      const prevLT = prev.lifetimeTx || {};
      if (prevLT[key] === value) return prev;
      const lifetimeTx = { ...prevLT, [key]: value };
      // Bulk pass: only update lifetimeTx, defer slot ranking to end.
      // Node sizes still react live (buildLayout reads lifetimeTx) but
      // positions stay stable until the resize finishes.
      if (bulkSizingRef.current) {
        return { ...prev, lifetimeTx };
      }
      const slotMap = computeStableSlots(prev.addresses, prev.slotMap, lifetimeTx, prev.protectedAddrs);
      return { ...prev, lifetimeTx, slotMap };
    });
  }, []);

  // Suspend slot recomputation during a bulk-resize pass. Pair with
  // endBulkSizing() in a try/finally so the flag is always cleared.
  const beginBulkSizing = useCallback(() => {
    bulkSizingRef.current = true;
  }, []);

  // Re-enable slot recomputation and apply ONE recompute against the final
  // lifetimeTx snapshot. Safe to call even if begin() was never invoked.
  const endBulkSizing = useCallback(() => {
    bulkSizingRef.current = false;
    setState((prev) => {
      const slotMap = computeStableSlots(prev.addresses, prev.slotMap, prev.lifetimeTx, prev.protectedAddrs);
      return { ...prev, slotMap };
    });
  }, []);

  return {
    nodes,
    edges,
    byAddr: layoutValue.byAddr,
    pulseQueue,
    consumePulse,
    scanStatus,
    totals: state.totals,
    contractsCount,
    eoaCount,
    addressesCount,
    slotCap,
    txHistory: state.txHistory,
    clearState,
    forceScan: runScan,
    loadAddress,
    loadAddressAll,
    setLifetimeTx,
    beginBulkSizing,
    endBulkSizing,
    expandNeighbors,
    setProtectedAddrs,
    edgeCountsRaw,
  };
}

// ─── Address detail API (used by pinned panel) ─────────────────────────
// Fetch creation/total/today counters for an address. Each call is
// independent so the panel can render progressively. All accept an
// AbortSignal so callers can cancel on unmount / re-pin.
export async function fetchAddressInfo(addr, signal) {
  const a = addr.toLowerCase();
  const r = await fetchWithTimeout(`${EXPLORER_API}/addresses/${a}`, signal ? { signal } : {});
  if (!r.ok) throw new Error(`addresses ${r.status}`);
  return await r.json();
}

export async function fetchAddressCounters(addr, signal) {
  const a = addr.toLowerCase();
  const r = await fetchWithTimeout(`${EXPLORER_API}/addresses/${a}/counters`, signal ? { signal } : {});
  if (!r.ok) throw new Error(`counters ${r.status}`);
  return await r.json();
}

export async function fetchTxTimestamp(hash, signal) {
  if (!hash) return null;
  const r = await fetchWithTimeout(`${EXPLORER_API}/transactions/${hash}`, signal ? { signal } : {});
  if (!r.ok) return null;
  const data = await r.json();
  if (!data || !data.timestamp) return null;
  return safeParseTs(data.timestamp);
}

// Count transactions whose timestamp falls on the local "today".
// Walks pages descending until we cross midnight or hit the cap.
export async function fetchAddressTodayCount(addr, signal) {
  const a = addr.toLowerCase();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();

  let url = `${EXPLORER_API}/addresses/${a}/transactions`;
  let count = 0;
  const maxPages = 10;
  for (let page = 0; page < maxPages; page++) {
    if (signal && signal.aborted) break;
    const r = await fetchWithTimeout(url, signal ? { signal } : {});
    if (!r.ok) break;
    const data = await r.json();
    const items = Array.isArray(data.items) ? data.items : [];
    let stopped = false;
    for (const tx of items) {
      const parsed = safeParseTs(tx.timestamp);
      const ts = parsed != null ? parsed : 0;
      if (ts >= startMs) {
        count++;
      } else {
        stopped = true;
        break;
      }
    }
    if (stopped || !data.next_page_params) break;
    const qp = new URLSearchParams(
      Object.entries(data.next_page_params).map(([k, v]) => [k, String(v)])
    );
    url = `${EXPLORER_API}/addresses/${a}/transactions?${qp.toString()}`;
  }
  return count;
}

export { shortLabel };

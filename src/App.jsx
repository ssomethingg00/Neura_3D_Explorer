import { useState, useEffect, Component } from "react";
import NodeGraph from "./NodeGraph.jsx";
import { useChainScanner, SCAN_INTERVAL_MS, EXPLORER_URL, RPC_URL } from "./chain.js";
import { PALETTES, MODE_NAMES, getPalette } from "./palette.js";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) {
    console.error("NEURA explorer crash:", err, info);
  }
  reset = () => {
    try { localStorage.removeItem("neura-explorer-state-v2"); } catch {}
    this.setState({ err: null });
    if (typeof window !== "undefined") window.location.reload();
  };
  retry = () => {
    // Reload the page so we re-execute the latest bundle. Cache is preserved
    // so the graph picks up where it left off.
    if (typeof window !== "undefined") window.location.reload();
    else this.setState({ err: null });
  };
  render() {
    if (this.state.err) {
      const msg = this.state.err.message || String(this.state.err);
      return (
        <div style={{
          minHeight: "100vh", background: "#0a0a0a", color: "#ddd",
          fontFamily: "Courier New, monospace", padding: "48px 32px",
          display: "flex", flexDirection: "column", gap: 16,
        }}>
          <div style={{ color: "#ef4444", fontSize: 14, letterSpacing: 3 }}>
            ✕ EXPLORER ERROR
          </div>
          <div style={{ color: "#fda4a4", fontSize: 12, letterSpacing: 1, maxWidth: 760, wordBreak: "break-word" }}>
            {msg}
          </div>
          <div style={{ color: "#888", fontSize: 11, letterSpacing: 1 }}>
            This is usually caused by stale cached state. Resetting cache will reload.
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button
              onClick={this.reset}
              style={{
                background: "transparent", border: "1px solid #fff", color: "#fff",
                padding: "10px 18px", fontFamily: "inherit", fontSize: 12,
                letterSpacing: 3, cursor: "pointer",
              }}
            >[ RESET & RELOAD ]</button>
            <button
              onClick={this.retry}
              style={{
                background: "transparent", border: "1px solid #555", color: "#bbb",
                padding: "10px 18px", fontFamily: "inherit", fontSize: 12,
                letterSpacing: 3, cursor: "pointer",
              }}
            >[ RETRY ]</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV_SECTIONS = [
  { id: "explore",  label: "Explore",  target: "graph",   kind: "section" },
  { id: "models",   label: "Models",   target: "models",  kind: "section" },
  { id: "insights", label: "Insights", target: "stats",   kind: "section" },
  { id: "labs",     label: "Labs",     target: "labs",    kind: "section" },
];

function scrollToId(id) {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id);
  if (!el) return;
  // Offset accounts for the sticky nav (~54px) + a little breathing room.
  const top = el.getBoundingClientRect().top + window.scrollY - 70;
  window.scrollTo({ top, behavior: "smooth" });
}

function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    if (!elements.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        // Pick the entry whose top is closest to the viewport top while visible.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -55% 0px", threshold: [0, 0.25, 0.5] }
    );
    elements.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [ids.join("|")]);
  return active;
}

function NavBar({ theme, setTheme }) {
  const activeId = useActiveSection(NAV_SECTIONS.map((s) => s.target));
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a
          className="brand"
          href="#top"
          onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
        >
          <span className="brand-mark">◢</span>
          <span className="brand-name">NEURA</span>
          <span className="brand-sub">/ 3D.EXPLORER</span>
        </a>
        <div className="nav-links">
          {NAV_SECTIONS.map((s) => {
            const isActive = activeId === s.target;
            return (
              <a
                key={s.id}
                href={"#" + s.target}
                className={isActive ? "active" : ""}
                onClick={(e) => { e.preventDefault(); scrollToId(s.target); }}
              >
                <span className="bracket">[</span>{s.label}<span className="bracket">]</span>
              </a>
            );
          })}
        </div>
        <div className="theme-pills">
          <span className="theme-label">THEME ::</span>
          {Object.entries(PALETTES).map(([k, p]) => (
            <button
              key={k}
              className={"pill " + (theme === k ? "active" : "")}
              onClick={() => setTheme(k)}
              title={MODE_NAMES[k] || k.toUpperCase()}
              aria-label={MODE_NAMES[k] || k.toUpperCase()}
            >
              <span className="pill-dot" style={{ background: p.accent }} />
              <span className="pill-label">{MODE_NAMES[k] || k.toUpperCase()}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}

function Hero({ scanStatus, totals }) {
  const status = scanStatus.phase === "error" ? "OFFLINE" :
                 scanStatus.phase === "scanning" ? "SCANNING" : "ONLINE";
  return (
    <section className="hero" id="models">
      <div className="hero-meta">
        <span className="tag">// NEURA · TESTNET · CHAIN 267</span>
        <span className="tag dim">// SCAN {Math.floor(SCAN_INTERVAL_MS / 1000)}s</span>
        <span className="tag dim">// {status}</span>
      </div>
      <h1 className="hero-title">
        NEURA<span className="hero-sep">·</span>3D<span className="hero-sep">·</span>EXPLORER
      </h1>
      <div className="hero-cursor-row">
        <span className="prompt">{'>'}</span>
        <span className="hero-sub">
          Real-time on-chain visualisation. Every {Math.floor(SCAN_INTERVAL_MS / 1000)}s the graph rescans live blocks; each pulse is one real transaction.
        </span>
        <span className="cursor" />
      </div>
      <div className="hero-actions">
        <a className="btn primary" href="https://testnet-blockscout.infra.neuraprotocol.io" target="_blank" rel="noopener noreferrer">
          <span className="btn-bracket">[</span>
          OPEN EXPLORER
          <span className="btn-bracket">]</span>
        </a>
        <a className="btn ghost" href="https://docs.neuraprotocol.io" target="_blank" rel="noopener noreferrer">
          <span className="btn-bracket">[</span>
          DOCUMENTATION
          <span className="btn-bracket">]</span>
        </a>
        <span className="hero-hint">↳ Drag to orbit · Wheel to dolly · Shift-drag to pan · Pinch to zoom</span>
      </div>
    </section>
  );
}

function Stats({ nodes, totals, scanStatus, contractsCount, eoaCount, addressesCount, slotCap }) {
  const cards = [
    {
      label: "ADDRESSES TRACKED",
      value: addressesCount.toLocaleString(),
      delta: `${eoaCount} wallets · ${contractsCount} contracts in layout (cap ${slotCap})`,
    },
    {
      label: "TXS OBSERVED",
      value: totals.txs.toLocaleString(),
      delta: scanStatus.txsThisScan ? "+" + scanStatus.txsThisScan + " this scan" : "0 this scan",
    },
    {
      label: "BLOCKS SCANNED",
      value: totals.blocks.toLocaleString(),
      delta: scanStatus.lastBlockNumber ? "head #" + scanStatus.lastBlockNumber : "watching…",
    },
  ];
  return (
    <section className="stats" id="stats">
      {cards.map((c) => (
        <div key={c.label} className="stat-card">
          <div className="stat-head">
            <span className="stat-label">{c.label}</span>
            <span className="stat-dot" />
          </div>
          <div className="stat-value">{c.value}</div>
          <div className="stat-foot">
            <span className="stat-delta">↗ {c.delta}</span>
          </div>
        </div>
      ))}
    </section>
  );
}

function Toggle({ label, value, setValue, hint }) {
  return (
    <button className={"toggle " + (value ? "on" : "")} onClick={() => setValue(!value)}>
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        <span className="toggle-hint">{hint}</span>
      </span>
      <span className="toggle-state">{value ? "ON" : "OFF"}</span>
    </button>
  );
}

function ControlPanel({
  showLabels, setShowLabels,
  showGrid, setShowGrid,
  scanStatus,
  totals,
  onClear,
  onScanNow,
  palette,
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">CONTROL_PANEL.cfg</span>
        <span className="panel-status">
          <span className={"panel-dot " + (scanStatus.phase === "error" ? "err" : "")} />
          {scanStatus.phase === "error" ? "ERROR" :
           scanStatus.phase === "scanning" ? "SCAN" : "LIVE"}
        </span>
      </div>

      <div className="panel-section">
        <div className="section-title">// FLAGS</div>
        <Toggle label="Show Labels"  hint="render node identifiers"  value={showLabels} setValue={setShowLabels} />
        <Toggle label="Depth Grid"   hint="render depth overlay"      value={showGrid}   setValue={setShowGrid} />
      </div>

      <div className="panel-section">
        <div className="section-title">// SCAN STATUS</div>
        <div className="readout">
          <div className="readout-row"><span>NEXT.SCAN</span><span className="mono">T-{Math.ceil(scanStatus.countdownMs / 1000)}s</span></div>
          <div className="readout-row"><span>LAST.BLOCK</span><span className="mono">{scanStatus.lastBlockNumber ?? "—"}</span></div>
          <div className="readout-row"><span>TX.TOTAL</span><span className="mono">{totals.txs.toLocaleString()}</span></div>
          <div className="readout-row"><span>BLOCK.TOTAL</span><span className="mono">{totals.blocks.toLocaleString()}</span></div>
          <div className="readout-row">
            <span>UPLINK</span>
            <span className={"mono " + (scanStatus.phase === "error" ? "err-text" : "accent-text")}>
              {scanStatus.phase === "error" ? "✕ OFFLINE" : "◉ STABLE"}
            </span>
          </div>
        </div>
        {scanStatus.error && (
          <div className="err-msg" title={scanStatus.error}>
            {scanStatus.error}
          </div>
        )}
      </div>

      <div className="panel-section">
        <div className="section-title">// LEGEND</div>
        <div className="panel-legend">
          <div className="legend-row"><span className="legend-dot" style={{ background: palette.active2 }} />Active &lt;2 min</div>
          <div className="legend-row"><span className="legend-dot" style={{ background: palette.active10 }} />Active &lt;10 min</div>
          <div className="legend-row"><span className="legend-dot" style={{ background: palette.idle }} />Idle</div>
          <div className="legend-row"><span className="legend-dot" style={{ background: palette.pulseLive }} />Live tx pulse</div>
          <div className="legend-row"><span className="legend-dot" style={{ background: palette.pulseReplay }} />Replay pulse</div>
          <div className="legend-row"><span className="legend-dot" style={{ background: palette.focused }} />Focused address</div>
          <div className="legend-row"><span className="legend-square" />Contract · ● Wallet</div>
        </div>
      </div>

      <div className="panel-section">
        <div className="section-title">// ACTIONS</div>
        <button className="btn primary panel-cta" onClick={onScanNow}>
          <span className="btn-bracket">[</span>SCAN NOW<span className="btn-bracket">]</span>
        </button>
        <button className="btn ghost panel-cta" onClick={onClear} title="Wipe cached addresses & edges">
          <span className="btn-bracket">[</span>RESET CACHE<span className="btn-bracket">]</span>
        </button>
      </div>
    </div>
  );
}

function Footer({ theme, scanStatus, totals, addressesCount }) {
  const year = new Date().getFullYear();
  return (
    <footer className="footer" id="contact">
      <div className="foot-grid">
        <div className="foot-col foot-brand">
          <div className="foot-brand-row">
            <span className="brand-mark">◢</span>
            <span className="brand-name">NEURA</span>
            <span className="brand-sub">/ 3D.EXPLORER</span>
          </div>
          <p className="foot-blurb">
            Real-time 3D visualisation of the Neura Protocol testnet.
            Every pulse is a live on-chain transaction — rescanned every
            {" "}{Math.floor(SCAN_INTERVAL_MS / 1000)}s straight from the RPC.
          </p>
          <div className="foot-socials">
            <a
              className="foot-icon"
              href="https://github.com/ssomethingg00"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub · somethingg00"
              aria-label="GitHub"
            >&lt;/&gt;</a>
            <a
              className="foot-icon"
              href="https://x.com/Neura_io"
              target="_blank"
              rel="noopener noreferrer"
              title="Neura on X"
              aria-label="X / Twitter"
            >𝕏</a>
            <a
              className="foot-icon"
              href="https://discord.gg/neuraprotocol"
              target="_blank"
              rel="noopener noreferrer"
              title="Neura Discord"
              aria-label="Discord"
            >◉</a>
          </div>
        </div>

        <div className="foot-col">
          <div className="foot-head">EXPLORE</div>
          <a href="#models"   onClick={(e) => { e.preventDefault(); scrollToId("models"); }}>Overview</a>
          <a href="#stats"    onClick={(e) => { e.preventDefault(); scrollToId("stats"); }}>Insights</a>
          <a href="#graph"    onClick={(e) => { e.preventDefault(); scrollToId("graph"); }}>3D Graph</a>
          <a href="#labs"     onClick={(e) => { e.preventDefault(); scrollToId("labs"); }}>Labs / Controls</a>
        </div>

        <div className="foot-col">
          <div className="foot-head">NEURA NETWORK</div>
          <a href="https://www.neuraprotocol.io" target="_blank" rel="noopener noreferrer">Main Site ↗</a>
          <a href="https://docs.neuraprotocol.io" target="_blank" rel="noopener noreferrer">Documentation ↗</a>
          <a href={EXPLORER_URL} target="_blank" rel="noopener noreferrer">Blockscout ↗</a>
          <a href={RPC_URL} target="_blank" rel="noopener noreferrer">Testnet RPC ↗</a>
          <a href="https://faucet.neuraprotocol.io" target="_blank" rel="noopener noreferrer">Testnet Faucet ↗</a>
        </div>

        <div className="foot-col">
          <div className="foot-head">BUILDER</div>
          <a href="https://github.com/ssomethingg00" target="_blank" rel="noopener noreferrer">
            <span className="dim">@</span>somethingg00 ↗
          </a>
          <a href="https://github.com/ssomethingg00/Neura_3D_Explorer" target="_blank" rel="noopener noreferrer">
            Source Code ↗
          </a>
          <div className="foot-stat">
            <span className="dim">// LIVE</span>
            <span className="accent-text">
              {totals.txs.toLocaleString()} tx · {addressesCount} addrs
            </span>
          </div>
        </div>
      </div>

      <div className="foot-bar">
        <div className="foot-row">
          <span>NEURA © {year}</span>
          <span className="dim">·</span>
          <span>BUILD 3.14.0-beta</span>
          <span className="dim">·</span>
          <span>SIGNED-{theme.toUpperCase()}</span>
          <span className="dim">·</span>
          <span className={scanStatus.phase === "error" ? "err-text" : "accent-text"}>
            {scanStatus.phase === "error" ? "✕ RPC OFFLINE" : "◉ ALL SYSTEMS NOMINAL"}
          </span>
        </div>
        <div className="foot-row dim">
          <span>// Press ESC to exit terminal · CHAIN 267</span>
        </div>
      </div>
    </footer>
  );
}

export default function App() {
  const [theme, setTheme] = useState("mono");
  const [showLabels, setShowLabels] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [fullscreen, setFullscreen] = useState(true);

  const palette = getPalette(theme);

  const scanner = useChainScanner();

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [fullscreen]);

  useEffect(() => {
    const p = getPalette(theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--accent", p.accent);
    document.documentElement.style.setProperty("--accent-glow", p.glow);
  }, [theme]);

  // Cursor-follow spotlight — drives the --mx / --my CSS vars used by
  // .cursor-grid + .cursor-spot to brighten the page grid near the pointer.
  // RAF-throttled so mousemove doesn't trash render performance.
  useEffect(() => {
    const root = document.documentElement;
    let rafId = 0;
    let nx = -1000, ny = -1000;
    const flush = () => {
      rafId = 0;
      root.style.setProperty("--mx", nx + "px");
      root.style.setProperty("--my", ny + "px");
    };
    const onMove = (e) => {
      nx = e.clientX;
      ny = e.clientY;
      if (!rafId) rafId = requestAnimationFrame(flush);
    };
    const onLeave = () => {
      nx = -1000; ny = -1000;
      if (!rafId) rafId = requestAnimationFrame(flush);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerleave", onLeave);
    document.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("mouseleave", onLeave);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <ErrorBoundary>
    <div className="app">
      <div className="cursor-grid" aria-hidden="true" />
      <div className="cursor-spot" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />
      <NavBar theme={theme} setTheme={setTheme} />
      <main className="main">
        <Hero scanStatus={scanner.scanStatus} totals={scanner.totals} />
        <Stats
          nodes={scanner.nodes}
          totals={scanner.totals}
          scanStatus={scanner.scanStatus}
          contractsCount={scanner.contractsCount}
          eoaCount={scanner.eoaCount}
          addressesCount={scanner.addressesCount}
          slotCap={scanner.slotCap}
        />
        <section className="grid" id="graph">
          <div className="grid-left">
            <NodeGraph
              nodes={scanner.nodes}
              edges={scanner.edges}
              byAddr={scanner.byAddr}
              pulseQueue={scanner.pulseQueue}
              consumePulse={scanner.consumePulse}
              scanStatus={scanner.scanStatus}
              txHistory={scanner.txHistory}
              loadAddress={scanner.loadAddress}
              loadAddressAll={scanner.loadAddressAll}
              setLifetimeTx={scanner.setLifetimeTx}
              beginBulkSizing={scanner.beginBulkSizing}
              endBulkSizing={scanner.endBulkSizing}
              expandNeighbors={scanner.expandNeighbors}
              setProtectedAddrs={scanner.setProtectedAddrs}
              edgeCountsRaw={scanner.edgeCountsRaw}
              showLabels={showLabels}
              showGrid={showGrid}
              fullscreen={fullscreen}
              setFullscreen={setFullscreen}
              palette={palette}
            />
          </div>
          <div className="grid-right" id="labs">
            <ControlPanel
              showLabels={showLabels} setShowLabels={setShowLabels}
              showGrid={showGrid} setShowGrid={setShowGrid}
              scanStatus={scanner.scanStatus}
              totals={scanner.totals}
              onClear={scanner.clearState}
              onScanNow={scanner.forceScan}
              palette={palette}
            />
          </div>
        </section>
        <Footer
          theme={theme}
          scanStatus={scanner.scanStatus}
          totals={scanner.totals}
          addressesCount={scanner.addressesCount}
        />
      </main>
    </div>
    </ErrorBoundary>
  );
}

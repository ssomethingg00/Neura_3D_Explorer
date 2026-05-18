import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "../styles.css";

document.title = "NEURA · 3D EXPLORER";
document.documentElement.lang = "en";

const ensureMeta = (name, content) => {
  let el = document.head.querySelector(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
};
ensureMeta("color-scheme", "dark");
ensureMeta("description", "Real-time on-chain visualisation of the Neura testnet.");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

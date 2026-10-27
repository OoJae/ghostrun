import { createRoot } from "react-dom/client";
import { adoptJudgeToken } from "./api";
import { App } from "./App";
import { probe } from "./probe";
import "./styles.css";

probe();
adoptJudgeToken(); // ?t= moves to sessionStorage before anything can log or share the URL
// e2e only (builds made with VITE_IWER=1): an emulated Quest 3, so VR is testable without a headset
if (import.meta.env.VITE_IWER === "1" && new URLSearchParams(window.location.search).get("iwer") === "1") {
  const { XRDevice, metaQuest3 } = await import("iwer");
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true, polyfillLayers: true }); // headless Chromium has a native navigator.xr with no device
  (window as unknown as { __IWER__: unknown }).__IWER__ = device;
}
// No StrictMode: its double-mounted effects would create (and tear down) a second GPU device.
createRoot(document.getElementById("root")!).render(<App />);

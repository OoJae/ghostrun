import { createRoot } from "react-dom/client";
import { App } from "./App";
import { probe } from "./probe";
import "./styles.css";

probe();
// No StrictMode: its double-mounted effects would create (and tear down) a second GPU device.
createRoot(document.getElementById("root")!).render(<App />);

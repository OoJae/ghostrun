import { createRoot } from "react-dom/client";
import { adoptJudgeToken } from "./api";
import { App } from "./App";
import { probe } from "./probe";
import "./styles.css";

probe();
adoptJudgeToken(); // ?t= moves to sessionStorage before anything can log or share the URL
// No StrictMode: its double-mounted effects would create (and tear down) a second GPU device.
createRoot(document.getElementById("root")!).render(<App />);

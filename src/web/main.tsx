import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./index.css";

document.documentElement.classList.add("dark");

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

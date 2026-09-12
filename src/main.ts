import { App } from "./ui/App";

const root = document.getElementById("app");
if (!root) throw new Error("#app not found");
const app = new App(root);

// Reachable from the browser console during development, for poking at the
// connection, the settings and the panels. Not exposed in a built app.
if (import.meta.env.DEV) (window as unknown as { iviz: App }).iviz = app;

// Handy from the dev-tools console while developing (never in a release build).
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;

// During `vite dev`, tear down the old instance (WebSocket, render loop, timers)
// before the module is re-evaluated, so stats and bandwidth are not doubled.
if (import.meta.hot) {
  import.meta.hot.dispose(() => app.dispose());
}

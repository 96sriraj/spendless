import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

/**
 * The client entry.
 *
 * `StrictMode` because double-invoking effects in development is how you find
 * out that a fetch cancels itself on unmount. The health check above already
 * guards against that with a `cancelled` flag; this is what makes you notice if
 * a future effect forgets to.
 *
 * Nothing clever here on purpose. No error boundary, no suspense, no provider
 * stack — each of those is a thing to add when something actually needs it, and
 * a wrapper added "for robustness" on day one is a wrapper nobody ever reads.
 */
const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
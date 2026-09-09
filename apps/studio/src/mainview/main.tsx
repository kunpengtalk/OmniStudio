import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import "katex/dist/katex.min.css";

import { App } from "./app";
import { Providers } from "./components/providers";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);

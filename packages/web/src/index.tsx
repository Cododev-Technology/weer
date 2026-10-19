import React from "react";
import { createRoot } from "react-dom/client";

import App from "./components/App";
import PricingCards from "./components/PricingCards";
import lib from "./lib";

// Back from Google's sign-in, go to the page it was started from instead
if (!lib.returnAfterLogin()) {
  const root = createRoot(document.getElementById("root")!);
  root.render(window.location.pathname === "/pricing" ? <PricingCards /> : <App />);
}

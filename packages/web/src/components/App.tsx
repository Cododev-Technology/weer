import React, { useEffect } from "react";
import Navigation from "./Navigation";
import UrlShortener from "./UrlShortener";
import Urls from "./Urls";

import { AuthProvider } from "../AuthContext";
import { ModalProvider, useModal } from "../ModalContext";
import { UrlProvider } from "../UrlContext";

const AppContent: React.FC = () => {
  const { openModal } = useModal();

  useEffect(() => {
    if (window.location.pathname === "/reset-password") {
      const params = new URLSearchParams(window.location.search);
      const token = params.get("t");
      const userId = params.get("i");
      if (token && userId) openModal("resetPassword", { token, userId });
      window.history.replaceState({}, "", "/");
    }
  }, []);

  return (
    <>
      <Navigation />
      <UrlProvider>
        <UrlShortener />
        <Urls />
      </UrlProvider>
    </>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <ModalProvider>
        <AppContent />
      </ModalProvider>
    </AuthProvider>
  );
};

export default App;

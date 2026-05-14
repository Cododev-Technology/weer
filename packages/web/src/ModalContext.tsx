import React, {
  createContext,
  useContext,
  useCallback,
  useState,
  ReactNode,
} from "react";
import { GlobalModalRenderer } from "./components/modals/GlobalModalRenderer";

type ModalType = "login" | "confirmDelete" | "qrCode" | "customizeLink" | "editRealUrl" | null;

interface ModalContextValue {
  openModal: (type: ModalType, props?: Record<string, any>) => void;
  closeModal: () => void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

export const useModal = () => {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("useModal must be used inside ModalProvider");
  return ctx;
};

export const ModalProvider = ({ children }: { children: ReactNode }) => {
  const [modal, setModal] = useState<{ type: ModalType; props?: any }>({
    type: null,
  });

  // useCallback ensures the functions have stable references
  const openModal = useCallback((type: ModalType, props?: any) => {
    setModal({ type, props });
  }, []);

  const closeModal = useCallback(() => {
    setModal({ type: null });
  }, []);

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = React.useMemo(
    () => ({ openModal, closeModal }),
    [openModal, closeModal]
  );

  return (
    <ModalContext.Provider value={contextValue}>
      {children}
      <GlobalModalRenderer modal={modal} closeModal={closeModal} />
    </ModalContext.Provider>
  );
};

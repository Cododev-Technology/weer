import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import axios from "axios";
import lib from "./lib";

interface AuthContextValue {
  loading: boolean;
  isSignedIn: boolean | null;
  email: string;
  username: string;
  refreshAuth: () => Promise<void>;
  updateUsername: (newUsername: string) => Promise<void>;
  inactiveUsernames: InactiveUsername[];
}

const AuthContext = createContext<AuthContextValue | null>(null);

// What the API returns for each username
interface UsernameEntry {
  value: string;
  active: boolean;
  expires_at: string;
}

// for the inactiveUsernames state
interface InactiveUsername {
  username: string;
  expiresAt: Date;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [isSignedIn, setIsSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string>("");
  const [username, setUsername] = useState<string>("");
  const [inactiveUsernames, setInactiveUsernames] = useState<
    InactiveUsername[]
  >([]);

  const refreshAuth = useCallback(async () => {
    setLoading(true);
    const { data } = await axios.get("/auth/status");

    setIsSignedIn(data.isSignedIn);
    setEmail(data.email);

    if (data.isSignedIn) {
      // Find the active username and set it
      const activeUsernameObj = data.usernames.find(
        (uname: UsernameEntry) => uname.active
      );

      setUsername(activeUsernameObj ? activeUsernameObj.value : "");

      // Set inactive usernames
      const inactiveUsernames = data.usernames.length
        ? data.usernames
            .filter((uname: UsernameEntry) => !uname.active)
            .map((uname: UsernameEntry) => ({
              username: uname.value,
              expiresAt: new Date(uname.expires_at),
            }))
        : [];
      setInactiveUsernames(inactiveUsernames);
    }

    setLoading(false);
  }, []);

  const updateUsername = async (newUsername: string) => {
    try {
      await axios.patch("/user/username", {
        username: newUsername,
      });

      setUsername(newUsername);
    } catch (error) {
      lib.handleErr(error);
    }
  };

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  return (
    <AuthContext.Provider
      value={{
        isSignedIn,
        email,
        username,
        refreshAuth,
        loading,
        updateUsername,
        inactiveUsernames,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};

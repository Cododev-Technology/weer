import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import axios from "axios";
import type { API } from "@weer/common";

interface AuthContextValue {
  loading: boolean;
  isSignedIn: boolean | null;
  email: string;
  username: string;
  refreshAuth: () => Promise<void>;
  updateUsername: (newUsername: string) => Promise<void>;
  inactiveUsernames: InactiveUsername[];
  linkCredits: number;
  sendCode: (name: string, email: string, password: string, username?: string) => Promise<void>;
  register: (
    name: string,
    email: string,
    password: string,
    code: string,
    username?: string
  ) => Promise<void>;
  logIn: (email: string, password: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  confirmPasswordReset: (userId: string, token: string, newPassword: string) => Promise<void>;
  requestEmailChange: (newEmail: string) => Promise<void>;
  confirmEmailChange: (newEmail: string, code: string) => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
  const [linkCredits, setLinkCredits] = useState<number>(0);

  const refreshAuth = useCallback(async () => {
    setLoading(true);
    const { data } = await axios.get<API.Auth.StatusResponse>("/auth/status");

    setIsSignedIn(data.isSignedIn);
    setEmail(data.email ?? "");
    setLinkCredits(data.linkCredits ?? 0);

    if (data.isSignedIn) {
      const usernames = data.usernames ?? [];

      // Find the active username and set it
      const activeUsernameObj = usernames.find((uname) => uname.active);

      setUsername(activeUsernameObj ? activeUsernameObj.value : "");

      // Set inactive usernames
      const inactiveUsernames = usernames.length
        ? usernames
            .filter((uname) => !uname.active)
            .map((uname) => ({
              username: uname.value,
              expiresAt: new Date(uname.expires_at!), // inactive usernames always have expires_at set
            }))
        : [];
      setInactiveUsernames(inactiveUsernames);
    }

    setLoading(false);
  }, []);

  const updateUsername = async (newUsername: string) => {
    await axios.patch("/user/username", {
      username: newUsername,
    });

    setUsername(newUsername);
  };

  const sendCode = async (name: string, email: string, password: string, username?: string) => {
    await axios.post<any, any, API.Auth.SendCodeBody>("/auth/send-code", {
      name,
      email,
      password,
      username,
    });
  };

  const register = async (
    name: string,
    email: string,
    password: string,
    code: string,
    username?: string
  ) => {
    await axios.post<any, any, API.Auth.RegisterBody>("/auth/register", {
      name,
      email,
      password,
      code,
      username,
    });
  };

  const logIn = async (email: string, password: string) => {
    await axios.post<any, any, API.Auth.LoginBody>("/auth/login", { email, password });
  };

  const requestPasswordReset = async (email: string) => {
    await axios.post<any, any, API.Auth.ForgotPasswordBody>("/auth/forgot-password", {
      email,
    });
  };

  const confirmPasswordReset = async (userId: string, token: string, newPassword: string) => {
    await axios.patch<any, any, API.Auth.ResetPasswordBody>("/auth/reset-password", {
      userId,
      token,
      newPassword,
    });
  };

  const requestEmailChange = async (newEmail: string) => {
    await axios.post<any, any, API.User.SendEmailChangeCodeBody>(
      "/user/email/send-code",
      { newEmail }
    );
  };

  const confirmEmailChange = async (newEmail: string, code: string) => {
    await axios.patch<any, any, API.User.ConfirmEmailChangeBody>(
      "/user/email/confirm",
      { newEmail, code }
    );
    await refreshAuth();
  };

  const changePassword = async (newPassword: string) => {
    await axios.patch<any, any, API.User.ChangePasswordBody>("/user/password", {
      newPassword,
    });
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
        linkCredits,
        sendCode,
        register,
        logIn,
        requestPasswordReset,
        confirmPasswordReset,
        requestEmailChange,
        confirmEmailChange,
        changePassword,
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

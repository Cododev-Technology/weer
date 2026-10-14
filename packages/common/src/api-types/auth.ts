export namespace Auth {
  export interface SendCodeBody {
    name: string;
    email: string;
    password: string;
    username?: string;
  }

  export interface RegisterBody {
    name: string;
    email: string;
    password: string;
    code: string;
    username?: string;
  }

  export interface LoginBody {
    email: string;
    password: string;
  }

  export interface ForgotPasswordBody {
    email: string;
  }

  export interface ResetPasswordBody {
    userId: string;
    token: string;
    newPassword: string;
  }

  export interface StatusResponse {
    isSignedIn: boolean;
    email?: string;
    linkCredits?: number;
    usernames?: { value: string; expires_at: string | null; active: boolean }[];
  }
}

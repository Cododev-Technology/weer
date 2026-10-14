import type { LinkType } from "@weer/common";

export type TTables =
  | "users"
  | "urls"
  | "ultra_codes"
  | "sessions"
  | "digit_codes"
  | "usernames"
  | "views"
  | "rate_limits"
  | "tokens"
  | "email_codes"
  | "email_rate_limits"
  | "login_rate_limits";

export interface IUser {
  id: number;
  google_id?: string;
  username?: string;
  email?: string;
  name?: string;
  password?: string;
  verified?: boolean;
  link_credits?: number;
  token_code?: string | null;
  token_date?: Date | null;
  updated_at: Date;
  created_at: Date;
}

export interface IRateLimit {
  ip_address: string;
  burst_count: number;
  burst_reset_at: Date;
}

export interface IEmailRateLimit {
  email: string;
  burst_count: number;
  burst_reset_at: Date;
}

export interface ILoginRateLimit {
  email: string;
  burst_count: number;
  burst_reset_at: Date;
}

export interface IToken {
  id: string;
  user_id: number;
  expires_at: Date;
  created_at: Date;
}

export interface IEmailCode {
  id: number;
  email: string;
  code: number;
  attempts: number;
  expires_at: Date;
  created_at: Date;
}

export interface IUsername {
  id: number;
  user_id: number;
  username: string;
  active: boolean;
  expires_at?: Date;
  created_at: Date;
}

export interface IUrl {
  id: number;
  real_url: string;
  shortened_url_id: string;
  qr_code_id: string;
  user_id?: number;
  session_id?: number;
  link_type: LinkType;
  updated_at: Date;
  created_at: Date;
}

export interface IUltraCode {
  id: number;
  code: string;
  url_id?: number;
  expires_at?: Date;
  assigned_at: Date;
}

export interface IDigitCode {
  id: number;
  code: string;
  code_length: number;
  url_id?: number;
  expires_at?: Date;
  assigned_at?: Date;
}

export interface IView {
  id: number;
  url_id: number;
  user_agent: string;
  referrer: string;
  link_type?: LinkType;
  via_qr?: boolean;
  ip_address?: string;
  country?: string;
  city?: string;
  visitor_hash: string;
  created_at: Date;
}

export interface ISession {
  id: number;
  session_token: string;
  data: object;
  created_at: Date;
  last_active: Date;
  expires_at: Date;
}

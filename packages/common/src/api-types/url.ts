import type { LinkType } from "../types";

export namespace Url {
  export interface ShortenBody {
    url: string;
    type: LinkType;
  }

  export interface ChangeTypeBody {
    type: LinkType;
    code?: string;
  }

  export interface UpdateRealUrlBody {
    url: string;
  }

  export interface Stats {
    total: number;
    unique_visitors: number;
    qr_clicks: number;
    last_clicked: string | null;
  }
}

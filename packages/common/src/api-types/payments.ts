export namespace Payments {
  export interface StatusResponse {
    enabled: boolean;
  }

  export interface CheckoutBody {
    credits: number;
  }

  export interface CheckoutResponse {
    transactionId: string;
    clientToken: string;
    environment: "sandbox" | "production";
    email?: string;
  }

  export interface ConfirmBody {
    transactionId: string;
  }

  export interface ConfirmResponse {
    linkCredits: number;
  }
}

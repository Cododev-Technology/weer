import creditPacks from "./config/credit-packs.json";

export interface CreditPack {
  credits: number;
  price: string; // USD, before tax
  linksPerDollar: number;
  featured: boolean;
  paddle: { sandbox: string; production: string }; // Paddle price ids
}

export const CREDIT_PACKS: CreditPack[] = creditPacks;

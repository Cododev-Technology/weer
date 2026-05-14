import type { LinkType } from "@weer/common";
import type request from "supertest";

interface CreatedUrl {
  URLId: number;
  code: string;
  realURL: string;
  linkType: LinkType;
  expiresAt: string | null;
}

export const createClassicLink = async (
  agent: ReturnType<typeof request.agent>,
  url = "http://www.example.com"
): Promise<CreatedUrl> => {
  const res = await agent.post("/url").send({ url, type: "classic" });
  return res.body as CreatedUrl;
};
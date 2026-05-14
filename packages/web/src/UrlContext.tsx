/** All the shortened URLs are handled in this context */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import axios from "axios";
import lib from "./lib";

import type { IUrl } from "./types";
import type { LinkType } from "@weer/common";

interface UrlContextValue {
  urls: IUrl[];
  justCreatedUrlId: string | null; // ID of the URL that was just created
  domain: string | null;
  loading: boolean;
  fetchUrls: () => Promise<void>;
  createUrl: (url: string) => Promise<void>;
  changeType: (
    id: string,
    newType: LinkType,
    newExpiresAt?: string,
    newCode?: string
  ) => void;
  updateRealUrl: (id: string, newRealUrl: string) => void;
  addUrl: (url: IUrl) => void;
  deleteUrl: (id: string) => void;
}

const UrlContext = createContext<UrlContextValue | null>(null);

export const UrlProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [urls, setUrls] = useState<IUrl[]>([]);
  const [domain, setDomain] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); // for fetching URLs
  const [justCreatedUrlId, setJustCreatedUrlId] = useState<string | null>(null);

  // Centralized fetch function
  const fetchUrls = async () => {
    setLoading(true);
    try {
      const { data } = await axios.get("/url");
      setUrls(data.urls as IUrl[]);
      setDomain(data.domain);
    } catch (error) {
      lib.handleErr(error);
    } finally {
      setLoading(false);
    }
  };

  // When user shortens a new URL
  const createUrl = async (realUrl: string) => {
    const submitRequest = async (type: "digit" | "classic") => {
      const { data } = await axios.post("/url", { url: realUrl, type });

      const newUrlObj: IUrl = {
        id: data.URLId,
        real_url: data.realURL,
        code: data.code,
        link_type: data.linkType,
        expires_at: data.expiresAt || null,
      };

      setUrls((prev) => [newUrlObj, ...prev]);
      setJustCreatedUrlId(newUrlObj.id);
    };

    try {
      // Attempt 1: Try the 'digit' type
      await submitRequest("digit");
    } catch (error) {
      // Attempt 2: Fallback to 'classic' if digits are exhausted (503)
      if (axios.isAxiosError(error) && error.response?.status === 503) {
        try {
          await submitRequest("classic");
        } catch (error) {
          lib.handleErr(error);
        }
      } else {
        lib.handleErr(error);
      }
    }
  };

  useEffect(() => {
    fetchUrls();
  }, []);

  const addUrl = (newUrl: IUrl) => {
    setUrls((prevUrls) => [...prevUrls, newUrl]);
  };

  const deleteUrl = (id: string) => {
    // Check if justCreatedUrlId is this, set it to null so that the URL is removed
    // from the URlShortener component if it was just created there
    if (justCreatedUrlId === id) {
      setJustCreatedUrlId(null);
    }

    setUrls((prevUrls) => prevUrls.filter((url) => url.id !== id));
  };

  const updateRealUrl = (id: string, newRealUrl: string) => {
    setUrls((prevUrls) =>
      prevUrls.map((url) =>
        url.id === id ? { ...url, real_url: newRealUrl } : url
      )
    );
  };

  // Change a URL type and possibly other fields
  const changeType = (
    id: string,
    newType: LinkType,
    newExpiresAt?: string,
    newCode?: string
  ) => {
    setUrls((prevUrls) =>
      prevUrls.map((url) =>
        url.id === id
          ? {
              ...url,
              link_type: newType,
              expires_at: newExpiresAt || url.expires_at,
              code: newCode || url.code,
            }
          : url
      )
    );
  };

  const contextValue = {
    urls,
    fetchUrls,
    loading,
    domain,
    createUrl,
    addUrl,
    deleteUrl,
    changeType,
    updateRealUrl,
    justCreatedUrlId,
  };

  return (
    <UrlContext.Provider value={contextValue}>{children}</UrlContext.Provider>
  );
};

export const useUrl = () => {
  const ctx = useContext(UrlContext);
  if (!ctx) throw new Error("useUrl must be used inside UrlProvider");
  return ctx;
};

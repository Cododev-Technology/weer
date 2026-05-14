import React, { FC, useEffect, useState } from "react";
import axios from "axios";
import { Loading } from "@weer/reusable";
import type { LinkType } from "@weer/common";
import { useAuth } from "../AuthContext";
import { useModal } from "../ModalContext";
import { useUrl } from "../UrlContext";
import type { IUrl } from "../types";

import LinkShow from "./LinkShow";

interface UrlsProps {}

const Urls: FC<UrlsProps> = (props) => {
  const { openModal } = useModal();
  const { isSignedIn, username } = useAuth();

  const { urls, domain, loading, fetchUrls, deleteUrl } = useUrl();

  const renderUrls = () => {
    if (loading) {
      return (
        <div className="text-center margin-top-md">
          <Loading color="dark" />
        </div>
      );
    }

    // User has urls
    if (urls.length > 0) {
      return urls.map((url) => {
        return (
          <LinkShow
            key={url.id}
            urlId={url.id}
            realUrl={url.real_url}
            type={url.link_type}
            expiresAt={url.expires_at}
            onList={true}
            shortenedUrlCode={url.code}
            domain={domain!}
            onDelete={() => {
              deleteUrl(url.id);
            }}
          />
        );
      });
    }

    // User has no url
    if (urls.length === 0) {
      return (
        <p className="text-center a-2">You haven't shortened any URLs yet.</p>
      );
    }
  };

  return (
    <div data-testid="urls">
      <section className="section section--2">
        <h2>Your Shortened URLs</h2>
        {renderUrls()}

        {/* User has url but not logged in */}
        {!loading && urls && urls.length > 0 && !isSignedIn && (
          <p className="text-center a-2">
            You are not logged in!{" "}
            <button
              className="button-text button-text-inherit"
              onClick={() => openModal("login")}
            >
              Login
            </button>{" "}
            to save your URLs and be able to better manage and customize them.
          </p>
        )}
      </section>
    </div>
  );
};

export default Urls;

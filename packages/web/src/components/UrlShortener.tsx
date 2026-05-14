import React, { FC, useEffect, useState, useMemo } from "react";
import axios from "axios";
import { Button, Input } from "@weer/reusable";
import type { LinkType } from "@weer/common";
import { useUrl } from "../UrlContext";
import LinkShow from "./LinkShow";
import lib from "../lib";
import { IUrl } from "../types";

interface UrlShortenerProps {}

const UrlShortener: FC<UrlShortenerProps> = (props) => {
  const { createUrl, justCreatedUrlId, urls, domain } = useUrl();

  const [url, setUrl] = useState<string>(""); // input url
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false); // for URL shorten form button

  const createdUrlObject = useMemo(() => {
    if (!justCreatedUrlId || !urls) return null;
    return urls.find((u: IUrl) => u.id === justCreatedUrlId);
  }, [urls, justCreatedUrlId]);

  async function onFormSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setLoading(true);
    let newUrl = lib.ensureProtocol(url);

    if (lib.validURL(newUrl)) {
      try {
        await createUrl(newUrl);

        // Hide the error
        hideError();

        setUrl("");
      } catch (e: any) {
        // Show relevant errors to user on server errors
        if (e.response && e.response.status === 400) {
          showError(e.response.data.error);
        }

        if (e.response && e.response.status === 500) {
          showError("Sorry an unexpected error happened please try again.");
        }
      }
    } else if (url.length > 0) {
      // Show an error to user if the url is not valid
      showError("The URL you put is not valid.");
    } else {
      // Show an error to user if no url has been provided
      showError("Please first put your URL here.");
    }

    setLoading(false);
  }

  function showError(msg: string) {
    setErrorMessage(msg);
  }

  function hideError() {
    setErrorMessage("");
  }

  return (
    <section className="section" data-testid="url-shortener">
      <div className="main-heading">
        <h1 className="heading-primary">Shorten a URL</h1>
        <span className="main-heading__span">Like a professional!</span>
      </div>

      <div className="box">
        <form
          onSubmit={(event) => onFormSubmit(event)}
          className="url-input u-flex-text-center"
        >
          <Input
            placeholder="Put your link here..."
            value={url}
            onChange={(value) => setUrl(value)}
            error={errorMessage}
            tooltipPosition="left"
            help="Just put your long URL in the text box below and click shorten to get a nice small URL along with a QR Code. You will be able to customize it after."
          />

          <Button
            type="submit"
            loading={loading}
            color="blue"
            size="big"
            loadingText="Shortening"
          >
            Shorten
          </Button>
        </form>
      </div>

      {createdUrlObject && (
        <LinkShow
          urlId={createdUrlObject.id}
          realUrl={createdUrlObject.real_url}
          shortenedUrlCode={createdUrlObject.code}
          domain={domain!}
          expiresAt={createdUrlObject.expires_at}
          type={createdUrlObject.link_type}
          onList={false}
        />
      )}

      <p className="a-1">
        By clicking Shorten, you agree to our{" "}
        <a className="button-text button-text-blue" href="#">
          Privacy Policy
        </a>{" "}
        and{" "}
        <a className="button-text button-text-blue" href="#">
          Terms of Use
        </a>
        .
      </p>
    </section>
  );
};

export default UrlShortener;

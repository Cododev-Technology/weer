import React, { FC, useState, useEffect } from "react";
import { ButtonIcon } from "@weer/reusable";
import { useModal } from "../ModalContext";
import { useAuth } from "../AuthContext";
import { useUrl } from "../UrlContext";
import type { LinkType } from "@weer/common";
import dom from "../lib/dom";
import lib from "../lib";

interface LinkShow {
  urlId?: string | null;
  realUrl: string;
  shortenedUrlCode: string;
  domain: string;
  type: LinkType;
  expiresAt?: string | null;
  onList: boolean;
  onDelete?: (id: string) => void; // when the link is deleted
}

export default (({
  urlId = null,
  realUrl,
  expiresAt,
  shortenedUrlCode,
  domain,
  onList,
  type,
  onDelete,
}: LinkShow) => {
  const [copyTooltipText, setCopyTooltipText] = useState<string>("Copy");
  const { openModal } = useModal();
  const { username } = useAuth();
  const { changeType, updateRealUrl } = useUrl();

  const [timeLeft, setTimeLeft] = useState("");

  let shortenedUrl = `${domain}/${shortenedUrlCode}`;

  if (type === "affix" && username) {
    shortenedUrl = `${domain}/${username}/${shortenedUrlCode}`;
  }

  useEffect(() => {
    if (type === "ultra" || type === "digit") {
      if (!expiresAt) return setTimeLeft("expired");
      const expiresAtDate = new Date(expiresAt || "");

      const update = () => {
        const diff = expiresAtDate.getTime() - Date.now();
        if (diff <= 0) {
          setTimeLeft("expired");
        } else {
          const m = Math.floor(diff / 1000 / 60);
          const s = Math.floor((diff / 1000) % 60);
          setTimeLeft(`${m}m ${s}s`);
        }
      };

      update();
      const timer = setInterval(update, 1000);
      return () => clearInterval(timer);
    } else {
      setTimeLeft("");
    }
  }, [type, shortenedUrlCode, expiresAt, realUrl]);

  // Decide whether to show the link component or not
  let linkClassName = realUrl ? "link" : "link display-none";
  linkClassName = onList ? linkClassName + " link--on-list" : linkClassName;

  // If on list show the delete button
  let deleteButton;

  if (onList) {
    deleteButton = (
      <div className="link__delete">
        <ButtonIcon
          color="red"
          icon="fa-solid fa-trash-can"
          tooltipText="Delete Link"
          onClick={() => {
            openModal("confirmDelete", { urlId, realUrl, onSuccess: onDelete });
          }}
        />
      </div>
    );
  }

  return (
    <div className={linkClassName}>
      <div className="link__real">
        <div className="tooltip tooltip-top">
          {lib.cutString(realUrl, 28)}
          <div className="tooltip__text">{realUrl}</div>
        </div>
      </div>
      {/* <div className="link__code-actions"> */}

      <div className="link__shortened-link">
        {timeLeft === "expired" ? (
          <span className="link__shortened-link--expired">
            Short link expired.
          </span>
        ) : (
          <a target="_blank" href={shortenedUrl} className="button-text">
            {lib.simplifyUrl(shortenedUrl)}
          </a>
        )}
      </div>
      <div className="link__actions">
        <div
          className={`link__action link__copy ${
            timeLeft === "expired" ? "link__copy--disabled" : ""
          }`}
        >
          <ButtonIcon
            color="default"
            icon="fa-solid fa-copy"
            disabled={timeLeft === "expired" ? true : false}
            tooltipText={copyTooltipText}
            disabledTooltipText="Link has expired and cannot be copied."
            onClick={() => {
              navigator.clipboard?.writeText(shortenedUrl);
              setCopyTooltipText("Copied!");
            }}
            onMouseLeave={() => {
              setCopyTooltipText("Copy");
            }}
          />
        </div>

        <div className="link__action link__views">
          <ButtonIcon
            color="default"
            icon="fa-solid fa-chart-simple"
            tooltipText="View Stats"
            onClick={() => {
              openModal("linkStats", { urlId });
            }}
            onMouseLeave={() => {}}
          />
        </div>

        <div className="link__action link__qrcode">
          <ButtonIcon
            color="default"
            icon="fa-solid fa-qrcode"
            tooltipText="Get a QR Code"
            onClick={() => {
              openModal("qrCode", { urlId });
            }}
            onMouseLeave={() => {}}
          />
        </div>

        <div className="link__action link__edit">
          <ButtonIcon
            color="default"
            icon="fa-solid fa-pen-to-square"
            tooltipText="Edit Link"
            onClick={() => {
              openModal("editRealUrl", {
                urlId,
                realUrl,
                onSuccess: (newRealUrl: string) => {
                  updateRealUrl(urlId!, newRealUrl);
                },
              });
            }}
            onMouseLeave={() => {}}
          />
        </div>

        <div className="link__action link__customize">
          <ButtonIcon
            color="blue"
            icon="fa-solid fa-gear"
            tooltipText="Customize Your Link"
            onClick={() => {
              openModal("customizeLink", {
                urlId,
                realUrl,
                shortenedUrl,
                shortenedUrlCode,
                expired: timeLeft === "expired",
                type,
                onChangeType: (
                  newType: LinkType,
                  newExpiresAt?: string,
                  newCode?: string
                ) => {
                  changeType(urlId!, newType, newExpiresAt, newCode);

                  const validFor =
                    new Date(newExpiresAt || "").getTime() - Date.now();

                  if (newType === "affix" && username && newCode) {
                    dom.message(
                      `Your link is now ${lib.simplifyUrl(
                        domain + "/" + username + "/" + newCode
                      )}`,
                      "success"
                    );
                    return;
                  }

                  dom.message(
                    `Your link is now ${lib.simplifyUrl(
                      domain + "/" + newCode
                    )} ${
                      validFor
                        ? `and is valid for ${lib.formatDuration(validFor)}.`
                        : ``
                    }`,
                    "success"
                  );
                },
              });
            }}
            onMouseLeave={() => {}}
          />
        </div>

        {deleteButton}
      </div>

      {["ultra", "digit"].includes(type) && (
        <div
          className={`link__message link__message--${
            timeLeft === "expired" ? "red" : "green"
          }`}
        >
          <span>
            {timeLeft === "expired" ? (
              <>
                Link expired. Get a new link by going to the{" "}
                <button
                  onClick={() => {
                    openModal("customizeLink", {
                      urlId,
                      realUrl,
                      shortenedUrl,
                      type,
                    });
                  }}
                  className="button-text button-text-inherit"
                >
                  customization panel
                </button>
                .
              </>
            ) : (
              <>Valid for {timeLeft}</>
            )}
          </span>
        </div>
      )}
    </div>
  );
}) as FC<LinkShow>;

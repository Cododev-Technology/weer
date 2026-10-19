import React, { FC, useEffect, useState } from "react";
import axios from "axios";
import { CREDIT_PACKS } from "@weer/common";
import type { API } from "@weer/common";

import { Modal, Button } from "@weer/reusable";
import { useAuth } from "../../AuthContext";
import lib from "../../lib";

interface CreditsModalProps {
  open: boolean;
  onClose: () => void;
}

const CreditsModal: FC<CreditsModalProps> = (props) => {
  const { linkCredits } = useAuth();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    axios
      .get<API.Payments.StatusResponse>("/payments/status")
      .then(({ data }) => setEnabled(data.enabled))
      .catch(lib.handleErr);
  }, []);

  return (
    <Modal open={props.open} onClose={props.onClose} header="Credits" type="narrow">
      <div className="account-credits">
        <div className="account-credits__header">
          <span className="account-credits__title">Credits Remaining</span>
          <div className="tooltip tooltip-left">
            <i className="fa-regular fa-circle-question"></i>
            <div className="tooltip__text">
              Credits are used whenever you shorten a link or edit it. They never expire.
            </div>
          </div>
        </div>
        <div className="account-credits__count">{linkCredits}</div>
      </div>

      <div className="credit-packs">
        <span className="credit-packs__title">Buy more credits</span>
        <div className="credit-packs__list">
          {CREDIT_PACKS.map((pack) => (
            <div className="credit-packs__pack" key={pack.credits}>
              <div className="credit-packs__amount">
                <span className="credit-packs__credits">{pack.credits.toLocaleString("en-US")}</span>
                <span className="credit-packs__label">credits</span>
                <span className="credit-packs__per">{pack.linksPerDollar} links per $1</span>
              </div>
              <Button
                color="blue"
                size="small"
                disabled={!enabled}
                onClick={() => window.location.assign(`/checkout?credits=${pack.credits}`)}
              >
                {enabled ? `$${pack.price}` : "Available soon"}
              </Button>
            </div>
          ))}
        </div>
        <p className="credit-packs__note">
          Credits never expire. Prices in USD, taxes calculated at checkout.
        </p>
      </div>
    </Modal>
  );
};

export default CreditsModal;

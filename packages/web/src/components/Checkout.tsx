import React, { FC, useEffect, useRef, useState } from "react";
import axios from "axios";
import { initializePaddle } from "@paddle/paddle-js";
import type { CheckoutEventsData } from "@paddle/paddle-js";
import { CREDIT_PACKS } from "@weer/common";
import type { API, CreditPack } from "@weer/common";

import { Button } from "@weer/reusable";
import { useAuth } from "../AuthContext";
import { useModal } from "../ModalContext";
import lib from "../lib";

const formatMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const Checkout: FC = () => {
  const { loading, isSignedIn, refreshAuth } = useAuth();
  const { openModal } = useModal();

  const credits = Number(new URLSearchParams(window.location.search).get("credits"));
  const [pack, setPack] = useState<CreditPack | null>(null);
  const [packMissing, setPackMissing] = useState(false);
  const [checkoutData, setCheckoutData] = useState<CheckoutEventsData | null>(null);
  const [status, setStatus] = useState<"loading" | "open" | "confirming" | "done" | "error">(
    "loading"
  );
  const [linkCredits, setLinkCredits] = useState<number | null>(null);
  const started = useRef(false);

  useEffect(() => {
    axios
      .get<API.Payments.StatusResponse>("/payments/status")
      .then(({ data }) => {
        const found = CREDIT_PACKS.find((p) => p.credits === credits);
        if (found && data.enabled) setPack(found);
        else setPackMissing(true);
      })
      .catch(lib.handleErr);
  }, []);

  // The payment can take a few seconds to go through after the checkout completes
  const confirm = async (transactionId: string) => {
    setStatus("confirming");

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const { data } = await axios.post<API.Payments.ConfirmResponse>("/payments/confirm", {
          transactionId,
        } as API.Payments.ConfirmBody);
        setLinkCredits(data.linkCredits);
        break;
      } catch (error: any) {
        if (error.response?.status !== 409) {
          lib.handleErr(error);
          break;
        }
        await wait(2000);
      }
    }

    setStatus("done");
    refreshAuth();
  };

  useEffect(() => {
    if (loading || !isSignedIn || !pack || started.current) return;
    started.current = true;

    (async () => {
      try {
        const { data } = await axios.post<API.Payments.CheckoutResponse>("/payments/checkout", {
          credits: pack.credits,
        } as API.Payments.CheckoutBody);

        const paddle = await initializePaddle({
          token: data.clientToken,
          environment: data.environment,
          eventCallback: (event) => {
            if (event.data) setCheckoutData(event.data);
            if (event.name === "checkout.completed") confirm(data.transactionId);
          },
          checkout: {
            settings: {
              displayMode: "inline",
              variant: "one-page",
              frameTarget: "checkout__frame",
              frameInitialHeight: 450,
              frameStyle: "width: 100%; min-width: 312px; background-color: transparent; border: none;",
              allowLogout: false,
            },
          },
        });

        paddle?.Checkout.open({
          transactionId: data.transactionId,
          ...(data.email && { customer: { email: data.email } }),
        });
        setStatus("open");
      } catch (error) {
        lib.handleErr(error);
        setStatus("error");
      }
    })();
  }, [loading, isSignedIn, pack]);

  const totals = checkoutData?.totals;
  const currency = checkoutData?.currency_code ?? "USD";

  const renderPayment = () => {
    if (packMissing) {
      return (
        <div className="checkout__message">
          <p>This credit pack isn't available.</p>
          <a href="/pricing">See the credit packs</a>
        </div>
      );
    }

    if (!loading && !isSignedIn) {
      return (
        <div className="checkout__message">
          <p>Log in to buy credits for your account.</p>
          <Button color="blue" onClick={() => openModal("login")}>
            Login
          </Button>
        </div>
      );
    }

    if (status === "confirming") {
      return (
        <div className="checkout__message">
          <p>Adding your credits...</p>
        </div>
      );
    }

    if (status === "done") {
      return (
        <div className="checkout__message">
          <i className="fa-solid fa-circle-check checkout__success-icon"></i>
          <p>
            Thank you! {pack?.credits.toLocaleString("en-US")} credits were added to your account.
            {linkCredits !== null && ` You now have ${linkCredits.toLocaleString("en-US")}.`}
          </p>
          <a href="/">Back to Weer</a>
        </div>
      );
    }

    return <div className="checkout__frame"></div>;
  };

  return (
    <div className="checkout">
      <div className="checkout__summary">
        <a href="/" className="checkout__back">
          <i className="fa-solid fa-arrow-left"></i> Back to Weer
        </a>

        {pack && (
          <div className="checkout__summary-inner">
            <div className="checkout__box">
              <div className="checkout__price">
                {totals ? formatMoney(totals.total, currency) : `$${pack.price}`}
                <span className="checkout__price-note">{totals?.tax ? "incl. tax" : "+ tax"}</span>
              </div>
              <div className="checkout__item">{pack.credits.toLocaleString("en-US")} credits</div>
              <div className="checkout__item-note">One-time payment. Credits never expire.</div>
            </div>

            <div className="checkout__box">
              <div className="checkout__row">
                <span>Subtotal</span>
                <span>{totals ? formatMoney(totals.subtotal, currency) : `$${pack.price}`}</span>
              </div>
              <div className="checkout__row">
                <span>Tax</span>
                <span>{totals ? formatMoney(totals.tax, currency) : "Calculated at checkout"}</span>
              </div>
              <div className="checkout__row checkout__row--total">
                <span>Total</span>
                <span>{totals ? formatMoney(totals.total, currency) : "-"}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="checkout__payment">{renderPayment()}</div>
    </div>
  );
};

export default Checkout;

import React, { FC } from "react";
import { CREDIT_PACKS } from "@weer/common";

// The cards of the /pricing page
const PricingCards: FC = () => (
  <>
    {CREDIT_PACKS.map((pack) => (
      <div
        key={pack.credits}
        className={"pricing__pack" + (pack.featured ? " pricing__pack--featured" : "")}
      >
        {pack.featured && <span className="pricing__ribbon">Most popular</span>}
        <span className="pricing__credits">{pack.credits.toLocaleString("en-US")}</span>
        <span className="pricing__label">credits</span>
        <span className="pricing__price">${pack.price}</span>
        <span className="pricing__per">{pack.linksPerDollar} links per $1</span>
        <a
          href={`/checkout?credits=${pack.credits}`}
          className={
            "button button-block " + (pack.featured ? "button-blue" : "button-blue-outlined")
          }
        >
          Buy
        </a>
      </div>
    ))}
  </>
);

export default PricingCards;

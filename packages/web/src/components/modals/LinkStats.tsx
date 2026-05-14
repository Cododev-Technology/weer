import React, { FC, useEffect, useState } from "react";
import axios from "axios";
import type { API } from "@weer/common";

import { Modal, Loading } from "@weer/reusable";
import lib from "../../lib";

interface LinkStatsProps {
  open: boolean;
  onClose: () => void;
  urlId: string | null;
}

const LinkStats: FC<LinkStatsProps> = (props) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [stats, setStats] = useState<API.Url.Stats | null>(null);

  useEffect(() => {
    if (!props.open || !props.urlId) return;

    setLoading(true);
    setStats(null);

    axios
      .get<API.Url.Stats>(`/url/${props.urlId}/stats`)
      .then((res) => {
        setStats(res.data);
      })
      .catch((e) => {
        lib.handleErr(e);
        props.onClose();
      })
      .finally(() => {
        setLoading(false);
      });
  }, [props.open, props.urlId]);

  const formatDate = (raw: string | null) => {
    if (!raw) return "—";
    return new Date(raw).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <Modal
      header="Link Stats"
      open={props.open}
      onClose={props.onClose}
      type="narrow"
    >
      {loading ? (
        <Loading center color="default" />
      ) : (
        <>
          <div className="link-stats">
            <div className="link-stats__card">
              <span className="link-stats__value">{stats?.total ?? 0}</span>
              <span className="link-stats__label">Total Clicks</span>
            </div>
            <div className="link-stats__card">
              <span className="link-stats__value">
                {stats?.unique_visitors ?? 0}
              </span>
              <span className="link-stats__label">Unique Visitors</span>
            </div>
            <div className="link-stats__card">
              <span className="link-stats__value">{stats?.qr_clicks ?? 0}</span>
              <span className="link-stats__label">QR Views</span>
            </div>
            <div className="link-stats__card">
              <span className="link-stats__value">
                {formatDate(stats?.last_clicked ?? null)}
              </span>
              <span className="link-stats__label">Last Clicked</span>
            </div>
          </div>

          <div className="u-italic u-flex-text-center u-margin-top-2">
            More advanced analytics coming soon!
          </div>
        </>
      )}
    </Modal>
  );
};

export default LinkStats;

import React, { FC, useEffect, useState } from "react";
import axios from "axios";
import type { API } from "@weer/common";

import { Modal, Loading, Button } from "@weer/reusable";
import lib from "../../lib";
import {
  timeZone,
  formatNumber,
  formatPercent,
  timeAgo,
  formatDateTime,
  countryName,
  countryFlag,
} from "../../lib/stats";
import ClicksChart from "../stats/ClicksChart";
import TopList from "../stats/TopList";
import ShareBar from "../stats/ShareBar";

interface LinkStatsProps {
  open: boolean;
  onClose: () => void;
  urlId: string | null;
  shortenedUrl?: string;
}

const RANGES: { value: API.Url.AnalyticsRange; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

const EXPORT_FORMATS: { value: NonNullable<API.Url.ExportQuery["format"]>; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "sql", label: "SQL" },
];

const LinkStats: FC<LinkStatsProps> = (props) => {
  const [range, setRange] = useState<API.Url.AnalyticsRange>("30d");
  const [loading, setLoading] = useState<boolean>(true);
  const [stats, setStats] = useState<API.Url.Analytics | null>(null);

  const tz = timeZone();

  useEffect(() => {
    if (!props.open || !props.urlId) return;

    // The answer of a range that was left before it came is dropped
    let current = true;
    setLoading(true);

    axios
      .get<API.Url.Analytics>(`/url/${props.urlId}/analytics`, { params: { range, tz } })
      .then((res) => {
        if (current) setStats(res.data);
      })
      .catch((e) => {
        if (!current) return;
        lib.handleErr(e);
        props.onClose();
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [props.open, props.urlId, range]);

  const exportUrl = (format: string) =>
    `/url/${props.urlId}/views/export?` + new URLSearchParams({ format, range, tz }).toString();

  // (text: a value in words, like "3 hours ago", which is smaller and can wrap)
  const renderTile = (label: string, value: string, detail?: string, title?: string, text?: boolean) => (
    <div className="link-stats__tile" title={title}>
      <span className="link-stats__tile-label">{label}</span>
      <span className={"link-stats__tile-value" + (text ? " link-stats__tile-value--text" : "")}>
        {value}
      </span>
      {detail && <span className="link-stats__tile-detail">{detail}</span>}
    </div>
  );

  return (
    <Modal header="Link Stats" open={props.open} onClose={props.onClose} type="wide">
      {!stats ? (
        <Loading center color="default" />
      ) : (
        // While another range loads, the last one stays, dimmed
        <div className={"link-stats" + (loading ? " link-stats--loading" : "")}>
          {props.shortenedUrl && (
            <div className="link-stats__link">{props.shortenedUrl.replace(/^https?:\/\//, "")}</div>
          )}

          <div className="link-stats__toolbar">
            <div className="link-stats__ranges" role="group" aria-label="Time range">
              {RANGES.map((option) => (
                <Button
                  key={option.value}
                  size="small"
                  color={option.value === range ? "blue" : "default"}
                  outlined={option.value !== range}
                  onClick={() => setRange(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>

            <div className="link-stats__export" role="group" aria-label="Export the views">
              <span className="link-stats__export-label">
                <i className="fa-solid fa-download" aria-hidden="true" /> Export
              </span>
              {EXPORT_FORMATS.map((format) => (
                <a
                  key={format.value}
                  className="button button-small button-default-outlined"
                  href={exportUrl(format.value)}
                  title={`Download the views of this time range as ${format.label}, without IP addresses`}
                  download
                >
                  {format.label}
                </a>
              ))}
            </div>
          </div>

          <div className="link-stats__tiles">
            {renderTile("Clicks", formatNumber(stats.clicks))}
            {renderTile(
              "Unique visitors",
              formatNumber(stats.unique_visitors),
              undefined,
              "Each visitor counts once, known by their IP address, browser and language"
            )}
            {renderTile(
              "QR scans",
              formatNumber(stats.qr_scans),
              stats.clicks ? `${formatPercent(stats.qr_scans, stats.clicks)} of clicks` : undefined
            )}
            {renderTile(
              "Last click",
              stats.last_clicked ? timeAgo(stats.last_clicked) : "—",
              undefined,
              stats.last_clicked ? formatDateTime(stats.last_clicked) : undefined,
              true
            )}
          </div>

          {stats.bot_hits > 0 && (
            <div className="link-stats__note">
              <i className="fa-solid fa-robot" aria-hidden="true" />
              {formatNumber(stats.bot_hits)} {stats.bot_hits === 1 ? "hit" : "hits"} by bots and
              link previews (like Slack or WhatsApp) aren't counted.
            </div>
          )}

          <section className="stats-card">
            <h4 className="stats-card__title">Clicks over time</h4>
            <ClicksChart timeline={stats.timeline} interval={stats.interval} />
          </section>

          <div className="link-stats__grid">
            <TopList
              title="Top countries"
              total={stats.clicks}
              items={stats.countries.map((country) => ({
                key: country.code ?? "unknown",
                label: country.code ? countryName(country.code) : "Unknown",
                icon: country.code
                  ? { emoji: countryFlag(country.code) }
                  : { className: "fa-solid fa-globe" },
                value: country.clicks,
              }))}
              footer={
                <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
                  IP Geolocation by DB-IP
                </a>
              }
            />

            <TopList
              title="Top referrers"
              total={stats.clicks}
              items={stats.referrers.map((referrer) => ({
                key: referrer.domain ?? "direct",
                label: referrer.domain ?? "Direct or unknown",
                icon: { className: referrer.domain ? "fa-solid fa-globe" : "fa-solid fa-link" },
                value: referrer.clicks,
              }))}
            />
          </div>

          <section className="stats-card">
            <h4 className="stats-card__title">Devices and sources</h4>
            <div className="link-stats__shares">
              <ShareBar
                label="Device"
                parts={[
                  { key: "mobile", label: "Mobile", icon: "fa-solid fa-mobile-screen", value: stats.devices.mobile, series: 1 },
                  { key: "desktop", label: "Desktop", icon: "fa-solid fa-desktop", value: stats.devices.desktop, series: 2 },
                  { key: "tablet", label: "Tablet", icon: "fa-solid fa-tablet-screen-button", value: stats.devices.tablet, series: 3 },
                ]}
              />
              <ShareBar
                label="Opened through"
                parts={[
                  { key: "link", label: "Short link", icon: "fa-solid fa-link", value: stats.clicks - stats.qr_scans, series: 1 },
                  { key: "qr", label: "QR code", icon: "fa-solid fa-qrcode", value: stats.qr_scans, series: 2 },
                ]}
              />
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
};

export default LinkStats;

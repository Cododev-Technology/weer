import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import moxios from "moxios";

import LinkStats from "../modals/LinkStats";

const stats = (range) => ({
  range,
  interval: "day",
  clicks: 1284,
  unique_visitors: 931,
  qr_scans: 120,
  bot_hits: 7,
  last_clicked: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  timeline: [
    { start: "2026-10-18T00:00", clicks: 4 },
    { start: "2026-10-19T00:00", clicks: 9 },
  ],
  countries: [
    { code: "DE", clicks: 800 },
    { code: null, clicks: 12 },
  ],
  referrers: [
    { domain: "google.com", clicks: 500 },
    { domain: null, clicks: 300 },
  ],
  devices: { mobile: 900, tablet: 84, desktop: 300 },
});

// The modals go into #modal-root (see Modal.tsx in reusable)
beforeEach(() => {
  const root = document.createElement("div");
  root.id = "modal-root";
  document.body.appendChild(root);
  moxios.install();
});

afterEach(() => {
  moxios.uninstall();
  document.body.innerHTML = "";
});

const lastRequest = () => moxios.requests.mostRecent();

const respond = async (response) => {
  await waitFor(() => expect(lastRequest()).toBeTruthy());
  await act(() => lastRequest().respondWith({ status: 200, response }));
};

describe("the stats of a link", () => {
  it("shows the numbers, the top lists and the export of the range", async () => {
    render(<LinkStats open urlId="5" shortenedUrl="https://weer.pro/abc" onClose={() => {}} />);

    await respond(stats("30d"));

    expect(lastRequest().config.url).toBe("/url/5/analytics");
    expect(lastRequest().config.params.range).toBe("30d");
    expect(lastRequest().config.params.tz).toBeTruthy();

    await waitFor(() => expect(screen.getByText("1,284")).toBeInTheDocument());
    expect(screen.getByText("weer.pro/abc")).toBeInTheDocument();
    expect(screen.getByText("931")).toBeInTheDocument();
    expect(screen.getByText("9% of clicks")).toBeInTheDocument();
    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
    expect(screen.getByText(/7 hits by bots and link previews/)).toBeInTheDocument();

    expect(screen.getByText("Germany")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("google.com")).toBeInTheDocument();
    expect(screen.getByText("Direct or unknown")).toBeInTheDocument();
    expect(screen.getByText("IP Geolocation by DB-IP")).toHaveAttribute("href", "https://db-ip.com");

    const csv = screen.getByText("CSV").getAttribute("href");
    expect(csv).toMatch(/^\/url\/5\/views\/export\?format=csv&range=30d&tz=/);
    expect(screen.getByText("SQL").getAttribute("href")).toMatch(/format=sql&range=30d/);
  });

  it("loads another range when it's picked", async () => {
    render(<LinkStats open urlId="5" onClose={() => {}} />);
    await respond(stats("30d"));
    await waitFor(() => expect(screen.getByText("7 days")).toBeInTheDocument());

    fireEvent.click(screen.getByText("7 days"));

    await waitFor(() => expect(lastRequest().config.params.range).toBe("7d"));
    await respond(stats("7d"));
    await waitFor(() =>
      expect(screen.getByText("JSON").getAttribute("href")).toMatch(/format=json&range=7d/)
    );
  });

  it("shows when a range has no clicks yet", async () => {
    render(<LinkStats open urlId="5" onClose={() => {}} />);

    await respond({
      ...stats("30d"),
      clicks: 0,
      unique_visitors: 0,
      qr_scans: 0,
      bot_hits: 0,
      last_clicked: null,
      timeline: [{ start: "2026-10-19T00:00", clicks: 0 }],
      countries: [],
      referrers: [],
      devices: { mobile: 0, tablet: 0, desktop: 0 },
    });

    await waitFor(() =>
      expect(screen.getByText("No clicks in this time range yet.")).toBeInTheDocument()
    );
    expect(screen.getAllByText("Nothing yet in this time range.")).toHaveLength(2);
    expect(screen.queryByText(/bots and link previews/)).not.toBeInTheDocument();
  });
});

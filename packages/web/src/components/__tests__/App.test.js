import { render, screen, waitFor } from "@testing-library/react";
import moxios from "moxios";

import App from "../App";

afterEach(() => {
  moxios.uninstall();
});

describe("when user is signed out", () => {
  beforeEach(() => {
    moxios.install();
    moxios.stubRequest("/auth/status", {
      status: 200,
      response: { isSignedIn: false },
    });
  });

  it("shows the login button and url shortener box", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("url-shortener")).toBeInTheDocument();
      expect(screen.getByText("Login")).toBeInTheDocument();
    });
  });
});

describe("when user is signed in", () => {
  beforeEach(() => {
    moxios.install();
    moxios.stubRequest("/auth/status", {
      status: 200,
      response: {
        isSignedIn: true,
        email: "email@company.com",
      },
    });
  });

  it("shows a list of urls and url shortener box", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("url-shortener")).toBeInTheDocument();
      expect(screen.getByTestId("urls")).toBeInTheDocument();
    });
  });
});

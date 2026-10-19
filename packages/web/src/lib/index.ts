import dom from "./dom";

function validURL(str: string): boolean {
  // No white space or control characters, and http://, https:// or ftp:// at the start
  if (
    /[\s\u0000-\u001f\u007f-\u009f]/.test(str) ||
    !/^(?:https?|ftp):\/\//i.test(str)
  ) {
    return false;
  }

  let hostname: string;
  try {
    hostname = new URL(str).hostname;
  } catch {
    return false;
  }

  // An IP address, but not one of a private network or of this machine
  if (/^[\d.]+$/.test(hostname)) {
    const [first, second, , last] = hostname.split(".").map(Number);
    return (
      first >= 1 &&
      first <= 223 &&
      last >= 1 &&
      last <= 254 &&
      first !== 10 &&
      first !== 127 &&
      !(first === 169 && second === 254) &&
      !(first === 192 && second === 168) &&
      !(first === 172 && second >= 16 && second <= 31)
    );
  }

  // A domain: letters, digits and hyphens between its dots, and a TLD at the end
  // (a TLD that is not in English is written as xn--..., like xn--p1ai for рф)
  return /^(?:[a-z0-9]+(?:-+[a-z0-9]+)*\.)+(?:xn--[a-z0-9-]*[a-z0-9]|[a-z]{2,})$/.test(
    hostname
  );
}

// Handle errors from axios requests
function handleErr(error: any) {
  console.error(error);
  if (error.response && error.response.data && error.response.data.error) {
    dom.message(error.response.data.error, "error");
  } else {
    // show an error message to user on unexpected errors
    dom.message(
      "Sorry, an unknown error occurred, please try again later.",
      "error"
    );
  }
}

function ensureProtocol(url: string): string {
  if (!url.match(/^[a-zA-Z]+:\/\//)) return "https://" + url;
  return url;
}

function cutString(string: string, maxLength: number): string {
  if (string.length > maxLength) return string.substring(0, maxLength) + "...";
  return string;
}

// Google's sign-in always comes back to the home page, so the page it was started from (like
// /checkout) is kept here to go back to
function rememberPageForLogin(): void {
  if (window.location.pathname !== "/") {
    sessionStorage.setItem("afterLogin", window.location.pathname + window.location.search);
  }
}

// Goes back to the page the sign-in was started from. False if there is none.
function returnAfterLogin(): boolean {
  const page = sessionStorage.getItem("afterLogin");
  sessionStorage.removeItem("afterLogin");

  if (!page || window.location.pathname !== "/") return false;
  window.location.replace(page);
  return true;
}

// Remove the http(s):// part from a url
function simplifyUrl(url: string): string {
  return url.replace(/^(?:https?:\/\/)?(?:www\.)?/, "");
}

// Convert date to minutes or hours or days
function formatDuration(time: number | Date): string {
  let milliseconds: number;

  if (typeof time === "number") {
    milliseconds = time;
  } else if (typeof time === "object") {
    // convert date object to milliseconds
    milliseconds = time.getTime() - new Date().getTime();
  } else {
    throw new Error(
      "formatDuration accepts only number (milliseconds) or Date types"
    );
  }

  let durationText = "";
  if (milliseconds < 1000 * 60) {
    durationText = "less than a minute";
  } else if (milliseconds < 1000 * 60 * 60) {
    const minutes = Math.round(milliseconds / (1000 * 60));
    durationText = `${minutes} minute${minutes > 1 ? "s" : ""}`;
  } else if (milliseconds < 1000 * 60 * 60 * 24) {
    const hours = Math.round(milliseconds / (1000 * 60 * 60));
    durationText = `${hours} hour${hours > 1 ? "s" : ""}`;
  } else {
    const days = Math.round(milliseconds / (1000 * 60 * 60 * 24));
    durationText = `${days} day${days > 1 ? "s" : ""}`;
  }

  return durationText;
}

interface Lib {
  validURL: (str: string) => boolean;
  simplifyUrl: (url: string) => string;
  cutString: (string: string, maxLength: number) => string;
  handleErr: (error: any) => void;
  formatDuration: (milliseconds: number | Date) => string;
  ensureProtocol: (url: string) => string;
  rememberPageForLogin: () => void;
  returnAfterLogin: () => boolean;
}

const lib: Lib = {
  validURL,
  handleErr,
  cutString,
  simplifyUrl,
  formatDuration,
  ensureProtocol,
  rememberPageForLogin,
  returnAfterLogin,
};

export default lib;

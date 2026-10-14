import type { LinkType } from "@weer/common";
import {
  CUSTOM_CODE_MIN_LENGTH,
  AFFIX_CODE_MIN_LENGTH,
  CODE_MAX_LENGTH,
} from "@weer/common";

// Static top-level route segments registered in router.ts. A "custom" code or
// a username occupying these would collide with a real route.
export const RESERVED_ROUTE_SEGMENTS = [
  "auth",
  "logout",
  "user",
  "url",
  "qr",
  "q",
  "redirect-warning",
];

/** @TODO maybe send this data to client for the customization model to show the data dynamically */
// This should be our single source of truth for link types and their properties
export const LINKS: Record<LinkType, any> = {
  classic: {
    // name: "6-Character Code",
    // example: "Example: <span>weer.pro/f3hc42</span>",
    // description: `This code contains only lowercase letters and numbers. Don't worry about your audience typing uppercase or lowercase, we'll handle that for you. Great if you just want a shorten link, don't want to worry about your link expiring, selecting anything and even creating an account!`,

    // Total combinations: 34^6  = 1,544,804,416 (around 1.5 billion combinations)
    characters: "abcdefghijkmnpqrstuvwxyz0123456789", // no o or l to avoid confusion
    maxLength: 6,
    minLength: 6,

    requiresAuth: false,
    conversions: {
      // This means convert the 'key' property to the 'value' property when redirecting (e.g. O -> 0, l -> i)
      o: "0",
      l: "i",
    },
    validFor: null, // permanent
  },
  ultra: {
    // name: "Ultra Short Code (1–2 Characters)",
    // example: "Examples: weer.pro/6 or weer.pro/1a",
    // description: `Our magical shortest possible option, perfect for saying it out loud. Imagine you’re on a call, just say “Go to weer.pro/d, it’s my demo link,” and that's it. Keep in mind that your link will be <strong>public</strong> and valid for <strong>only 30 minutes</strong> and after someone else will claim it.`,

    // Total combinations: 34^1 + 34^2 = 1,190 combinations
    characters: "0123456789abcdefghijkmnpqrstuvwxyz", // no o or l to avoid confusion
    maxLength: 2,
    minLength: 1,

    requiresAuth: true,
    conversions: {
      /**
       * Ultra codes do not use o or l, but in case user enters them, we will convert them
       * to 0 and i respectively for better user experience.
       */

      // This means convert the 'key' property to the 'value' property when redirecting (e.g. O -> 0, l -> i)
      o: "0",
      l: "i",
    },
    validFor: 30 * 60 * 1000, // 30 minutes in milliseconds
  },
  digit: {
    // name: "Short Numeric Code (3-5 Digits)",
    // example: "Example: <span>weer.pro/5322</span>",
    // description: `Great if you quickly want to share a link with others during a presentation! Keep in mind that your link will be valid for <strong>only 2 hours</strong> and after someone else might claim it.`,

    // Total combinations: 10^3 + 10^4 + 10^5 = 111,000 combinations
    characters: "0123456789", // no o or l to avoid confusion
    maxLength: 5,
    minLength: 3,

    requiresAuth: false,
    conversions: {
      /**
       * Digit codes do not use any letters, but in case user enters them, we will try convert them
       * to digits for better user experience.
       */

      // This means convert the 'key' property to the 'value' property when redirecting (e.g. O -> 0)
      o: "0",
    },
    validFor: 2 * 60 * 60 * 1000, // 2 hours in milliseconds
  },
  custom: {
    minLength: CUSTOM_CODE_MIN_LENGTH,
    maxLength: CODE_MAX_LENGTH,
    requiresAuth: false,
    reservedWords: RESERVED_ROUTE_SEGMENTS,
  },
  affix: {
    minLength: AFFIX_CODE_MIN_LENGTH,
    maxLength: CODE_MAX_LENGTH,
    requiresAuth: true,
  },
  qr: {
    characterEncoding: "base64url", // using base64url to avoid special characters
    length: 10, // 10 characters long when in base64url (7 bytes)
    size: 7, // 7 bytes = 56 bits of entropy
  },
};

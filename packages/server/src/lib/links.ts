/**
 * In this file, we have define all the link types and their properties to use universally
 * across the app.
 *
 * We also have all the validations, and generation logic based on these properties here.
 */

import { DB } from "../database/index.js";
import type {
  IUrl,
  ISession,
  IUltraCode,
  IDigitCode,
} from "../database/types.js";
import crypto from "crypto";
import { LINKS } from "./link-definitions.js";
import type { LinkType } from "@weer/common";
import { isValidCustomCode, isValidAffixCode } from "@weer/common";

const MAX_ATTEMPTS = 10; // Max number of retries for generating unique IDs (QR Code and Shortened URL id)

// For performance, we pre-build the regex and conversion maps for cleaning up codes for classic, ultra, and digit types
const buildConversion = (
  conversions: Record<string, string>
): [RegExp, Record<string, string>] => [
  new RegExp(`[${Object.keys(conversions).join("")}]`, "g"),
  conversions,
];

const [CLASSIC_RE, CLASSIC_MAP] = buildConversion(LINKS.classic.conversions);
const [ULTRA_RE, ULTRA_MAP] = buildConversion(LINKS.ultra.conversions);
const [DIGIT_RE, DIGIT_MAP] = buildConversion(LINKS.digit.conversions);

/**
 * This function figures out the link type based on the code provided, and then
 * validates it and returns the clean up code.
 *
 * @param code
 * @returns object with type and cleaned code, or null if invalid
 */
export const processCode = (
  code: string,
  username?: string,
  url?: string
): { type: LinkType; code: string } | null => {
  if (username && code.length > 0) {
    // Affix type
    return { type: "affix", code };
  }

  if (url && url.startsWith("/q/")) {
    /** @todo clean up & validate code */
    // QR code type
    return { type: "qr", code };
  }

  // We first check type, then clean up, then validate
  if (isUltraCode(code)) {
    let cleanedCode = cleanUltraCode(code);
    if (!validateUltraCode(cleanedCode)) return null;
    return { type: "ultra", code: cleanedCode };
  } else if (isClassicCode(code)) {
    let cleanedCode = cleanClassicCode(code);
    if (!validateClassicCode(cleanedCode)) return null;
    return { type: "classic", code: cleanedCode };
  } else if (isDigitCode(code)) {
    let cleanedCode = cleanDigitCode(code);
    if (!validateDigitCode(cleanedCode)) return null;
    return { type: "digit", code: cleanedCode };
  } else {
    // Finally, default to custom type
    return { type: "custom", code };
  }
};

// Check if a shortened URL code is an ultra code (before cleaning up)
const isUltraCode = (code: string): boolean => {
  // Check length
  if (
    code.length > LINKS.ultra.maxLength ||
    code.length < LINKS.ultra.minLength
  ) {
    return false;
  }

  return true;
};

// Clean ultra code (make lowercase & replace non-supported characters)
const cleanUltraCode = (code: string): string =>
  code.toLowerCase().replace(ULTRA_RE, (c) => ULTRA_MAP[c]);

// Validate ultra code after running isUltraCode and cleanUltraCode
const validateUltraCode = (code: string): boolean => {
  // Check that it only contains alphabets and digits
  if (!/^[a-z0-9]+$/.test(code)) {
    return false;
  }

  return true;
};

// Check if a shortened URL code is a classic code
const isClassicCode = (code: string): boolean => {
  return code.length === 6;
};

// Clean classic code (e.g. make lowercase)
const cleanClassicCode = (code: string): string =>
  code.toLowerCase().replace(CLASSIC_RE, (c) => CLASSIC_MAP[c]);

// Validate classic code after running isClassicCode and cleanClassicCode
const validateClassicCode = (code: string): boolean => {
  // Check length & that it only contains alphabets and digits
  if (!/^[a-z0-9]+$/.test(code)) {
    return false;
  }

  return true;
};

const isDigitCode = (code: string): boolean => {
  // Check length
  if (
    code.length > LINKS.digit.maxLength ||
    code.length < LINKS.digit.minLength
  ) {
    return false;
  }

  return true;
};

const cleanDigitCode = (code: string): string =>
  code.toLowerCase().replace(DIGIT_RE, (c) => DIGIT_MAP[c]);

// Validate digit code after running isDigitCode and cleanDigitCode
const validateDigitCode = (code: string): boolean => {
  // Check that it only contains digits and letter o
  if (!/^[0-9o]+$/.test(code)) {
    return false;
  }

  return true;
};

export const validateCustomCode = (code: string): boolean => {
  if (!isValidCustomCode(code)) return false;
  if (LINKS.custom.reservedWords.includes(code.toLowerCase())) return false;
  return true;
};

export const validateAffixCode = (code: string): boolean => isValidAffixCode(code);

/**
 * Generates a unique "classic" type shortened URL ID for the given database URL ID.
 * The classic type is a 6-Character Code, only lowercase alphabets and digits, without o or l. In redirecting, o is treated as 0 and l as i.
 *
 * @param id The database URL ID to update with the generated shortened URL ID
 * @returns The generated shortened URL Code
 */
export const generateClassic = async (id: number) => {
  let updated = false;
  let attempts = 0;
  let shortenedCode;

  const possibleChars = LINKS.classic.characters;
  const codeLength = LINKS.classic.maxLength; // For now max and min are the same

  // We will retry updating the record just like before with the QR code id
  while (!updated && attempts <= MAX_ATTEMPTS) {
    // Generate a 6-character code to be used as url shortened id
    const bytes = crypto.randomBytes(codeLength);
    shortenedCode = "";
    for (let i = 0; i < codeLength; i++) {
      shortenedCode += possibleChars[bytes[i] % possibleChars.length];
    }

    try {
      await DB.update<IUrl>(
        "urls",
        {
          shortened_url_id: shortenedCode,
          link_type: "classic",
        },
        `id = $3`,
        [id]
      );
      updated = true; // If update is successful, the ID is unique
      return shortenedCode;
    } catch (error: any) {
      // The official PostgreSQL error code for unique violations
      if (error.code === "23505") {
        // If there's a duplicate key error, generate a new ID and retry
        updated = false;
        attempts++;
      } else {
        throw error;
      }
    }
  }

  // Max attempts reached
  if (!updated) {
    throw new Error(
      `Could not generate a unique shortened URL ID after ${MAX_ATTEMPTS} attempts`
    );
  }
};

/**
 * Generates a unique "ultra" type shortened URL ID for the given database URL ID.
 * The ultra type is a 1 or 2 character code, only lowercase alphabets and digits.
 * Examples: a, b, z, 0, 5, az, 1z, z1, zl
 *
 * @param id The database URL ID to update with the generated shortened URL ID
 * @returns The generated shortened URL Code and its expiration date in an object in a promise
 */
export const generateUltra = async (id: number) => {
  /**
   * Clean up the ultra_code table first:
   * - Set url_id of all records that have expired to NULL.
   * - Set assigned_at and expires_at to NULL for all ultra codes that have url_id NULL (unassigned).
   *   This usually happens when a user deletes an ultra code link before it expires.
   */
  await DB.query(`
      UPDATE ultra_codes
      SET
        url_id = CASE
          WHEN expires_at < NOW() THEN NULL
          ELSE url_id
        END,
        assigned_at = CASE
          WHEN (expires_at < NOW()) OR url_id IS NULL THEN NULL
          ELSE assigned_at
        END,
        expires_at = CASE
          WHEN (expires_at < NOW()) OR url_id IS NULL THEN NULL
          ELSE expires_at
        END;
  `);

  /**
   * Find the first available ultra code. And then update that ultra code to be linked
   * to this url id.
   * We do this atomically to avoid race conditions when many people are hitting this route.
   *
   * 'for update' here means that we are locking the selected row until the transaction is committed.
   * This prevents other transactions from modifying or selecting these rows until we're done with them.
   */
  try {
    const result = await DB.query(
      `
        UPDATE ultra_codes
        SET url_id = $1,
            assigned_at = NOW(),
            expires_at = NOW() + ($2 * INTERVAL '1 millisecond')
        WHERE id = (
          SELECT id FROM ultra_codes
          WHERE url_id IS NULL
          ORDER BY length(code), code
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING url_id, code, expires_at;
      `,
      [id, LINKS.ultra.validFor]
    );

    if (result.length === 0) {
      throw {
        status: 503,
        message:
          "All of our ultra codes are in use right now. Please check back in a few minutes.",
      };
    }

    // Update the URL record to set its link_type
    await DB.update<IUrl>(
      "urls",
      {
        link_type: "ultra",
      },
      `id = $2`,
      [result[0].url_id]
    );

    return { code: result[0].code, expiresAt: result[0].expires_at };
  } catch (error: any) {
    if (error.code === "23505") {
      // If there's a duplicate key error
      throw {
        status: 400,
        message: "You can't have two ultra codes for the same link.",
      };
    }

    throw error;
  }
};

/**
 * Generates a random unique "digit" type shortened URL ID for the given database URL ID.
 * The digit type consists of only digits, with a length between 3 to 5 digits.
 *
 * @param id The database URL ID to update with the generated shortened URL ID (code)
 * @returns The generated shortened URL Code
 */
export const generateDigit = async (id: number) => {
  const generateAndInsertDigitCode = async (codeLength: number) => {
    /** X in the code below refers the codeLength (either 3, 4, or 5) */

    // Check entropy level for X digit codes
    const countXDigits = await DB.query(
      `SELECT COUNT(*) FROM digit_codes WHERE code_length = $1;`,
      [codeLength]
    );
    const usedXDigits = parseInt(countXDigits[0].count, 10);
    const totalXDigits = 10 ** codeLength; // 10^X
    if (usedXDigits / totalXDigits < 1 - ENTROPY_LEVEL) {
      // Now we can generate a new random 3 digit code
      let updated = false;
      let attempts = 0;
      let newCode;

      const possibleChars = LINKS.digit.characters;

      // We will retry updating the record just like before with the QR code id
      while (!updated && attempts <= MAX_ATTEMPTS) {
        // Generate a 3-digit code to be used as url shortened id
        const bytes = crypto.randomBytes(codeLength);
        newCode = "";
        for (let i = 0; i < codeLength; i++) {
          newCode += possibleChars[bytes[i] % possibleChars.length];
        }

        const expiresAt = new Date(Date.now() + LINKS.digit.validFor);

        try {
          await DB.insert<IDigitCode>("digit_codes", {
            url_id: id,
            code: newCode,
            code_length: codeLength,
            expires_at: expiresAt,
            assigned_at: new Date(),
          });

          // Update the URL record to set its link_type
          await DB.update<IUrl>(
            "urls",
            {
              link_type: "digit",
            },
            `id = $2`,
            [id]
          );

          updated = true; // If insert is successful, the ID is unique
          return { code: newCode, expiresAt, url_id: id };
        } catch (error: any) {
          // The official PostgreSQL error code for unique violations
          if (error.code === "23505") {
            // If there's a duplicate key error, generate a new ID and retry
            updated = false;
            attempts++;
          } else {
            throw error;
          }
        }
      }

      // Max attempts reached
      if (!updated) {
        // Instead of throwing error here, we can return false to try next code length
        return false;
      }
    } else {
      // Entropy level not sufficient to try generating new codes of this length
      return false;
    }
  };

  const ENTROPY_LEVEL = 0.3; // at least 30% of codes should be available to try generating new codes of that length

  // For each code, we will only try to generate and insert a new record into the digit_codes table if we have at least 30%
  // of the codes available for that length.
  // For example, for 3 digit codes, there are 1000 combinations (000 to 999).
  // We will only try to generate and insert a new 3 digit code if there are at least 300 codes available (i.e. less than 700 used).
  // This is to avoid too many collisions and retries when the table is almost full for that length.

  // For creating a new digit code:
  // if select count(*) from digit_codes where code_length = 3 satisfies ENTROPY_LEVEL, then we attempt to create a new code.
  // else if select count(*) from digit_codes where code_length = 3 does not satisfy ENTROPY_LEVEL, then we move on to the next length.

  // ------ 1. Trying 3 digit codes first  ------
  const threeDigitResult = await generateAndInsertDigitCode(3);
  if (threeDigitResult) {
    return threeDigitResult;
  } else {
    // ------ 2. Trying 4 digit codes next  ------
    const fourDigitResult = await generateAndInsertDigitCode(4);
    if (fourDigitResult) {
      return fourDigitResult;
    } else {
      // ------ 3. Trying 5 digit codes finally  ------
      const fiveDigitResult = await generateAndInsertDigitCode(5);
      if (fiveDigitResult) {
        return fiveDigitResult;
      } else {
        throw {
          message:
            "No unique digit code is available now, please try again later.",
          status: 503,
        };
      }
    }
  }
};

/**
 * Generates a unique QR Code ID for the given database URL ID.
 * @param id The database URL ID to update with the generated shortened URL ID
 * @returns a promise
 */
export const generateQRCode = async (id: number) => {
  /*                                FOR QR CODE ID:
    7 bytes (56 bits) gives 2^56 = 72,057,594,037,927,936 combination.
    The base65url encoding safely converts binary data into a URL valid string without losing entropy.

    Based on the Birthday Paradox, after generating around 1 billion random codes, there is roughly a 0.999 (99.9%) probability
    that at least one collision will occur somewhere in that entire set.

    This means that out of 1 billion inserts, we should expect only 
    a handful of duplicates (about 7 on average) due to random chance. There is a per-insert 
    collision probability of about 7×10⁻⁹ (0.0000007%).

    This is trivial though but we must still handle collisions in the database (we'll retry on unique constraint violation of Postgres).
  */

  let QRCodeId;
  let updated = false;
  let attempts = 0; // to avoid infinite loops, we will try only 10 times

  while (!updated && attempts < MAX_ATTEMPTS) {
    attempts++;
    QRCodeId = crypto
      .randomBytes(LINKS.qr.size)
      .toString(LINKS.qr.characterEncoding); // base64url encoding

    try {
      await DB.update<IUrl>(
        "urls",
        {
          qr_code_id: QRCodeId,
        },
        `id = $2`,
        [id]
      );
      updated = true; // If update is successful. The ID is unique
    } catch (error: any) {
      // The official PostgreSQL error code for unique violations
      if (error.code === "23505") {
        // If there's a duplicate key error, generate a new ID and retry
        updated = false;
      } else {
        throw error;
      }
    }
  }

  // Max attempts reached
  if (!updated) {
    throw new Error(
      `Could not generate a unique QR code ID after ${MAX_ATTEMPTS} attempts`
    );
  }
};

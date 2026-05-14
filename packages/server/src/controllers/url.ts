import type { CpeakRequest as Request, CpeakResponse as Response } from "cpeak";
import QRCode from "qrcode";
import crypto from "crypto";
import path from "path";
import type { LinkType } from "@weer/common";
import { DB } from "../database/index.js";
import type {
  IUrl,
  ISession,
  IUltraCode,
  IDigitCode,
  IView,
} from "../database/types.js";
import util from "../lib/util.js";
import { push as pushView } from "../redis/views-stream.js";
import keys from "../config/keys.js";
import {
  generateClassic,
  generateUltra,
  generateDigit,
  generateQRCode,
  processCode,
} from "../lib/links.js";

const publicPath = new URL("../../public", import.meta.url).pathname;

// Helper functions to check affix code availability
const isAffixAvailable = async (code: string, userId: string) => {
  const existingCode = await DB.find<IUrl>(
    "SELECT id FROM urls WHERE shortened_url_id=$1 AND link_type='affix' AND user_id = $2",
    [code, userId]
  );

  return existingCode ? false : true;
};

// Helper function to check custom code availability
const isCustomAvailable = async (code: string) => {
  const existingCode = await DB.find<IUrl>(
    "SELECT id FROM urls WHERE shortened_url_id=$1 AND link_type='custom'",
    [code]
  );

  return existingCode ? false : true;
};

// Return the list of urls user has shortened
const getUrls = async (req: Request, res: Response) => {
  let whereClause = "";
  let queryParams: (number | undefined)[] = []; // will be either user id or session id
  let data;

  if (req.user) {
    whereClause = "urls.user_id = $1";
    queryParams = [req.user.id];
  } else if (req.signedCookies?.session_token) {
    const session = await DB.find<ISession>(
      "SELECT id FROM sessions WHERE session_token=$1",
      [req.signedCookies.session_token]
    );

    if (!session?.id) {
      return res.json({ urls: [], domain: keys.domain });
    }

    whereClause = "urls.session_id = $1";
    queryParams = [session.id];
  } else {
    // No user and no session token
    return res.json({ urls: [], domain: keys.domain });
  }

  data = await DB.findMany<IUrl>(
    `
    SELECT
      urls.id,
      urls.real_url,
      urls.link_type,
      COALESCE(ultra_codes.code, urls.shortened_url_id, digit_codes.code) AS code,
      COALESCE(ultra_codes.assigned_at, digit_codes.assigned_at) AS assigned_at,
      COALESCE(ultra_codes.expires_at, digit_codes.expires_at) AS expires_at
    FROM urls
    LEFT JOIN ultra_codes
      ON urls.id = ultra_codes.url_id
      AND urls.link_type = 'ultra'
    LEFT JOIN digit_codes
      ON urls.id = digit_codes.url_id
      AND urls.link_type = 'digit'
    WHERE ${whereClause}
    ORDER BY urls.created_at DESC;
  `,
    queryParams
  );

  // 4. Return the result
  res.json({
    urls: DB.cleanResult(data),
    domain: keys.domain,
  });
};

/** @TODO clean this up */
interface IRequestBody {
  url: string;
  type: LinkType;
  custom?: string; // only if type is custom or customOnUsername
}

// Get the url, shorten it and save to database
const shorten = async (req: Request<IRequestBody>, res: Response) => {
  // Get the user id if the user is logged in
  let userId = req.user ? req.user.id : null;

  // Get the session token for when the user is not logged in
  let sessionToken = req.signedCookies?.session_token || null;

  const realUrl = req.body?.url;

  /* ---------------------------------------------------------------------------------- 
          We will first insert the record and then generate a code for the QR code. 
          Afterwards, we will update that record with the a requested generated code.
     -------------------------------------------------------------------------------- */

  const insertedUrl = await DB.insert<IUrl>("urls", {
    real_url: realUrl,
    user_id: userId ? userId : undefined,
    session_id: !userId
      ? (
          await DB.find<ISession>(
            "SELECT id FROM sessions WHERE session_token=$1",
            [sessionToken]
          )
        )?.id
      : undefined,
  });

  await generateQRCode(insertedUrl!.id);

  /* ---------------------------------------------------------------------------------- 
          At this point we have inserted the record with a unique QR code id. 
          Now we will generate a unique shortened URL id and update the record.
     -------------------------------------------------------------------------------- */

  const type = req.body?.type as LinkType;

  let shortenedCode;
  let expiresAt;

  switch (type) {
    case "classic":
      try {
        shortenedCode = await generateClassic(insertedUrl!.id);
      } catch (error) {
        // Delete the inserted URL record if we could not generate a code
        await DB.delete<IUrl>("urls", `id=$1`, [insertedUrl!.id]);

        throw error;
      }
      break;
    case "ultra":
      if (!req.user) throw { status: 401, message: "Unauthorized" };
      try {
        const obj = await generateUltra(insertedUrl!.id);
        expiresAt = obj.expiresAt;
        shortenedCode = obj.code;
      } catch (error) {
        // Delete the inserted URL record if we could not generate a code
        await DB.delete<IUrl>("urls", `id=$1`, [insertedUrl!.id]);

        throw error;
      }
      break;
    case "digit":
      try {
        const obj = await generateDigit(insertedUrl!.id);
        expiresAt = obj.expiresAt;
        shortenedCode = obj.code;
      } catch (error: any) {
        if (error?.status === 503) {
          // All digit codes exhausted — fall back to classic
          shortenedCode = await generateClassic(insertedUrl!.id);
        } else {
          // Delete the inserted URL record if we could not generate a code
          await DB.delete<IUrl>("urls", `id=$1`, [insertedUrl!.id]);

          throw error;
        }
      }
      break;

    default:
      throw { status: 400, message: "Invalid type" };
  }

  return res.json({
    URLId: insertedUrl!.id,
    realURL: realUrl,
    linkType: type,
    code: shortenedCode,
    expiresAt: expiresAt || null,
  });
};

// Change the type of a url (e.g. from classic to custom). User can do this from the customization modal
const changeUrlType = async (req: Request, res: Response) => {
  const id = Number(req.params?.id);
  const newType = req.body?.type as LinkType;

  if (!id || !newType) {
    return res.status(400).json({ message: "Missing parameters" });
  }

  // ------- 1. Clean up the old code ------- //

  // First find the current url type and release the current code
  const currentLink = await DB.find<IUrl>(
    "SELECT link_type FROM urls WHERE id=$1",
    [id]
  );

  const currentType = currentLink?.link_type;

  if (currentType === "ultra") {
    // set the old ultra code as unassigned
    await DB.update<IUltraCode>(
      "ultra_codes",
      {
        assigned_at: undefined,
        expires_at: undefined,
        url_id: undefined,
      },
      `url_id = $4`,
      [id]
    );
  }

  if (currentType === "digit") {
    // remove the old digit code from database
    await DB.delete<IDigitCode>("digit_codes", `url_id = $1`, [id]);
  }

  if (
    (currentType === "classic" && newType !== "classic") ||
    (currentType === "affix" && newType !== "affix") ||
    (currentType === "custom" && newType !== "custom")
  ) {
    // set shortened_url_id to null
    await DB.update<IUrl>(
      "urls",
      {
        shortened_url_id: undefined,
      },
      `id = $2`,
      [id]
    );
  }

  // ------- 2. Generate new code ------- //

  let newShortenedCode;
  let expiresAt;

  switch (newType) {
    case "classic":
      newShortenedCode = await generateClassic(id);
      break;

    case "ultra":
      if (!req.user) throw { status: 401, message: "Unauthorized" };
      {
        const obj = await generateUltra(id);
        expiresAt = obj.expiresAt;
        newShortenedCode = obj.code;
      }
      break;

    case "digit":
      {
        const obj = await generateDigit(id);
        expiresAt = obj.expiresAt;
        newShortenedCode = obj.code;
      }
      break;

    case "affix": {
      if (!req.user) throw { status: 401, message: "Unauthorized" };
      const affixCode = req.body?.code;
      /** @todo validate the affixCode */

      const available = await isAffixAvailable(affixCode, req.user.id);
      if (!available) {
        throw { status: 400, message: "Code is not available" };
      }

      // Update the url record with the affix code
      await DB.update<IUrl>(
        "urls",
        {
          shortened_url_id: affixCode,
          link_type: "affix",
        },
        `id = $3`,
        [id]
      );

      newShortenedCode = affixCode;
      break;
    }
    case "custom": {
      const customCode = req.body?.code;
      /** @todo validate the customCode */

      const available = await isCustomAvailable(customCode);
      if (!available) {
        throw { status: 400, message: "Code is not available" };
      }

      // Update the url record with the custom code
      await DB.update<IUrl>(
        "urls",
        {
          shortened_url_id: customCode,
          link_type: "custom",
        },
        `id = $3`,
        [id]
      );

      newShortenedCode = customCode;
      break;
    }

    default:
      throw { status: 400, message: "Invalid type" };
  }

  const typesWithExpiresAt = ["ultra", "digit"];

  return res.json({
    newType,
    expiresAt: typesWithExpiresAt.includes(newType) ? expiresAt : null,
    code: newShortenedCode,
  });
};

/** @TODO FIX ERROR RETURN IN CPEAK SEND FILE */
// Redirect to the real url
const redirect = async (req: Request, res: Response) => {
  const code = req.params?.id;

  if (!code) {
    throw new Error("No URL ID provided");
  }

  const processedCode = processCode(code, req.params?.username, req.url);

  if (!processedCode) {
    return res.sendFile(path.join(publicPath, "./no-url.html"), "text/html");
  }

  let url;

  switch (processedCode.type) {
    case "ultra":
      url = await DB.find<IUrl>(
        `
        SELECT urls.real_url, urls.id, urls.link_type
        FROM urls
        JOIN ultra_codes
          ON urls.id = ultra_codes.url_id
        WHERE ultra_codes.code = $1
      `,
        [processedCode.code]
      );

      break;
    case "classic":
      url = await DB.find<IUrl>(
        `SELECT real_url, id, link_type FROM urls WHERE shortened_url_id=$1`,
        [processedCode.code]
      );
      break;
    case "digit":
      url = await DB.find<IUrl>(
        `
        SELECT urls.real_url, urls.id, urls.link_type
        FROM urls
        JOIN digit_codes
          ON urls.id = digit_codes.url_id
        WHERE digit_codes.code = $1
      `,
        [processedCode.code]
      );
      break;
    case "affix":
      const username = req.params?.username;

      if (!username) {
        return res.sendFile(
          path.join(publicPath, "./no-url.html"),
          "text/html"
        );
      }

      url = await DB.find<IUrl>(
        `
        SELECT urls.real_url, urls.id, urls.link_type
        FROM urls
        JOIN users
          ON urls.user_id = users.id
        JOIN usernames
          ON users.id = usernames.user_id
        WHERE urls.shortened_url_id = $1
          AND usernames.username = $2
      `,
        [processedCode.code, username]
      );

      break;

    case "qr":
      url = await DB.find<IUrl>(
        `SELECT real_url, id FROM urls WHERE qr_code_id=$1`,
        [processedCode.code]
      );
      break;

    case "custom":
      url = await DB.find<IUrl>(
        `SELECT real_url, id, link_type FROM urls WHERE shortened_url_id=$1`,
        [processedCode.code]
      );
      break;
  }

  if (!url) {
    return res.sendFile(path.join(publicPath, "./no-url.html"), "text/html");
  }

  /** Handling the views logic */

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const userAgent = req.headers["user-agent"] || "";
  const acceptLang = req.headers["accept-language"] || "";
  const referrer = req.headers["referer"] || "";

  const fingerprintSource = `${ip}::${userAgent}::${acceptLang}`;
  const visitorHash = crypto
    .createHash("sha256")
    .update(fingerprintSource)
    .digest("hex");

  const viewData = {
    url_id: url.id,

    // For now, due to legal reasons, we won't save the ip address until we have a proper privacy policy in place.
    // ip_address: ip ? ip.toString() : undefined,

    user_agent: userAgent,
    referrer: referrer,
    link_type: processedCode.type !== "qr" ? url.link_type : undefined,
    via_qr: processedCode.type === "qr" ? true : false,
    visitor_hash: visitorHash,
  };

  if (keys.redisEnabled) {
    // Save the view with the hash to redis stream. The janitor will drain the stream every second and save to database in batches.
    // This is to handle high traffic and avoid database overload during peak times.
    pushView(viewData);
  } else {
    // We have this in case we want to run the server without Redis, but it should not be the default in production because it can cause performance issues.
    await DB.insert<IView>("views", viewData);
  }

  res.redirect(url.real_url);
};

// Delete a url record
const remove = async (req: Request, res: Response) => {
  await DB.delete<IUrl>("urls", `id=$1`, [req.params?.id]);
  res.json({ message: "deleted" });
};

// Generates and sends a QR code
const sendQrCode = async (req: Request, res: Response) => {
  const QR_CODE_VERSION = 4; // 33x33 matrix, 50 chars max
  const QR_CODE_ERROR_CORRECTION_LEVEL = "H"; // L, M, Q, H (L lowest, H highest)

  if (!req.params?.id) {
    throw { status: 400, message: "No URL ID provided" };
  }

  const download = req.query.download === "true" ? true : false;
  const type = req.query.type === "png" ? "png" : "svg";
  let size = Number(req.query.size); // only for png, valid options are: 256, 512, 1024, 2048

  // Validate size if type is png
  if (type === "png") {
    const validSizes = [256, 512, 1024, 2048];
    if (!validSizes.includes(size)) {
      size = 512; // default size
    }
  }

  const url = await DB.find<IUrl>(`SELECT qr_code_id FROM urls WHERE id=$1`, [
    req.params.id,
  ]);

  if (!url) {
    throw { status: 404, message: "URL not found" };
  }

  const data = `${keys.domain}/q/${url.qr_code_id}`;

  // This header is needed to trigger a browser download
  if (download) {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${url.qr_code_id}.${type}"`
    );
  }

  if (type === "svg") {
    const svg = await QRCode.toString(data, {
      type: "svg",
      version: QR_CODE_VERSION,
      margin: 0.5,

      errorCorrectionLevel: QR_CODE_ERROR_CORRECTION_LEVEL,
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.end(svg);
  } else {
    res.setHeader("Content-Type", "image/png");

    await QRCode.toFileStream(res, data, {
      version: QR_CODE_VERSION,
      margin: 0.5,
      errorCorrectionLevel: QR_CODE_ERROR_CORRECTION_LEVEL,
      width: size,
    });
  }
};

// Check to see if an affix code is available
const checkAffixAvailability = async (req: Request, res: Response) => {
  const code = req.params?.code;
  const userId = req.user?.id;

  if (!code) {
    return res.status(400).json({ message: "No code provided" });
  }

  // Check if user has already used this code, that's the only check required

  const available = await isAffixAvailable(code, userId);
  res.json({ available });
};

// Check to see if a custom  code is available
const checkCustomAvailability = async (req: Request, res: Response) => {
  const code = req.params?.code;

  if (!code) {
    return res.status(400).json({ message: "No code provided" });
  }

  const available = await isCustomAvailable(code);
  res.json({ available });
};

// Update the destination URL of an existing shortened link
const updateRealUrl = async (req: Request, res: Response) => {
  const id = Number(req.params?.id);
  const newRealUrl = req.body?.url;

  if (!id || !newRealUrl) {
    throw { status: 400, message: "Missing parameters" };
  }

  await DB.update<IUrl>("urls", { real_url: newRealUrl }, `id = $2`, [id]);

  return res.json({ realUrl: newRealUrl });
};

export default {
  getUrls,
  shorten,
  redirect,
  remove,
  sendQrCode,
  changeUrlType,
  checkAffixAvailability,
  checkCustomAvailability,
  updateRealUrl,
};

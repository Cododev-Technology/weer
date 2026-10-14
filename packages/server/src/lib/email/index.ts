import path from "path";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { render } from "cpeak";
import keys from "../../config/keys.js";

const ses = new SESClient({ region: keys.sesRegion });

const TEMPLATES_DIR = path.join(path.resolve(), "src/lib/email/templates");

type HtmlTemplate = { htmlFile: string; templateData: Record<string, unknown> };

// Sends an HTML email via SES. Pass a raw HTML string or a { htmlFile, templateData }
// object to render a template from './templates' using cpeak's render.string.
const sendEmail = async (
  to: string,
  subject: string,
  html: string | HtmlTemplate
) => {
  if (process.env.SKIP_EMAIL === "true") return;

  const htmlStr =
    typeof html === "string"
      ? html
      : await render.string(
          `${TEMPLATES_DIR}/${html.htmlFile}.html`,
          html.templateData
        );

  await ses.send(
    new SendEmailCommand({
      Source: keys.sesFromEmail,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: htmlStr } },
      },
    })
  );
};

export default sendEmail;

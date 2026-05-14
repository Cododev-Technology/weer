import React, { FC, useEffect, useState } from "react";

import { Modal, Select } from "@weer/reusable";

interface QRCodeProps {
  open: boolean;
  onClose: () => void;
  urlId: string | null;
}

const QRCode: FC<QRCodeProps> = (props) => {
  const [format, setFormat] = useState("SVG");
  const [size, setSize] = useState("1024");

  return (
    <Modal
      header="Your QR Code"
      // type="narrow"
      open={props.open}
      onClose={() => {
        props.onClose();
      }}
    >
      <div className="qr-code">
        <img src={`/qr/${props.urlId}`} alt="QR Code" />
      </div>

      <div className="form-group u-margin-top-4">
        <Select
          label="Format"
          help="SVG is recommended for most uses as it can get as large as possible without losing quality. PNG is better for some applications that don't support SVG."
          tooltipPosition="right"
          value={format}
          onChange={(value, text, data) => {
            console.log("Selected:", value, text, data);
            setFormat(value);
          }}
        >
          <option value="SVG">SVG</option>
          <option value="PNG">PNG</option>
        </Select>
      </div>

      {format === "PNG" && (
        <div className="form-group">
          <Select
            label="Size"
            value={size}
            onChange={(value, text, data) => {
              console.log("Selected:", value, text, data);
              setSize(value);
            }}
          >
            <option value="256">256 x 256</option>
            <option value="512">512 x 512</option>
            <option value="1024">1024 x 1024</option>
            <option value="2048">2048 x 2048</option>
          </Select>
        </div>
      )}

      <div className="qr__download u-flex-text-center">
        <a
          href={`/qr/${props.urlId}?type=${
            format.toLowerCase() || "SVG"
          }&download=true${format === "PNG" ? `&size=${size}` : ""}`}
          className="button button-blue button-rounded button-with-icon"
        >
          <i className="fa-solid fa-download"></i> Download {format}
        </a>
      </div>

      <p className="qr__message">
        Your QR Code will be valid permanently and won't change regardless of
        how you customize your shortened link.
      </p>
    </Modal>
  );
};

export default QRCode;

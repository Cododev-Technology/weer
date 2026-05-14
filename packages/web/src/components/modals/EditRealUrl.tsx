import React, { FC, useState } from "react";
import axios from "axios";

import { Modal, Button, Input } from "@weer/reusable";
import dom from "../../lib/dom";
import lib from "../../lib";

interface EditRealUrlProps {
  open: boolean;
  onClose: () => void;
  urlId: string | null;
  realUrl: string;
  onSuccess: (newRealUrl: string) => void;
}

const EditRealUrl: FC<EditRealUrlProps> = (props) => {
  const [value, setValue] = useState<string>(props.realUrl);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const onSubmit = async () => {
    if (!props.urlId) return;

    const newUrl = lib.ensureProtocol(value);

    if (!lib.validURL(newUrl)) {
      setErrorMessage("The URL you put is not valid.");
      return;
    }

    setErrorMessage("");
    setLoading(true);
    try {
      await axios.patch(`/url/${props.urlId}/real-url`, { url: newUrl });
      props.onSuccess(newUrl);
      props.onClose();
      dom.message("Destination URL updated.", "success");
    } catch (e) {
      lib.handleErr(e);
    }
    setLoading(false);
  };

  return (
    <Modal
      header="Edit Destination URL"
      open={props.open}
      onClose={props.onClose}
      type="narrow"
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="">
          <Input
            value={value}
            onChange={(s: string) => setValue(s)}
            placeholder="https://example.com"
            error={errorMessage}
          />
        </div>

        <div className="u-flex-text-right u-margin-top-1">
          <Button
            type="submit"
            color="blue"
            outlined={true}
            rounded={true}
            loading={loading}
          >
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default EditRealUrl;

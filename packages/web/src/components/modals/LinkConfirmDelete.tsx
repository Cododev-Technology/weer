import React, { FC, useEffect, useState } from "react";
import axios from "axios";

import { ConfirmModal, Loading, Modal, Button, Input } from "@weer/reusable";
import { useAuth } from "../../AuthContext";
import dom from "../../lib/dom";

interface LinkConfirmDeleteProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  onDeleteUrl?: () => void;
  urlId: string | null;
  realUrl: string;
}

const LinkConfirmDelete: FC<LinkConfirmDeleteProps> = (props) => {
  const { isSignedIn, username } = useAuth();

  const [loading, setLoading] = useState<boolean>(false); // when deleting the link

  // Send the delete request to the server
  const onDeleteConfirmed = async () => {
    const urlId = props.urlId;
    setLoading(true);
    try {
      await axios.delete("/url/" + urlId);

      if (props.onSuccess) props.onSuccess();
      props.onClose();

      dom.message("URL deleted successfully.", "success");
      if (props.onDeleteUrl) props.onDeleteUrl();
    } catch (e) {
      // show an error message to user on unexpected errors
      dom.message(
        "Sorry, an unknown error occurred, please try again later.",
        "error"
      );
      props.onClose();
    }
    setLoading(false);
  };

  return (
    <ConfirmModal
      header="Delete The URL"
      open={props.open}
      loading={loading}
      onConfirm={onDeleteConfirmed}
      onCancel={() => {
        props.onClose();
      }}
      btnName="Delete"
    >
      <p>
        Are you sure that you want to delete this URL and its shortened URL? You
        cannot undo this.
        <br />
        <strong className="a-4">{props.realUrl}</strong>
      </p>
    </ConfirmModal>
  );
};

export default LinkConfirmDelete;

import React, { FC, useState } from "react";

import { Modal, Button } from "@weer/reusable";
import PasswordFields from "../forms/PasswordFields";
import { useAuth } from "../../AuthContext";
import { useModal } from "../../ModalContext";
import dom from "../../lib/dom";
import lib from "../../lib";

interface ResetPasswordProps {
  open: boolean;
  onClose: () => void;
  token?: string;
  userId?: string;
}

const ResetPassword: FC<ResetPasswordProps> = (props) => {
  const { confirmPasswordReset } = useAuth();
  const { openModal } = useModal();

  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const missingLinkInfo = !props.token || !props.userId;

  const onSubmit = async () => {
    if (!props.token || !props.userId || !newPassword) return;

    setLoading(true);
    try {
      await confirmPasswordReset(props.userId, props.token, newPassword);
      dom.message("Your password has been updated. Please log in.", "success");
      openModal("login");
    } catch (error: any) {
      lib.handleErr(error);
    }
    setLoading(false);
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      header="Choose a new password"
      type="narrow"
    >
      <div className="auth">
        {missingLinkInfo ? (
          <>
            <p className="verify-code-intro">
              This password reset link is invalid or has expired. Please request a new one.
            </p>
            <div className="auth__footer">
              <button
                className="button-text"
                onClick={() => openModal("forgotPassword")}
              >
                Request a new reset link
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <PasswordFields
              idPrefix="reset-password"
              firstFieldNoTopMargin
              onChange={setNewPassword}
            />

            <div className="form-group u-flex-text-right">
              <Button
                type="submit"
                color="blue"
                outlined={true}
                block={true}
                loading={loading}
                onClick={onSubmit}
              >
                Update Password
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
};

export default ResetPassword;

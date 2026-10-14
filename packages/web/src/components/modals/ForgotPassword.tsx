import React, { FC, useState } from "react";
import { isValidEmail } from "@weer/common";

import { Modal, Input, Button } from "@weer/reusable";
import { useAuth } from "../../AuthContext";
import { useModal } from "../../ModalContext";
import dom from "../../lib/dom";
import lib from "../../lib";

interface ForgotPasswordProps {
  open: boolean;
  onClose: () => void;
}

const ForgotPassword: FC<ForgotPasswordProps> = (props) => {
  const { requestPasswordReset } = useAuth();
  const { openModal, closeModal } = useModal();

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const validateEmail = (value: string) => {
    if (value && !isValidEmail(value)) {
      setEmailError("Please enter a valid email address.");
    } else {
      setEmailError(null);
    }
  };

  const onSubmit = async () => {
    validateEmail(email);

    if (!email || !isValidEmail(email)) return;

    setLoading(true);
    try {
      await requestPasswordReset(email);
      dom.message(
        "If that email is registered, instructions on how to reset your password have been sent to it.",
        "success"
      );
      closeModal();
    } catch (error: any) {
      lib.handleErr(error);
    }
    setLoading(false);
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      header="Reset your password"
      type="narrow"
    >
      <div className="auth">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="form-group u-margin-top-0">
            <Input
              label="Email"
              type="email"
              id="forgot-password-email"
              required
              value={email}
              onChange={(value) => {
                setEmail(value);
                validateEmail(value);
              }}
              error={emailError ?? undefined}
            />
          </div>

          <div className="form-group u-flex-text-right">
            <Button
              type="submit"
              color="blue"
              outlined={true}
              block={true}
              disabled={!email || !!emailError}
              loading={loading}
              onClick={onSubmit}
            >
              Send reset link
            </Button>
          </div>
        </form>

        <div className="auth__footer">
          <button className="button-text" onClick={() => openModal("login")}>
            <i className="fa-solid fa-arrow-left"></i> Back to Log In
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ForgotPassword;

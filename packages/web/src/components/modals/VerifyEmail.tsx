import React, { FC, useRef, useState } from "react";

import { Modal, Button } from "@weer/reusable";
import VerifyCodeInput, {
  VerifyCodeInputHandle,
} from "../forms/VerifyCodeInput";
import { useAuth } from "../../AuthContext";
import { useModal } from "../../ModalContext";
import dom from "../../lib/dom";
import lib from "../../lib";

interface VerifyEmailProps {
  open: boolean;
  onClose: () => void;
  name?: string;
  email?: string;
  password?: string;
  username?: string;
}

const VerifyEmail: FC<VerifyEmailProps> = (props) => {
  const { register, sendCode, refreshAuth } = useAuth();
  const { openModal, closeModal } = useModal();

  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const codeInputRef = useRef<VerifyCodeInputHandle>(null);

  const onComplete = async (code: string) => {
    if (!props.name || !props.email || !props.password) return;

    setLoading(true);
    try {
      await register(props.name, props.email, props.password, code, props.username);
      await refreshAuth();
      dom.message("Your account is ready.", "success");
      closeModal();
    } catch (error: any) {
      lib.handleErr(error);
      codeInputRef.current?.reset();
    }
    setLoading(false);
  };

  const onResend = async () => {
    if (!props.name || !props.email || !props.password) return;

    setResending(true);
    try {
      await sendCode(props.name, props.email, props.password, props.username);
      dom.message("A new code has been sent.", "success");
    } catch (error: any) {
      lib.handleErr(error);
    }
    setResending(false);
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      header="Verify your email"
      type="narrow"
    >
      <div className="auth">
        <p className="verify-code-intro">
          Please enter the code we sent to {props.email} below:
        </p>

        <VerifyCodeInput ref={codeInputRef} loading={loading} onComplete={onComplete} />

        <div className="verify-code-actions">
          <Button color="blue" outlined={true} size="small" loading={resending} onClick={onResend}>
            <i className="fa-solid fa-arrow-rotate-right button__icon-left"></i>
            Resend Code
          </Button>

          <Button
            color="default"
            outlined={true}
            size="small"
            onClick={() =>
              openModal("signUp", {
                name: props.name,
                email: props.email,
                username: props.username,
                password: props.password,
              })
            }
          >
            <i className="fa-solid fa-arrow-left button__icon-left"></i>
            Back
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default VerifyEmail;

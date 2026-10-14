import React, { FC, useEffect, useRef, useState } from "react";
import { isValidEmail } from "@weer/common";

import { Modal, Input, Button } from "@weer/reusable";
import VerifyCodeInput, {
  VerifyCodeInputHandle,
} from "../forms/VerifyCodeInput";
import PasswordFields, { PasswordFieldsHandle } from "../forms/PasswordFields";
import { useAuth } from "../../AuthContext";
import dom from "../../lib/dom";
import lib from "../../lib";

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
}

const AccountModal: FC<AccountModalProps> = (props) => {
  const { email, requestEmailChange, confirmEmailChange, changePassword } =
    useAuth();

  const [newEmail, setNewEmail] = useState(email);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailLoading, setEmailLoading] = useState(false);
  const [resendingEmailCode, setResendingEmailCode] = useState(false);
  const codeInputRef = useRef<VerifyCodeInputHandle>(null);

  useEffect(() => {
    if (email) setNewEmail(email);
  }, [email]);

  const emailChanged = newEmail !== email && isValidEmail(newEmail);

  const validateEmail = (value: string) => {
    if (value && !isValidEmail(value)) {
      setEmailError("Please enter a valid email address.");
    } else {
      setEmailError(null);
    }
  };

  const onSendEmailCode = async () => {
    validateEmail(newEmail);
    if (!emailChanged) return;

    setEmailLoading(true);
    try {
      await requestEmailChange(newEmail);
      setEmailCodeSent(true);
    } catch (error: any) {
      lib.handleErr(error);
    }
    setEmailLoading(false);
  };

  const onConfirmEmailChange = async (code: string) => {
    setEmailLoading(true);
    try {
      await confirmEmailChange(newEmail, code);
      dom.message("Your email has been updated.", "success");
      setEmailCodeSent(false);
    } catch (error: any) {
      lib.handleErr(error);
      codeInputRef.current?.reset();
    }
    setEmailLoading(false);
  };

  const onResendEmailCode = async () => {
    setResendingEmailCode(true);
    try {
      await requestEmailChange(newEmail);
      dom.message("A new code has been sent.", "success");
      codeInputRef.current?.reset();
    } catch (error: any) {
      lib.handleErr(error);
    }
    setResendingEmailCode(false);
  };

  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const passwordFieldsRef = useRef<PasswordFieldsHandle>(null);

  const onChangePassword = async () => {
    if (!newPassword) return;

    setPasswordLoading(true);
    try {
      await changePassword(newPassword);
      dom.message("Your password has been updated.", "success");
      setNewPassword(null);
      passwordFieldsRef.current?.reset();
    } catch (error: any) {
      lib.handleErr(error);
    }
    setPasswordLoading(false);
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      header="Account"
      type="narrow"
    >
      <div className="account-modal">
        {!emailCodeSent && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSendEmailCode();
            }}
          >
            <div className="form-group u-margin-top-0">
              <Input
                label="Email"
                type="email"
                id="account-email"
                value={newEmail}
                onChange={(value) => {
                  setNewEmail(value);
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
                size="small"
                disabled={!emailChanged}
                loading={emailLoading}
              >
                Change Email
              </Button>
            </div>
          </form>
        )}

        {emailCodeSent && (
          <div className="form-group u-margin-top-0">
            <p className="verify-code-intro">
              Please enter the code we sent to {newEmail} below:
            </p>
            <VerifyCodeInput
              ref={codeInputRef}
              loading={emailLoading}
              onComplete={onConfirmEmailChange}
            />

            <div className="account-modal__code-actions">
              <Button
                color="blue"
                outlined={true}
                size="small"
                loading={resendingEmailCode}
                onClick={onResendEmailCode}
              >
                <i className="fa-solid fa-arrow-rotate-right button__icon-left"></i>
                Resend Code
              </Button>

              <Button
                color="default"
                outlined={true}
                size="small"
                onClick={() => {
                  setEmailCodeSent(false);
                  setNewEmail(email);
                  setEmailError(null);
                }}
              >
                <i className="fa-solid fa-arrow-left button__icon-left"></i>
                Back
              </Button>
            </div>
          </div>
        )}

        {!emailCodeSent && (
          <>
            <hr className="account-modal__divider" />

            <form
              onSubmit={(e) => {
                e.preventDefault();
                onChangePassword();
              }}
            >
              <PasswordFields
                ref={passwordFieldsRef}
                idPrefix="account"
                onChange={setNewPassword}
              />

              <div className="form-group u-flex-text-right">
                <Button
                  type="submit"
                  color="blue"
                  outlined={true}
                  size="small"
                  disabled={!newPassword}
                  loading={passwordLoading}
                >
                  Change Password
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </Modal>
  );
};

export default AccountModal;

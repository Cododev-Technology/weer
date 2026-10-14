import React, { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { isValidPassword } from "@weer/common";
import { Input } from "@weer/reusable";

const PASSWORD_HINT =
  "Password must be 8-30 characters and include an uppercase letter, a lowercase letter, and a number.";

interface PasswordFieldsProps {
  idPrefix: string;
  passwordLabel?: string;
  firstFieldNoTopMargin?: boolean;
  initialPassword?: string;
  onChange: (password: string | null) => void;
}

export interface PasswordFieldsHandle {
  reset: () => void;
}

const PasswordFields = forwardRef<PasswordFieldsHandle, PasswordFieldsProps>(
  ({ idPrefix, passwordLabel = "New Password", firstFieldNoTopMargin, initialPassword, onChange }, ref) => {
    const initialValid = !!initialPassword && isValidPassword(initialPassword);

    const [password, setPassword] = useState(initialPassword ?? "");
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [confirmPassword, setConfirmPassword] = useState(initialValid ? initialPassword! : "");
    const [confirmDisabled, setConfirmDisabled] = useState(!initialValid);
    const [confirmError, setConfirmError] = useState<string | null>(null);

    useEffect(() => {
      if (initialValid) onChange(initialPassword!);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      reset: () => {
        setPassword("");
        setPasswordError(null);
        setConfirmPassword("");
        setConfirmDisabled(true);
        setConfirmError(null);
      },
    }));

    const onChangePassword = (value: string) => {
      setPassword(value);
      setConfirmPassword("");
      setConfirmDisabled(true);
      setConfirmError(null);
      onChange(null);

      if (!value) {
        setPasswordError(null);
        return;
      }

      if (!isValidPassword(value)) {
        setPasswordError(PASSWORD_HINT);
      } else {
        setPasswordError(null);
        setConfirmDisabled(false);
      }
    };

    const onChangeConfirmPassword = (value: string) => {
      setConfirmPassword(value);

      if (value && value === password) {
        setConfirmError(null);
        onChange(password);
      } else {
        onChange(null);
        setConfirmError(value ? "Passwords do not match." : null);
      }
    };

    return (
      <>
        <div className={`form-group${firstFieldNoTopMargin ? " u-margin-top-0" : ""}`}>
          <Input
            label={passwordLabel}
            type="password"
            id={`${idPrefix}-password`}
            required
            value={password}
            onChange={onChangePassword}
            error={passwordError ?? undefined}
          />
        </div>

        <div className="form-group">
          <Input
            label="Confirm Password"
            type="password"
            id={`${idPrefix}-confirm-password`}
            required
            disabled={confirmDisabled}
            value={confirmPassword}
            onChange={onChangeConfirmPassword}
            error={confirmError ?? undefined}
          />
        </div>
      </>
    );
  }
);

export default PasswordFields;

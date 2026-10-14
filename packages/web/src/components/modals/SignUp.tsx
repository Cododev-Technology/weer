import React, { FC, useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  isValidName,
  isValidEmail,
  isValidUsername,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
} from "@weer/common";

import { Modal, Input, Button } from "@weer/reusable";
import PasswordFields from "../forms/PasswordFields";
import { useAuth } from "../../AuthContext";
import { useModal } from "../../ModalContext";
import lib from "../../lib";

interface SignUpProps {
  open: boolean;
  onClose: () => void;
  initialName?: string;
  initialEmail?: string;
  initialUsername?: string;
  initialPassword?: string;
}

const SignUp: FC<SignUpProps> = (props) => {
  const { sendCode } = useAuth();
  const { openModal } = useModal();

  const [name, setName] = useState(props.initialName ?? "");
  const [nameError, setNameError] = useState<string | null>(null);

  const [email, setEmail] = useState(props.initialEmail ?? "");
  const [emailError, setEmailError] = useState<string | null>(null);

  const [username, setUsername] = useState(props.initialUsername ?? "");
  const [usernameLoading, setUsernameLoading] = useState(false);
  const [usernameSuccess, setUsernameSuccess] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  const [password, setPassword] = useState<string | null>(
    props.initialPassword ?? null
  );

  const [loading, setLoading] = useState(false);

  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (props.initialUsername) checkUsernameAvailability(props.initialUsername);
    return () => {
      if (usernameTimer.current) clearTimeout(usernameTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validateName = (value: string) => {
    if (value && !isValidName(value)) {
      setNameError(
        "Name must be 3-30 characters and only contain letters and spaces."
      );
    } else {
      setNameError(null);
    }
  };

  const validateEmail = (value: string) => {
    if (value && !isValidEmail(value)) {
      setEmailError("Please enter a valid email address.");
    } else {
      setEmailError(null);
    }
  };

  const validateUsername = (value: string): boolean => {
    if (value && !isValidUsername(value)) {
      setUsernameError(
        `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters and contain only letters, numbers, hyphens, and underscores.`
      );
      return false;
    }
    return true;
  };

  const checkUsernameAvailability = async (value: string) => {
    if (!value) {
      setUsernameSuccess(null);
      setUsernameError(null);
      return;
    }

    setUsernameLoading(true);
    setUsernameError(null);
    setUsernameSuccess(null);

    try {
      const { data } = await axios.get(`/user/username-availability/${value}`);

      if (data.available) {
        setUsernameSuccess(`${value} is available.`);
      } else {
        setUsernameError(`${value} is not available.`);
      }
    } catch (error) {
      setUsernameError(`Failed to check availability`);
    } finally {
      setUsernameLoading(false);
    }
  };

  const onSubmit = async () => {
    validateName(name);
    validateEmail(email);

    if (
      !isValidName(name) ||
      !isValidEmail(email) ||
      !password ||
      usernameError ||
      (username && !usernameSuccess)
    ) {
      return;
    }

    setLoading(true);
    try {
      await sendCode(name, email, password, username || undefined);
      openModal("verifyEmail", {
        name,
        email,
        password,
        username: username || undefined,
      });
    } catch (error: any) {
      lib.handleErr(error);
    }
    setLoading(false);
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      header="Create your Weer account"
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
              label="Name"
              type="text"
              id="signup-name"
              required
              value={name}
              onChange={setName}
              onBlur={validateName}
              error={nameError ?? undefined}
            />
          </div>

          <div className="form-group">
            <Input
              label="Email"
              type="email"
              id="signup-email"
              required
              value={email}
              onChange={(value) => {
                setEmail(value);
                validateEmail(value);
              }}
              error={emailError ?? undefined}
            />
          </div>

          <div className="form-group">
            <Input
              label="Username (optional)"
              type="text"
              id="signup-username"
              value={username}
              onChange={(value) => {
                setUsername(value);
                setUsernameSuccess(null);

                if (!validateUsername(value)) return;
                setUsernameError(null);

                if (usernameTimer.current) clearTimeout(usernameTimer.current);

                usernameTimer.current = setTimeout(() => {
                  checkUsernameAvailability(value);
                }, 800);
              }}
              loading={usernameLoading}
              loadingText="Checking availability"
              success={usernameSuccess ?? undefined}
              error={usernameError ?? undefined}
            />
          </div>

          <PasswordFields
            idPrefix="signup"
            onChange={setPassword}
            initialPassword={props.initialPassword}
          />

          <div className="form-group u-flex-text-right">
            <Button
              type="submit"
              color="blue"
              outlined={true}
              block={true}
              disabled={!password || (!!username && !usernameSuccess)}
              loading={loading}
            >
              Create Account
            </Button>
          </div>
        </form>

        <div className="auth-or">or</div>
        <div className="u-flex-text-center u-margin-top-2">
          <a
            className="button button-block button-with-icon button-google-signin"
            href="/auth/google"
          >
            <i className="button__icon-left fa-brands fa-google"></i>
            Continue with Google
          </a>
        </div>

        <div className="auth__footer">
          <div className="auth__other">
            Already have an account?{" "}
            <button className="button-text" onClick={() => openModal("login")}>
              Log in
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default SignUp;

import React, { FC, useState } from "react";

import { Modal, Input, Button } from "@weer/reusable";
import { useAuth } from "../../AuthContext";
import { useModal } from "../../ModalContext";
import lib from "../../lib";

interface LoginProps {
  open: boolean;
  onClose: () => void;
  prefillEmail?: string;
}

const Login: FC<LoginProps> = (props) => {
  const { logIn, refreshAuth } = useAuth();
  const { openModal, closeModal } = useModal();

  const [email, setEmail] = useState(props.prefillEmail || "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (!email || !password) return;

    setLoading(true);
    try {
      await logIn(email, password);
      await refreshAuth();
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
      header="Log in to Weer"
      type="narrow"
    >
      <div className="auth">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="form-group">
            <Input
              label="Email"
              type="email"
              id="email"
              required
              value={email}
              onChange={setEmail}
            />
          </div>

          <div className="form-group">
            <Input
              label="Password"
              type="password"
              id="password"
              required
              value={password}
              onChange={setPassword}
            />
          </div>

          <div className="form-group u-flex-text-right">
            <Button
              type="submit"
              color="blue"
              outlined={true}
              block={true}
              loading={loading}
              onClick={onSubmit}
            >
              Log In
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
          <button
            className="button-text"
            onClick={() => openModal("forgotPassword")}
          >
            Forgot your password?
          </button>

          <div className="auth__other">
            New to Weer?{" "}
            <button className="button-text" onClick={() => openModal("signUp")}>
              Create an account
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default Login;

import React, { FC, useRef } from "react";
import axios from "axios";

import { Modal, Input, Button } from "@weer/reusable";
import { useAuth } from "../../AuthContext";
import { useModal } from "../../ModalContext";
import dom from "../../lib/dom";
import lib from "../../lib";

interface UsernameProps {
  open: boolean;
  onClose: () => void;
}

const Username: FC<UsernameProps> = (props) => {
  const {
    isSignedIn,
    username,
    updateUsername,
    inactiveUsernames,
    refreshAuth,
  } = useAuth();

  const { openModal, closeModal } = useModal();

  const [usernameInput, setUsernameInput] = React.useState(username || "");
  const [inputLoading, setInputLoading] = React.useState(false);
  const [inputSuccess, setInputSuccess] = React.useState<string | null>(null);
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [usernameInactiveWarning, setUsernameInactiveWarning] =
    React.useState(false);

  const [usernameUpdateLoading, setUsernameUpdateLoading] =
    React.useState(false);
  const [oldestInactiveUsername, setOldestInactiveUsername] = React.useState<
    string | null
  >(null);

  const [switchUsernameLoading, setSwitchUsernameLoading] = React.useState<
    string | null
  >(null);

  // We want to delay sending a request to server to check username availability by 800ms
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When the username from auth context changes, update the input field
  React.useEffect(() => {
    if (username) {
      setUsernameInput(username);
    }
  }, [username]);

  // Cleanup timer on unmount
  React.useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, []);

  // Sends a request to server to check if the username is available
  const checkUsernameAvailability = async (value: string) => {
    if (!value || value === username) {
      setInputSuccess(null);
      setInputError(null);
      return;
    }

    setInputLoading(true);
    setInputError(null);
    setInputSuccess(null);

    try {
      const { data } = await axios.get(`/user/username-availability/${value}`);

      if (data.available) {
        setInputSuccess(`${value} is available.`);
      } else {
        setInputError(`${value} is already taken.`);
      }
    } catch (error) {
      setInputError("Failed to check availability.");
    } finally {
      setInputLoading(false);
    }
  };

  // When user clicks on update username button
  const onUpdateUsername = async () => {
    if (!usernameInput || usernameInput === username) return;

    // If the user already has 3 inactive usernames, warn the user before proceeding
    if (inactiveUsernames.length >= 3) {
      // Based on the sorting done on postgres query, the first record is the oldest
      setOldestInactiveUsername(inactiveUsernames[0].username);
      setUsernameInactiveWarning(true);
    } else {
      await proceedUsernameUpdate();
    }
  };

  // Sends a request to server to update the username
  const proceedUsernameUpdate = async () => {
    setUsernameUpdateLoading(true);
    try {
      await updateUsername(usernameInput);

      await refreshAuth();
      dom.message(`Your username is now ${usernameInput}.`, "success");
      closeModal();
    } catch (error: any) {
      lib.handleErr(error);
    }

    setUsernameUpdateLoading(false);
    setUsernameInactiveWarning(false);
  };

  // When user clicks on switch button for an inactive username
  const onUsernameSwitch = async (uname: string) => {
    setSwitchUsernameLoading(uname);

    try {
      await axios.patch("/user/username/switch", {
        username: uname,
      });

      await refreshAuth();

      // reset
      setUsernameInput(uname);
      setInputError(null);
      setInputSuccess(null);

      dom.message(`Your active username is now ${uname}.`, "success");
    } catch (error: any) {
      lib.handleErr(error);
    }

    setSwitchUsernameLoading(null);
  };

  const renderInactiveUsernames = () => {
    if (inactiveUsernames.length === 0) return null;

    return (
      <div className="username-inactive-list">
        <div className="username-inactive-list__header">
          Your Old Usernames
          <div className="tooltip tooltip-top">
            <i className="fa-regular fa-circle-question"></i>
            <div className="tooltip__text">
              We keep a record of up to 3 of your last usernames for a limited
              time. Your custom links on your username will continue to work
              with all these while they are active, and also they cannot be
              taken by other users until they expire.
              <br />
              You can switch back to any of these before they expire and reset
              the timer.
            </div>
          </div>
        </div>
        <ul className="username-inactive-list__list">
          {inactiveUsernames.map((uname) => (
            <li key={uname.username} className="username-inactive-list__item">
              <span className="username-inactive-list__name">
                {uname.username}
              </span>
              <span className="username-inactive-list__expires">
                Expires in {lib.formatDuration(uname.expiresAt)}
              </span>
              <Button
                color="red"
                outlined={true}
                loading={switchUsernameLoading === uname.username}
                size="small"
                onClick={() => {
                  onUsernameSwitch(uname.username);
                }}
              >
                Switch
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      header={username ? "Your Username" : "Choose a Username"}
      type="narrow"
    >
      <div className="">
        {usernameInactiveWarning && (
          <div className="username-warning">
            Warning! You already have 3 inactive usernames. Proceeding will
            delete the oldest inactive username which is{" "}
            <strong>{oldestInactiveUsername}</strong>. After proceeding, your
            links like <strong>weer.pro/{oldestInactiveUsername}/...</strong>{" "}
            will stop working, and the username will be available for others to
            take immediately. <br />
            Are you sure you want to continue?
            <div className="username-warning__actions">
              <Button
                color="blue"
                outlined={true}
                size="small"
                block={true}
                onClick={() => {
                  setUsernameInactiveWarning(false);
                }}
              >
                Cancel
              </Button>
              <Button
                color="red"
                size="small"
                block={true}
                loading={usernameUpdateLoading}
                onClick={async () => {
                  await proceedUsernameUpdate();
                }}
              >
                Proceed
              </Button>
            </div>
          </div>
        )}

        {!usernameInactiveWarning && (
          <form action="">
            <div className="form-group">
              <Input
                success={inputSuccess ?? undefined}
                error={inputError ?? undefined}
                onChange={(value) => {
                  setUsernameInput(value);

                  if (timer.current) clearTimeout(timer.current);

                  timer.current = setTimeout(() => {
                    checkUsernameAvailability(value);
                  }, 800);
                }}
                loading={inputLoading}
                loadingText="Checking availability"
                label="Username"
                type="text"
                id="affix-name"
                required
                value={usernameInput}
              />
            </div>

            <div className="form-group u-flex-text-right">
              <Button
                type="submit"
                color="blue"
                outlined={true}
                loading={usernameUpdateLoading}
                disabled={
                  inputSuccess && inputSuccess.length > 0 ? false : true
                }
                block={true}
                onClick={onUpdateUsername}
              >
                {username ? "Update" : "Confirm"}
              </Button>
            </div>
          </form>
        )}

        {renderInactiveUsernames()}
      </div>
    </Modal>
  );
};

export default Username;

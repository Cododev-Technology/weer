/**
 * To see the implementation of the modal props, see where the modal is opened e.g. openModal("customizeLink", { onChangeType: ..., ... })
 */

import React from "react";

import LinkCustomizationModal from "./LinkCustomization";
import LinkConfirmDeleteModal from "./LinkConfirmDelete";
import LoginModal from "./Login";
import QRCodeModal from "./QRCode";
import Username from "./Username";
import EditRealUrlModal from "./EditRealUrl";
import LinkStatsModal from "./LinkStats";
import AccountModal from "./AccountModal";
import CreditsModal from "./CreditsModal";
import SignUpModal from "./SignUp";
import VerifyEmailModal from "./VerifyEmail";
import ForgotPasswordModal from "./ForgotPassword";
import ResetPasswordModal from "./ResetPassword";

interface GlobalModalRendererProps {
  modal: { type: string | null; props?: Record<string, any> };
  closeModal: () => void;
}

export const GlobalModalRenderer = ({
  modal,
  closeModal,
}: GlobalModalRendererProps) => {
  if (!modal.type) return null;

  switch (modal.type) {
    case "confirmDelete":
      return (
        <LinkConfirmDeleteModal
          open
          onClose={closeModal}
          urlId={modal.props?.urlId}
          realUrl={modal.props?.realUrl}
          onSuccess={modal.props?.onSuccess}
        />
      );

    case "login":
      return <LoginModal open onClose={closeModal} prefillEmail={modal.props?.email} />;

    case "signUp":
      return (
        <SignUpModal
          open
          onClose={closeModal}
          initialName={modal.props?.name}
          initialEmail={modal.props?.email}
          initialUsername={modal.props?.username}
          initialPassword={modal.props?.password}
        />
      );

    case "verifyEmail":
      return (
        <VerifyEmailModal
          open
          onClose={closeModal}
          name={modal.props?.name}
          email={modal.props?.email}
          password={modal.props?.password}
          username={modal.props?.username}
        />
      );

    case "forgotPassword":
      return <ForgotPasswordModal open onClose={closeModal} />;

    case "resetPassword":
      return (
        <ResetPasswordModal
          open
          onClose={closeModal}
          token={modal.props?.token}
          userId={modal.props?.userId}
        />
      );

    case "username":
      return <Username open onClose={closeModal} />;

    case "account":
      return <AccountModal open onClose={closeModal} />;

    case "credits":
      return <CreditsModal open onClose={closeModal} />;

    case "customizeLink":
      return (
        <LinkCustomizationModal
          open
          onClose={closeModal}
          urlId={modal.props?.urlId}
          url={modal.props?.realUrl}
          shortenedUrl={modal.props?.shortenedUrl}
          shortenedUrlCode={modal.props?.shortenedUrlCode}
          expired={modal.props?.expired}
          onChangeType={modal.props?.onChangeType}
          type={modal.props?.type}
        />
      );

    case "qrCode":
      return (
        <QRCodeModal open onClose={closeModal} urlId={modal.props?.urlId} />
      );

    case "editRealUrl":
      return (
        <EditRealUrlModal
          open
          onClose={closeModal}
          urlId={modal.props?.urlId}
          realUrl={modal.props?.realUrl}
          onSuccess={modal.props?.onSuccess}
        />
      );

    case "linkStats":
      return (
        <LinkStatsModal
          open
          onClose={closeModal}
          urlId={modal.props?.urlId}
        />
      );

    default:
      return null;
  }
};

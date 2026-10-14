export namespace User {
  export interface SendEmailChangeCodeBody {
    newEmail: string;
  }

  export interface ConfirmEmailChangeBody {
    newEmail: string;
    code: string;
  }

  export interface ChangePasswordBody {
    newPassword: string;
  }
}

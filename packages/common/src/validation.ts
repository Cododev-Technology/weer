export function isValidName(name: string): boolean {
  return typeof name === "string" && /^[A-Za-z ]{3,30}$/.test(name);
}

export function isValidEmail(email: string): boolean {
  return (
    typeof email === "string" &&
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(
      email
    )
  );
}

export function isValidPassword(password: string): boolean {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 30 &&
    /[0-9]/.test(password) &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password)
  );
}

export const CODE_CHARSET_REGEX = /^[a-zA-Z0-9_-]+$/;
export const INVALID_CODE_CHARS_REGEX = /[^a-zA-Z0-9_-]/g;

export const CUSTOM_CODE_MIN_LENGTH = 7;
export const AFFIX_CODE_MIN_LENGTH = 1;
export const CODE_MAX_LENGTH = 80;

export function stripInvalidCodeChars(value: string): string {
  return value.replace(INVALID_CODE_CHARS_REGEX, "");
}

export function isValidCustomCode(code: string): boolean {
  return (
    typeof code === "string" &&
    code.length >= CUSTOM_CODE_MIN_LENGTH &&
    code.length <= CODE_MAX_LENGTH &&
    CODE_CHARSET_REGEX.test(code)
  );
}

export function isValidAffixCode(code: string): boolean {
  return (
    typeof code === "string" &&
    code.length >= AFFIX_CODE_MIN_LENGTH &&
    code.length <= CODE_MAX_LENGTH &&
    CODE_CHARSET_REGEX.test(code)
  );
}

export const USERNAME_MIN_LENGTH = 1;
export const USERNAME_MAX_LENGTH = 30;

export function isValidUsername(username: string): boolean {
  return (
    typeof username === "string" &&
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    CODE_CHARSET_REGEX.test(username)
  );
}

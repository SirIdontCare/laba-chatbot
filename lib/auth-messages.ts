export const MIN_PASSWORD_LENGTH = 8;

export const AUTH_MESSAGES = {
  configuration: "Logowanie jest wyłączone. Ustaw NEXT_PUBLIC_SUPABASE_URL oraz NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY w konfiguracji serwera.",
  unauthorized: "Sesja wygasła lub nie jesteś zalogowany. Zaloguj się ponownie.",
  origin: "Niedozwolone źródło żądania. Odśwież stronę i spróbuj ponownie.",
  network: "Nie udało się połączyć z serwerem. Spróbuj ponownie.",
  invalidCredentials: "Nieprawidłowy e-mail lub hasło.",
  accountExists: "Konto z tym adresem e-mail już istnieje. Zaloguj się.",
  passwordTooShort: `Hasło jest za krótkie. Użyj co najmniej ${MIN_PASSWORD_LENGTH} znaków.`,
  weakPassword: `Hasło jest za słabe. Użyj co najmniej ${MIN_PASSWORD_LENGTH} znaków i nie wybieraj popularnych haseł.`,
  invalidEmail: "Podaj poprawny adres e-mail.",
  checkInput: "Sprawdź adres e-mail i hasło.",
  emailNotConfirmed: "Najpierw potwierdź adres e-mail. Kliknij link z wiadomości, którą wysłaliśmy.",
  confirmEmail: "Konto założone. Sprawdź skrzynkę, kliknij link potwierdzający i zaloguj się.",
  confirmFailed: "Link potwierdzający jest nieprawidłowy albo wygasł. Zaloguj się lub załóż konto ponownie.",
  rateLimited: "Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.",
  signupDisabled: "Zakładanie nowych kont jest wyłączone.",
  logoutFailed: "Nie udało się wylogować. Spróbuj ponownie.",
  unknown: "Nie udało się. Spróbuj ponownie.",
} as const;

type AuthErrorLike = { code?: string; status?: number; name?: string; message?: string } | null | undefined;

// Zamienia błąd Supabase Auth na komunikat po polsku.
export function authErrorMessage(error: AuthErrorLike) {
  switch (error?.code) {
    case "invalid_credentials": return AUTH_MESSAGES.invalidCredentials;
    case "user_already_exists":
    case "email_exists": return AUTH_MESSAGES.accountExists;
    case "weak_password": return AUTH_MESSAGES.weakPassword;
    case "email_address_invalid": return AUTH_MESSAGES.invalidEmail;
    case "validation_failed": return AUTH_MESSAGES.checkInput;
    case "email_not_confirmed": return AUTH_MESSAGES.emailNotConfirmed;
    case "over_request_rate_limit":
    case "over_email_send_rate_limit": return AUTH_MESSAGES.rateLimited;
    case "signup_disabled":
    case "email_provider_disabled": return AUTH_MESSAGES.signupDisabled;
  }
  // Starsze serwery Auth nie zawsze podają kod błędu.
  const message = error?.message ?? "";
  if (/invalid login credentials/i.test(message)) return AUTH_MESSAGES.invalidCredentials;
  if (/already (been )?registered|already exists/i.test(message)) return AUTH_MESSAGES.accountExists;
  if (error?.name === "AuthRetryableFetchError" || error?.status === 0) return AUTH_MESSAGES.network;
  return AUTH_MESSAGES.unknown;
}

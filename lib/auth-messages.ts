export const AUTH_MESSAGES = {
  configuration: "Dostęp zablokowany. Ustaw CHAT_PASSWORD oraz SESSION_SECRET (co najmniej 32 znaki) w konfiguracji serwera.",
  unauthorized: "Sesja wygasła lub nie jesteś zalogowany. Wpisz hasło ponownie.",
  invalid: "Nieprawidłowe hasło.",
  limited: "Zbyt wiele prób. Odczekaj minutę i spróbuj ponownie.",
  limiter: "Logowanie zablokowane: ochrona przed zgadywaniem hasła na hostingu nie jest skonfigurowana lub jest niedostępna.",
  origin: "Niedozwolone źródło żądania. Odśwież stronę i spróbuj ponownie.",
  network: "Nie udało się połączyć z serwerem. Spróbuj ponownie.",
} as const;

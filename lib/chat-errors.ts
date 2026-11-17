export const CHAT_ERRORS = {
  configuration:
    "Brak konfiguracji czatu. Uzupełnij OPENROUTER_API_KEY i OPENROUTER_MODEL w pliku .env.local, a następnie uruchom ponownie serwer.",
  invalid: "Nieprawidłowa rozmowa. Wyślij niepustą wiadomość tekstową.",
  unavailable:
    "Nie udało się uzyskać odpowiedzi AI. Sprawdź połączenie, klucz, identyfikator modelu i dostępne środki w OpenRouter, a następnie spróbuj ponownie.",
  visionUnavailable: "Nie udało się przeanalizować zdjęcia. Model może być niedostępny lub nie obsługiwać obrazów. Spróbuj ponownie albo sprawdź model czatu w OpenRouter.",
} as const;

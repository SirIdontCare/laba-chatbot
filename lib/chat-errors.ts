export const CHAT_ERRORS = {
  history: "Nie udało się wczytać historii rozmowy. Odśwież stronę, aby spróbować ponownie.",
  save: "Nie udało się potwierdzić zapisu odpowiedzi w historii.",
  configuration:
    "Brak konfiguracji czatu. Uzupełnij OPENROUTER_API_KEY i OPENROUTER_MODEL w pliku .env.local, a następnie uruchom ponownie serwer.",
  invalid: "Nieprawidłowa rozmowa. Wyślij niepustą wiadomość tekstową.",
  unavailable:
    "Nie udało się uzyskać odpowiedzi AI. Sprawdź połączenie, klucz, identyfikator modelu i dostępne środki w OpenRouter, a następnie spróbuj ponownie.",
  visionUnavailable: "Nie udało się przeanalizować zdjęcia. Model może być niedostępny lub nie obsługiwać obrazów. Spróbuj ponownie albo sprawdź model czatu w OpenRouter.",
} as const;

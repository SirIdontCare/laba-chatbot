export const ANALYSIS_ERRORS = {
  configuration: "Brak konfiguracji analizy. Uzupełnij OPENROUTER_API_KEY i OPENROUTER_MODEL na serwerze i uruchom go ponownie.",
  input: "Wpisz wiadomość klienta (od 1 do 12 000 znaków).",
  unsupported: "Ustawiony OPENROUTER_MODEL lub dostępny dostawca nie obsługuje wymaganego structured output (JSON Schema). Sprawdź obsługę structured_outputs i response_format w OpenRouter oraz ograniczenia dostawców na koncie. Jeśli model ich nie obsługuje, po uzgodnieniu kosztów ustaw zgodny OPENROUTER_MODEL na serwerze i uruchom go ponownie. Model nie został automatycznie zmieniony.",
  capability: "Nie udało się sprawdzić obsługi structured output w OpenRouter. Analiza nie została uruchomiona. Sprawdź połączenie i spróbuj ponownie.",
  invalid_output: "Odpowiedź modelu nie spełnia schematu analizy. Nie utworzono wyniku. Spróbuj ponownie lub przekaż wiadomość pracownikowi.",
  refused: "Model odmówił analizy lub dostawca zablokował odpowiedź. Nie utworzono wyniku. Przekaż wiadomość pracownikowi.",
  interrupted: "Analiza została przerwana lub odpowiedź nie została ukończona. Nie utworzono wyniku. Możesz spróbować ponownie.",
  provider: "Błąd dostawcy AI. Nie utworzono wyniku. Sprawdź połączenie, konfigurację OpenRouter, limity i dostępne środki, a następnie spróbuj ponownie.",
} as const;

export type AnalysisErrorCode = keyof typeof ANALYSIS_ERRORS;

export function isAnalysisErrorCode(value: unknown): value is AnalysisErrorCode {
  return typeof value === "string" && Object.hasOwn(ANALYSIS_ERRORS, value);
}

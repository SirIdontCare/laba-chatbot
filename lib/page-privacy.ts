// Natychmiast chowa treść strony (CSS: html[data-signed-out]). Używane przy wylogowaniu
// i przy powrocie „Wstecz” z pamięci przeglądarki, zanim serwer ponownie sprawdzi sesję.
export function hidePageContent() {
  document.documentElement.dataset.signedOut = "true";
}

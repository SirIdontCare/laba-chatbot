export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const IMAGE_MESSAGES = {
  invalidPhoto: "Dodaj zdjęcie JPG, PNG lub WebP o rozmiarze do 4 MB.",
  readPhoto: "Nie udało się odczytać zdjęcia. Wybierz je ponownie.",
  invalidPrompt: "Wpisz opis obrazu: od 1 do 500 znaków.",
  unavailable: "Model obrazów jest teraz niedostępny lub nie mógł wygenerować obrazu. Spróbuj ponownie za chwilę.",
  configuration: "Generowanie obrazów nie jest skonfigurowane. Brakuje klucza OpenRouter.",
} as const;

export function isPhotoType(value: string) {
  return PHOTO_TYPES.some((type) => type === value);
}

export function photoSelectionError(file: Pick<File, "type" | "size">) {
  return !isPhotoType(file.type) || file.size <= 0 || file.size > MAX_PHOTO_BYTES
    ? IMAGE_MESSAGES.invalidPhoto : undefined;
}
